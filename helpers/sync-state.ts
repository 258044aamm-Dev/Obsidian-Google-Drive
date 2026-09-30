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

export interface FileStamp {
	/** modification time in ms */
	m: number;
	/** size in bytes */
	s: number;
}

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
) => {
	if (!t.settings || !stamp) return;
	if (!Number.isFinite(stamp.m) || !Number.isFinite(stamp.s)) return;
	syncedFiles(t)[path] = { m: stamp.m, s: stamp.s };
};

/** Looks at the file on disk right now (used after a download wrote it). Never throws. */
export const recordSyncedFromDisk = async (
	t: ObsidianGoogleDrive,
	path: string,
) => {
	try {
		const stat = await t.app.vault.adapter.stat?.(path);
		if (stat && stat.type !== 'folder') {
			recordSynced(t, path, { m: stat.mtime, s: stat.size });
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

export const hasBaseline = (t: ObsidianGoogleDrive, path: string) =>
	!!t.settings.syncedFiles?.[path];

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
