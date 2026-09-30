/**
 * Whole-vault version history.
 *
 * After every successful Push (and on demand) the plugin saves one small "restore point" on
 * Drive: for every file of the vault, its path, its Drive id and its head revision id. Drive
 * itself keeps the old revisions of a file (and files in its Trash) for about 30 days, so a
 * restore point is enough to bring the vault back to that moment without storing the files
 * a second time.
 *
 * Restore points are stored in their own Drive folder (next to, not inside, the vault folder) and tagged `history=<vault name>`
 * with NO `vault` or `obsidian` property. Every other part of the plugin (and the original
 * plugin) finds vault files by the `vault` property, so they never see these files.
 */
import { Notice, requestUrl } from 'obsidian';
import type ObsidianGoogleDrive from '../main';
import { folderMimeType, unSplitPath } from './drive';
import { isOwnPluginPath } from './own-plugin';
import { sanitizeMessage } from './diagnostics';
import { getDriveAgent, refreshAccessToken } from './requests';

export const HISTORY_DEFAULT_DAYS = 10;
export const HISTORY_MIN_DAYS = 1;
export const HISTORY_MAX_DAYS = 30;
const DAY_MS = 86_400_000;
const FOLDER_NAME = 'Obsidian Google Drive history (do not edit)';

/** One vault item inside a restore point (short keys keep the file small). */
export interface HistoryEntry {
	/** vault path */
	p: string;
	/** Drive file id */
	i: string;
	/** head revision id (files only) */
	r?: string;
	/** md5 of the content (files only) */
	m?: string;
	/** size in bytes (files only) */
	s?: number;
	/** 1 = folder */
	f?: 1;
	/** 1 = settings / plugin file from the config folder */
	c?: 1;
}

export interface RestorePointData {
	v: 1;
	/** device time in ms when the point was taken */
	t: number;
	vault: string;
	/** plugin version that wrote it */
	app: string;
	e: HistoryEntry[];
}

export interface RestorePointInfo {
	id: string;
	name: string;
	createdAt: number;
	count: number;
	sig: string;
}

/** What Drive currently holds for one vault item. */
export interface DriveEntry {
	id: string;
	path: string;
	isFolder: boolean;
	config: boolean;
	md5?: string;
	rev?: string;
	size?: number;
}

const escapeQueryValue = (value: string) =>
	value.replaceAll('\\', '\\\\').replaceAll("'", "\\'");

export const historyRetentionDays = (t: ObsidianGoogleDrive) => {
	const value = Math.round(Number(t.settings.historyRetentionDays));
	if (!Number.isFinite(value)) return HISTORY_DEFAULT_DAYS;
	return Math.min(HISTORY_MAX_DAYS, Math.max(HISTORY_MIN_DAYS, value));
};

// ---------------------------------------------------------------------------------------
// File format: JSON, gzip-compressed when the platform can (plain JSON otherwise).
// ---------------------------------------------------------------------------------------

const streamToBytes = async (stream: ReadableStream<Uint8Array>) =>
	new Uint8Array(await new Response(stream).arrayBuffer());

export const encodePoint = async (
	data: RestorePointData,
): Promise<{ bytes: Uint8Array; gzip: boolean }> => {
	const raw = new TextEncoder().encode(JSON.stringify(data));
	if (typeof CompressionStream === 'undefined') {
		return { bytes: raw, gzip: false };
	}
	const stream = new Blob([raw as BlobPart])
		.stream()
		.pipeThrough(new CompressionStream('gzip'));
	return { bytes: await streamToBytes(stream), gzip: true };
};

export const decodePoint = async (
	buffer: ArrayBuffer,
): Promise<RestorePointData> => {
	let bytes = new Uint8Array(buffer);
	if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
		if (typeof DecompressionStream === 'undefined') {
			throw new Error(
				'This device cannot read compressed restore points (no DecompressionStream).',
			);
		}
		const stream = new Blob([bytes as BlobPart])
			.stream()
			.pipeThrough(new DecompressionStream('gzip'));
		bytes = await streamToBytes(stream);
	}
	const data = JSON.parse(new TextDecoder().decode(bytes)) as RestorePointData;
	if (data?.v !== 1 || !Array.isArray(data.e)) {
		throw new Error('Unsupported restore point format.');
	}
	return data;
};

/** Fingerprint of what a restore point covers; two identical states give the same value. */
export const signatureOf = async (entries: HistoryEntry[]) => {
	const text = entries
		.map((e) => `${e.p}\t${e.f ? 'D' : 'F'}\t${e.c ? 1 : 0}\t${e.i}\t${e.m ?? e.r ?? ''}`)
		.sort()
		.join('\n');
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(text),
	);
	return Array.from(new Uint8Array(digest).slice(0, 16), (b) =>
		b.toString(16).padStart(2, '0'),
	).join('');
};

// ---------------------------------------------------------------------------------------
// Drive access (own helpers, so the existing drive client stays untouched)
// ---------------------------------------------------------------------------------------

interface ListedFile {
	id: string;
	name?: string;
	mimeType?: string;
	md5Checksum?: string;
	headRevisionId?: string;
	size?: string;
	createdTime?: string;
	properties?: Record<string, string>;
}

const listFiles = async (
	t: ObsidianGoogleDrive,
	query: string,
	fields: string,
): Promise<ListedFile[]> => {
	const agent = getDriveAgent(t);
	const files: ListedFile[] = [];
	let pageToken: string | undefined;
	do {
		const page = await agent
			.get(
				`drive/v3/files?fields=nextPageToken,files(${fields})&pageSize=1000&q=${encodeURIComponent(query)}${
					pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : ''
				}`,
			)
			.json<{ files?: ListedFile[]; nextPageToken?: string }>();
		files.push(...(page?.files ?? []));
		pageToken = page?.nextPageToken;
	} while (pageToken);
	return files;
};

/** Everything in this vault on Drive right now (files, folders, settings files), without this plugin's own folder. */
export const listDriveEntries = async (
	t: ObsidianGoogleDrive,
): Promise<DriveEntry[]> => {
	const vault = escapeQueryValue(t.app.vault.getName());
	const listed = await listFiles(
		t,
		`trashed=false and properties has { key='vault' and value='${vault}' }`,
		'id,mimeType,md5Checksum,headRevisionId,size,properties',
	);
	const entries: DriveEntry[] = [];
	for (const file of listed) {
		const properties = file.properties ?? {};
		if (properties.obsidian === 'vault' || properties.history) continue;
		const path = unSplitPath(properties);
		if (!path || isOwnPluginPath(t, path)) continue;
		entries.push({
			id: file.id,
			path,
			isFolder: file.mimeType === folderMimeType,
			config: properties.config === 'true',
			md5: file.md5Checksum,
			rev: file.headRevisionId,
			size: file.size === undefined ? undefined : Number(file.size),
		});
	}
	return entries;
};

export const toHistoryEntries = (entries: DriveEntry[]): HistoryEntry[] =>
	entries.map((e) => {
		const entry: HistoryEntry = { p: e.path, i: e.id };
		if (e.isFolder) entry.f = 1;
		else {
			if (e.rev) entry.r = e.rev;
			if (e.md5) entry.m = e.md5;
			if (e.size !== undefined && Number.isFinite(e.size)) entry.s = e.size;
		}
		if (e.config) entry.c = 1;
		return entry;
	});

const findHistoryFolder = async (t: ObsidianGoogleDrive) => {
	const vault = escapeQueryValue(t.app.vault.getName());
	const folders = await listFiles(
		t,
		`trashed=false and properties has { key='history' and value='${vault}' } and properties has { key='kind' and value='folder' }`,
		'id,createdTime',
	);
	return folders
		.sort((a, b) => (a.createdTime ?? '').localeCompare(b.createdTime ?? ''))[0]?.id;
};

/**
 * The history folder lives in the top level of My Drive, NOT inside the vault's Drive folder.
 * The README tells people to download the vault folder to set up a new device; anything inside
 * it would land in their vault and then be synced like notes.
 */
const ensureHistoryFolder = async (t: ObsidianGoogleDrive) => {
	const existing = await findHistoryFolder(t);
	if (existing) return existing;
	const vault = t.app.vault.getName();
	const created = await getDriveAgent(t)
		.post('drive/v3/files?fields=id', {
			json: {
				name: `${vault} - ${FOLDER_NAME}`,
				mimeType: folderMimeType,
				parents: ['root'],
				properties: { history: vault, kind: 'folder' },
			},
		})
		.json<{ id: string }>();
	if (!created?.id) throw new Error('Could not create the history folder on Drive.');
	return created.id;
};

/** All restore points of this vault, newest first. */
export const listRestorePoints = async (
	t: ObsidianGoogleDrive,
): Promise<RestorePointInfo[]> => {
	const vault = escapeQueryValue(t.app.vault.getName());
	const files = await listFiles(
		t,
		`trashed=false and properties has { key='history' and value='${vault}' } and properties has { key='kind' and value='point' }`,
		'id,name,createdTime,properties',
	);
	return files
		.map((file) => {
			const properties = file.properties ?? {};
			const createdAt =
				Number(properties.createdAt) || Date.parse(file.createdTime ?? '') || 0;
			return {
				id: file.id,
				name: file.name ?? '',
				createdAt,
				count: Number(properties.n) || 0,
				sig: properties.sig ?? '',
			};
		})
		.sort((a, b) => b.createdAt - a.createdAt);
};

export const readRestorePoint = async (
	t: ObsidianGoogleDrive,
	id: string,
): Promise<RestorePointData> =>
	decodePoint(
		await getDriveAgent(t).get(`drive/v3/files/${id}?alt=media`).arrayBuffer(),
	);

/** A GET that reports failures as a status instead of throwing or showing a notice (used for probing). */
const quietGet = async (t: ObsidianGoogleDrive, path: string) => {
	if (!t.accessToken.token || t.accessToken.expiresAt - Date.now() < 60_000) {
		if (!(await refreshAccessToken(t))) throw new Error('Authentication failed.');
	}
	return requestUrl({
		url: new URL(path, 'https://www.googleapis.com/').toString(),
		method: 'GET',
		headers: { Authorization: `Bearer ${t.accessToken.token}` },
		throw: false,
	});
};

/** Does Drive still have this old version of the file? (404 = it has been purged or the file is gone.) */
export const revisionExists = async (
	t: ObsidianGoogleDrive,
	fileId: string,
	revisionId: string,
) => {
	const response = await quietGet(
		t,
		`drive/v3/files/${encodeURIComponent(fileId)}/revisions/${encodeURIComponent(revisionId)}?fields=id`,
	);
	if (response.status >= 200 && response.status < 300) return true;
	if (response.status === 404) return false;
	throw new Error(`Drive answered HTTP ${response.status} while checking an old version.`);
};

export const downloadRevision = async (
	t: ObsidianGoogleDrive,
	fileId: string,
	revisionId: string,
) => {
	const response = await quietGet(
		t,
		`drive/v3/files/${encodeURIComponent(fileId)}/revisions/${encodeURIComponent(revisionId)}?alt=media`,
	);
	if (response.status < 200 || response.status >= 300) {
		throw new Error(`Drive answered HTTP ${response.status} while downloading an old version.`);
	}
	return response.arrayBuffer;
};

// ---------------------------------------------------------------------------------------
// Recording and pruning
// ---------------------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (ms: number) => {
	const d = new Date(ms);
	return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`;
};

/** Deletes restore points older than the retention period. The newest point is always kept. */
export const pruneRestorePoints = async (
	t: ObsidianGoogleDrive,
	points: RestorePointInfo[],
	now = Date.now(),
) => {
	const cutoff = now - historyRetentionDays(t) * DAY_MS;
	const [newest, ...rest] = [...points].sort((a, b) => b.createdAt - a.createdAt);
	if (!newest) return 0;
	let removed = 0;
	for (const point of rest) {
		if (point.createdAt >= cutoff) continue;
		try {
			await getDriveAgent(t).delete(`drive/v3/files/${point.id}`);
			removed++;
		} catch (error) {
			t.diagnostics.record({
				phase: 'history',
				operation: 'prune-restore-point',
				message: sanitizeMessage(error),
			});
		}
	}
	return removed;
};

export type RecordResult =
	| { status: 'created'; info: RestorePointInfo }
	| { status: 'unchanged'; info: RestorePointInfo };

/**
 * Saves a restore point of the vault as it is on Drive right now, unless the newest point
 * already describes exactly that state. Throws on failure (the caller decides what to tell the user).
 */
export const recordRestorePoint = async (
	t: ObsidianGoogleDrive,
	now = Date.now(),
): Promise<RecordResult> => {
	const entries = toHistoryEntries(await listDriveEntries(t));
	const sig = await signatureOf(entries);
	const points = await listRestorePoints(t);
	const newest = points[0];
	if (newest && newest.sig === sig) {
		await pruneRestorePoints(t, points, now);
		return { status: 'unchanged', info: newest };
	}

	const data: RestorePointData = {
		v: 1,
		t: now,
		vault: t.app.vault.getName(),
		app: t.manifest?.version ?? '',
		e: entries,
	};
	const { bytes, gzip } = await encodePoint(data);
	const mimeType = gzip ? 'application/gzip' : 'application/json';
	const name = `restore-point-${stamp(now)}.json${gzip ? '.gz' : ''}`;
	const parent = await ensureHistoryFolder(t);

	const form = new FormData();
	form.append(
		'metadata',
		new Blob(
			[
				JSON.stringify({
					name,
					mimeType,
					parents: [parent],
					properties: {
						history: t.app.vault.getName(),
						kind: 'point',
						createdAt: String(now),
						n: String(entries.length),
						sig,
					},
				}),
			],
			{ type: 'application/json' },
		),
	);
	form.append('file', new Blob([bytes as BlobPart], { type: mimeType }));
	const created = await getDriveAgent(t)
		.post('upload/drive/v3/files?uploadType=multipart&fields=id', { body: form })
		.json<{ id: string }>();
	if (!created?.id) throw new Error('Drive did not confirm the restore point upload.');

	const info: RestorePointInfo = {
		id: created.id,
		name,
		createdAt: now,
		count: entries.length,
		sig,
	};
	await pruneRestorePoints(t, [info, ...points], now);
	return { status: 'created', info };
};

/**
 * Called by Push after everything was uploaded. Never throws and never makes a Push fail:
 * a problem here is reported with a notice and in the diagnostics only.
 */
export const recordRestorePointAfterPush = async (t: ObsidianGoogleDrive) => {
	if (t.settings.historyEnabled !== true) return;
	try {
		await recordRestorePoint(t);
	} catch (error) {
		t.diagnostics.record({
			phase: 'history',
			operation: 'record-restore-point',
			message: sanitizeMessage(error),
			stack: error instanceof Error ? error.stack : undefined,
		});
		new Notice(
			'Your changes were pushed, but saving the restore point failed. Version history has no new entry for this push.',
			8000,
		);
	}
};
