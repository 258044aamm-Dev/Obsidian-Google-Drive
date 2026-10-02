/**
 * "Compare the whole vault with Google Drive" (3.14.0). Read-only: GET requests and local reads only.
 *
 * Stage 1 (quick, nothing is downloaded): one listing of Drive gives each file's size, MD5 checksum and
 * modified time. A size that is not the local size is a difference. Without encryption an equal MD5 is the
 * same file; with encryption Drive holds only encrypted bytes, so an equal size cannot be decided here.
 * Stage 2 (exact, on request): the files still undecided are downloaded (and decrypted) and compared byte
 * for byte.
 */
import type ObsidianGoogleDrive from '../main';
import { folderMimeType, unSplitPath } from './drive';
import { OVERHEAD_BYTES } from './crypto';
import { sameBytes } from './conflict-copy';
import { isOwnPluginPath } from './own-plugin';
import { isSyncedPath } from './ignore';
import { md5Hex } from './md5';
import { refreshAccessToken } from './requests';

export type Verdict = 'same' | 'differs' | 'only-here' | 'only-drive' | 'unknown' | 'failed';

export interface LocalFact {
	path: string;
	size: number;
	mtime: number;
}

export interface DriveFact {
	path: string;
	id: string;
	size?: number;
	md5?: string;
	/** ISO time */
	modifiedTime?: string;
	/** more than one file on Drive has this path */
	copies?: number;
}

export interface Row {
	path: string;
	verdict: Verdict;
	id?: string;
	localSize?: number;
	driveSize?: number;
	localMtime?: number;
	driveMtime?: number;
	/** the operation waiting in this device's pending list, if any */
	pending?: string;
	/** why a file is undecided or failed */
	reason?: string;
}

export interface QuickInput {
	local: LocalFact[];
	drive: DriveFact[];
	encrypted: boolean;
	readLocal: (path: string) => Promise<ArrayBuffer>;
	pending?: Record<string, string>;
}

const time = (iso?: string) => {
	const ms = iso ? Date.parse(iso) : NaN;
	return Number.isFinite(ms) ? ms : undefined;
};

/** Stage 1: sorts every path into same / differs / only here / only on Drive / undecided. Never throws for one file. */
export const quickCompare = async (input: QuickInput): Promise<Row[]> => {
	const locals = new Map(input.local.map((f) => [f.path, f]));
	const drives = new Map<string, DriveFact>();
	for (const f of input.drive) {
		const seen = drives.get(f.path);
		drives.set(f.path, seen ? { ...seen, copies: (seen.copies ?? 1) + 1 } : { ...f, copies: 1 });
	}
	const rows: Row[] = [];
	const paths = [...new Set([...locals.keys(), ...drives.keys()])].sort((a, b) => a.localeCompare(b));
	for (const path of paths) {
		const here = locals.get(path);
		const there = drives.get(path);
		const row: Row = {
			path,
			verdict: 'unknown',
			pending: input.pending?.[path],
			localSize: here?.size,
			localMtime: here?.mtime,
			driveSize: there?.size,
			driveMtime: time(there?.modifiedTime),
			id: there?.id,
		};
		if (!there) row.verdict = 'only-here';
		else if (!here) row.verdict = 'only-drive';
		else if ((there.copies ?? 1) > 1) row.reason = 'two files on Drive have this path';
		else if (there.size === undefined) row.reason = 'Drive did not report a size';
		else if (there.size !== here.size + (input.encrypted ? OVERHEAD_BYTES : 0)) row.verdict = 'differs';
		else if (input.encrypted) row.reason = 'encrypted: only a download can tell';
		else if (!there.md5) row.reason = 'Drive did not report a checksum';
		else {
			try {
				row.verdict = md5Hex(await input.readLocal(path)) === there.md5.toLowerCase() ? 'same' : 'differs';
			} catch {
				row.reason = 'this file could not be read here';
			}
		}
		if (row.verdict !== 'unknown') delete row.reason;
		rows.push(row);
	}
	return rows;
};

export interface ExactDeps {
	readLocal: (path: string) => Promise<ArrayBuffer>;
	/** the decrypted content on Drive, or undefined when the download failed */
	download: (row: Row) => Promise<ArrayBuffer | undefined>;
	concurrency?: number;
	onProgress?: (done: number, total: number) => void;
	/** checked before each file; true stops the check (the rest stay undecided) */
	stopped?: () => boolean;
}

/** Stage 2: decides the undecided rows by downloading them. Changes the rows in place. */
export const exactCompare = async (rows: Row[], deps: ExactDeps): Promise<void> => {
	const todo = rows.filter((r) => r.verdict === 'unknown' && r.id && r.localSize !== undefined);
	let next = 0;
	let done = 0;
	const worker = async () => {
		while (next < todo.length) {
			if (deps.stopped?.()) return;
			const row = todo[next++]!;
			try {
				const remote = await deps.download(row);
				if (!remote) {
					row.verdict = 'failed';
					row.reason = 'the download failed';
				} else {
					row.verdict = sameBytes(await deps.readLocal(row.path), remote) ? 'same' : 'differs';
					delete row.reason;
				}
			} catch (error) {
				row.verdict = 'failed';
				row.reason = error instanceof Error ? error.message : 'unknown error';
			}
			deps.onProgress?.(++done, todo.length);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, deps.concurrency ?? 3) }, worker));
};

export const countRows = (rows: Row[]) => {
	const counts: Record<Verdict, number> = { same: 0, differs: 0, 'only-here': 0, 'only-drive': 0, unknown: 0, failed: 0 };
	for (const r of rows) counts[r.verdict]++;
	return counts;
};

/** Bytes of the Drive copies that an exact check would download. */
export const exactCheckBytes = (rows: Row[]) =>
	rows.filter((r) => r.verdict === 'unknown' && r.id).reduce((sum, r) => sum + (r.driveSize ?? 0), 0);

const iso = (ms?: number) => (ms === undefined ? 'unknown time' : new Date(ms).toISOString());

export const prettyBytes = (n: number) =>
	n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;

const newerSide = (r: Row) =>
	r.localMtime === undefined || r.driveMtime === undefined
		? 'unknown'
		: r.driveMtime > r.localMtime
			? 'Google Drive'
			: 'this device';

const section = (title: string, rows: Row[], line: (r: Row) => string, limit: number) => {
	if (!rows.length) return [];
	const out = ['', `${title} (${rows.length})`];
	for (const r of rows.slice(0, limit)) out.push(`  ${line(r)}`);
	if (rows.length > limit) out.push(`  ... and ${rows.length - limit} more (Copy report has all of them)`);
	return out;
};

export interface ReportOptions {
	encrypted?: boolean;
	/** most lines per list; the copied report has no limit */
	limit?: number;
}

/** The text of the result: totals first, then the files of each kind. */
export const renderVaultReport = (rows: Row[], options: ReportOptions = {}): string => {
	const limit = options.limit ?? Infinity;
	const c = countRows(rows);
	const lines = [
		c.differs + c['only-here'] + c['only-drive'] + c.unknown + c.failed === 0
			? `Result: IDENTICAL. All ${c.same} file${c.same === 1 ? '' : 's'} on this device and on Google Drive are the same.`
			: 'Result: NOT identical or not fully checked yet.',
		`Identical: ${c.same}`,
		`Different: ${c.differs}`,
		`Only on this device: ${c['only-here']}`,
		`Only on Google Drive: ${c['only-drive']}`,
		`Not decided yet: ${c.unknown}`,
		...(c.failed ? [`Could not be checked: ${c.failed}`] : []),
	];
	lines.push(
		...section(
			'DIFFERENT',
			rows.filter((r) => r.verdict === 'differs'),
			(r) =>
				`${r.path}: here ${r.localSize} B, ${iso(r.localMtime)}; Drive ${r.driveSize ?? '?'} B${options.encrypted ? ' (encrypted)' : ''}, ${iso(r.driveMtime)}; newer by time: ${newerSide(r)}; ${
					r.pending
						? "waiting in the pending list (Push uploads this device's version)"
						: "not in the pending list (Pull keeps Drive's version, and this device's one if it also changed)"
				}`,
			limit,
		),
		...section(
			'ONLY ON THIS DEVICE',
			rows.filter((r) => r.verdict === 'only-here'),
			(r) => `${r.path}: ${r.localSize} B, ${iso(r.localMtime)}; ${r.pending === 'create' ? 'waiting in the pending list (Push uploads it)' : 'Push will find it as new'}`,
			limit,
		),
		...section(
			'ONLY ON GOOGLE DRIVE',
			rows.filter((r) => r.verdict === 'only-drive'),
			(r) => `${r.path}: ${r.driveSize ?? '?'} B, ${iso(r.driveMtime)}; ${r.pending === 'delete' ? 'its deletion is waiting in the pending list (Push removes it on Drive)' : 'Pull will download it'}`,
			limit,
		),
		...section(
			'NOT DECIDED YET',
			rows.filter((r) => r.verdict === 'unknown'),
			(r) => `${r.path}: ${r.reason ?? 'unknown'}`,
			limit,
		),
		...section(
			'COULD NOT BE CHECKED',
			rows.filter((r) => r.verdict === 'failed'),
			(r) => `${r.path}: ${r.reason ?? 'unknown'}`,
			limit,
		),
	);
	lines.push('', 'Nothing was changed on this device or on Google Drive. This is how it looked a moment ago.');
	return lines.join('\n');
};

export interface VaultComparison {
	rows: Row[];
	encrypted: boolean;
}

/** Gathers both sides and runs stage 1. Returns an error text instead of rows when it cannot start. */
export const collectVaultComparison = async (t: ObsidianGoogleDrive): Promise<VaultComparison | { error: string }> => {
	if (t.settings.e2eeEnabled === true && !t.e2ee) {
		return { error: 'Encryption is locked on this device. Unlock it in the plugin settings first.' };
	}
	if (!t.accessToken.token && !(await refreshAccessToken(t))) {
		return { error: 'Authentication failed. Re-authenticate in plugin settings.' };
	}
	const listed = await t.drive.searchFiles({
		include: ['id', 'properties', 'mimeType', 'size', 'md5Checksum', 'modifiedTime'],
	});
	if (!listed) return { error: 'Could not list the files on Google Drive.' };
	const drive: DriveFact[] = [];
	for (const f of listed) {
		if (f.mimeType === folderMimeType || f.mimeType?.startsWith('application/vnd.google-apps.')) continue;
		if (f.properties?.config === 'true') continue;
		const path = unSplitPath(f.properties);
		if (!path || isOwnPluginPath(t, path) || !isSyncedPath(t, path)) continue;
		drive.push({
			path,
			id: f.id,
			size: f.size === undefined ? undefined : Number(f.size),
			md5: f.md5Checksum,
			modifiedTime: f.modifiedTime,
		});
	}
	const local: LocalFact[] = t.app.vault
		.getFiles()
		.filter((f) => !isOwnPluginPath(t, f.path) && isSyncedPath(t, f.path))
		.map((f) => ({ path: f.path, size: f.stat.size, mtime: f.stat.mtime }));
	const encrypted = t.settings.e2eeEnabled === true;
	const rows = await quickCompare({
		local,
		drive,
		encrypted,
		pending: t.settings.operations,
		readLocal: (path) => {
			const file = t.app.vault.getFileByPath(path);
			if (!file) throw new Error('missing');
			return t.app.vault.readBinary(file);
		},
	});
	return { rows, encrypted };
};
