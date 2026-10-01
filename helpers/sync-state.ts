/**
 * What this device remembers about its own syncing, so it does not mistake its own work for
 * somebody else's.
 *
 *  - `ownUploads`: Drive id -> the `modifiedTime` Drive reported right after THIS device uploaded
 *    that file. If Drive still shows exactly that time, nobody changed the file since, so the Push
 *    guard must not count it as "changed on Google Drive".
 *  - `syncedFiles`: vault path -> { m: mtime, s: size } of the file the last time it was known to
 *    be identical to its Drive copy (after an upload, a download, or a content comparison). A note
 *    whose mtime and size still match is unchanged, whatever `lastSyncedAt` says.
 *
 * Both are additive, optional settings. Losing them only brings back the older, slower checks.
 */
import type ObsidianGoogleDrive from '../main';
import { configCategoryOf, isConfigPathSynced } from './config-scope';
import { isOwnPluginPath } from './own-plugin';

export interface FileStamp {
	/** modification time in ms */
	m: number;
	/** size in bytes */
	s: number;
	/** first 16 bytes of the SHA-256 of the (plain) content, hex; absent in states saved by 3.6.2 */
	h?: string;
}

/** Short fingerprint of a note's content. Undefined when it cannot be computed. */
export const hashOf = async (
	data: ArrayBuffer | Uint8Array,
): Promise<string | undefined> => {
	try {
		const view = data instanceof Uint8Array ? data : new Uint8Array(data);
		const digest = new Uint8Array(
			await window.crypto.subtle.digest('SHA-256', view as BufferSource),
		);
		return Array.from(digest.slice(0, 16), (b) =>
			b.toString(16).padStart(2, '0'),
		).join('');
	} catch {
		return undefined;
	}
};

/** Nothing is remembered past this many entries (keeps data.json small). */
const MAX_OWN_UPLOADS = 2000;

const ownUploads = (t: ObsidianGoogleDrive) =>
	(t.settings.ownUploads ??= {});
const syncedFiles = (t: ObsidianGoogleDrive) =>
	(t.settings.syncedFiles ??= {});

const sameInstant = (a?: string, b?: string) => {
	if (!a || !b) return false;
	const x = Date.parse(a);
	const y = Date.parse(b);
	return Number.isFinite(x) && x === y;
};

export const recordOwnUpload = (
	t: ObsidianGoogleDrive,
	id: string,
	modifiedTime?: string,
) => {
	if (!t.settings || !id || !modifiedTime) return;
	const map = ownUploads(t);
	map[id] = modifiedTime;
	const keys = Object.keys(map);
	if (keys.length > MAX_OWN_UPLOADS) {
		keys
			.sort((a, b) => Date.parse(map[a]!) - Date.parse(map[b]!))
			.slice(0, keys.length - MAX_OWN_UPLOADS)
			.forEach((key) => delete map[key]);
	}
};

/** True when Drive's current `modifiedTime` for this file is the one this device's own upload produced. */
export const isOwnUpload = (
	t: ObsidianGoogleDrive,
	id: string,
	modifiedTime?: string,
) => sameInstant(t.settings.ownUploads?.[id], modifiedTime);

/** The stamp of a vault file as Obsidian knows it now; undefined when it has none. */
export const stampOf = (file: {
	stat?: { mtime: number; size: number };
}): FileStamp | undefined =>
	file.stat ? { m: file.stat.mtime, s: file.stat.size } : undefined;

export const recordSynced = (
	t: ObsidianGoogleDrive,
	path: string,
	stamp: FileStamp | undefined,
	hash?: string,
) => {
	if (!t.settings || !stamp) return;
	if (!Number.isFinite(stamp.m) || !Number.isFinite(stamp.s)) return;
	const h = hash ?? stamp.h;
	syncedFiles(t)[path] = h
		? { m: stamp.m, s: stamp.s, h }
		: { m: stamp.m, s: stamp.s };
};

/** Looks at the file on disk right now (used after a download wrote it). Never throws. */
export const recordSyncedFromDisk = async (
	t: ObsidianGoogleDrive,
	path: string,
	content?: ArrayBuffer | Uint8Array,
) => {
	try {
		const stat = await t.app.vault.adapter.stat?.(path);
		if (stat && stat.type !== 'folder') {
			recordSynced(
				t,
				path,
				{ m: stat.mtime, s: stat.size },
				content ? await hashOf(content) : undefined,
			);
		}
	} catch {
		// no baseline is the safe outcome
	}
};

export const forgetSynced = (t: ObsidianGoogleDrive, path: string) => {
	if (t.settings?.syncedFiles) delete t.settings.syncedFiles[path];
};

/** True when the note is exactly as it was when it was last known to match Drive. */
export const matchesBaseline = (
	t: ObsidianGoogleDrive,
	path: string,
	mtime: number,
	size: number,
) => {
	const base = t.settings.syncedFiles?.[path];
	return !!base && base.m === mtime && base.s === size;
};

/**
 * True when this device's copy of a note is no longer what it was when it last matched Drive,
 * i.e. the user (or a tool) really changed the CONTENT here.
 *  - nothing remembered: false (unknown; the caller keeps its old behaviour);
 *  - time and size unchanged: false;
 *  - a remembered content fingerprint: compare it with the current content, so a note that was
 *    only touched (new time, same content) is not an edit;
 *  - no fingerprint (state from 3.6.2): a different size is an edit, a different time alone is not.
 */
export const locallyEdited = async (
	t: ObsidianGoogleDrive,
	file: { path: string; stat?: { mtime: number; size: number } },
	readLocal: () => Promise<ArrayBuffer>,
): Promise<boolean> => {
	try {
		const base = t.settings.syncedFiles?.[file.path];
		if (!base || !file.stat) return false;
		if (base.m === file.stat.mtime && base.s === file.stat.size) return false;
		if (base.h) {
			const now = await hashOf(await readLocal());
			return now !== undefined && now !== base.h;
		}
		return base.s !== file.stat.size;
	} catch {
		return false;
	}
};

/**
 * True when the note is, byte for byte, what it was when it was last known to match Drive. A
 * "changed" mark on such a note is not an edit (on a phone Obsidian reports the files that a
 * Pull wrote some time AFTER the write, and those reports were taken for edits).
 *  - nothing remembered: false (unknown: the caller keeps its old behaviour);
 *  - a remembered content fingerprint: the current content must give the same one;
 *  - no fingerprint (state from 3.6.2): time and size must both be unchanged.
 * Never throws.
 */
export const unchangedSinceSync = async (
	t: ObsidianGoogleDrive,
	file: { path: string; stat?: { mtime: number; size: number } },
	readLocal: () => Promise<ArrayBuffer>,
): Promise<boolean> => {
	try {
		const base = t.settings.syncedFiles?.[file.path];
		if (!base || !file.stat) return false;
		if (base.h) {
			const now = await hashOf(await readLocal());
			return now !== undefined && now === base.h;
		}
		return base.m === file.stat.mtime && base.s === file.stat.size;
	} catch {
		return false;
	}
};

/** The paths Drive knows (the saved id map), as a set. Cached by size: it only filters. */
let knownCache: { source: object; size: number; set: Set<string> } | undefined;
export const knownToDrive = (t: ObsidianGoogleDrive, path: string) => {
	const map = t.settings.driveIdToPath;
	const size = Object.keys(map).length;
	if (!knownCache || knownCache.source !== map || knownCache.size !== size) {
		knownCache = { source: map, size, set: new Set(Object.values(map)) };
	}
	return knownCache.set.has(path);
};

/**
 * Notes marked `create` / `modify` that Drive knows and that are exactly what they were at the
 * last sync: the marks are false. Read-only (the Sync doctor shows them; Pull ignores them when it
 * meets such a note). The note holds nothing that Drive did not have.
 */
export const findFalseMarks = async (
	t: ObsidianGoogleDrive,
): Promise<string[]> => {
	const found: string[] = [];
	try {
		const { vault } = t.app;
		for (const [path, operation] of Object.entries(t.settings.operations)) {
			if (operation !== 'modify' && operation !== 'create') continue;
			if (path === vault.configDir || path.startsWith(vault.configDir + '/')) continue;
			if (isOwnPluginPath(t, path) || !knownToDrive(t, path)) continue;
			const file = vault.getFileByPath(path);
			if (!file) continue;
			if (await unchangedSinceSync(t, file, () => vault.readBinary(file))) {
				found.push(path);
			}
		}
	} catch {
		// nothing is dropped when in doubt
	}
	return found.sort();
};

/**
 * Notes marked `create` / `modify` that Drive knows and for which this device remembers nothing
 * (no synced state at all): Pull cannot tell an edit from a false mark for them and keeps a copy
 * every time. "Repair sync memory" settles them. Read-only.
 */
export const findUnrememberedMarks = (t: ObsidianGoogleDrive): string[] => {
	const found: string[] = [];
	try {
		const { vault } = t.app;
		for (const [path, operation] of Object.entries(t.settings.operations)) {
			if (operation !== 'modify' && operation !== 'create') continue;
			if (path === vault.configDir || path.startsWith(vault.configDir + '/')) continue;
			if (isOwnPluginPath(t, path) || !knownToDrive(t, path)) continue;
			if (t.settings.syncedFiles?.[path]) continue;
			if (!vault.getFileByPath(path)) continue;
			found.push(path);
		}
	} catch {
		// nothing is reported when in doubt
	}
	return found.sort();
};

export const hasBaseline = (t: ObsidianGoogleDrive, path: string) =>
	!!t.settings.syncedFiles?.[path];

/**
 * Settings files that Drive knows and that exist on this device get a remembered state, so that
 * a later local deletion can be told apart from "this device never had the file" (Push only
 * removes a settings file from Drive when this device had it). Called after a successful sync.
 */
export const seedConfigBaselines = async (t: ObsidianGoogleDrive) => {
	try {
		const configDir = t.app.vault.configDir;
		for (const path of Object.values(t.settings.driveIdToPath)) {
			if (configCategoryOf(configDir, path) === undefined) continue;
			if (path === configDir || isOwnPluginPath(t, path)) continue;
			if (!isConfigPathSynced(t, path)) continue;
			if (t.settings.syncedFiles?.[path]) continue;
			await recordSyncedFromDisk(t, path);
		}
	} catch {
		// best effort: without it a local deletion is simply not passed on to Drive
	}
};

/** Drops what can no longer matter. `keepPaths` are the paths Drive knows. */
export const pruneSyncState = (
	t: ObsidianGoogleDrive,
	keepPaths: Set<string>,
	lastSyncedAt: number,
) => {
	if (t.settings.syncedFiles) {
		for (const path of Object.keys(t.settings.syncedFiles)) {
			if (!keepPaths.has(path)) delete t.settings.syncedFiles[path];
		}
	}
	if (t.settings.ownUploads) {
		for (const [id, time] of Object.entries(t.settings.ownUploads)) {
			if (Date.parse(time) <= lastSyncedAt) delete t.settings.ownUploads[id];
		}
	}
};

/** The Drive link changed (encryption turned on or off): nothing remembered applies any more. */
export const clearSyncState = (t: ObsidianGoogleDrive) => {
	t.settings.ownUploads = {};
	t.settings.syncedFiles = {};
};
