/**
 * Files that came back from the Drive Trash (restored in the Drive web page).
 *
 * Pull downloads the files whose Drive "modified" time is newer than the last sync. Restoring a file
 * from the Trash does not change that time, so a device that had already removed the file never got it
 * back until somebody edited it. The changes feed does list the restore. So a file counts as changed too
 * when the feed has a change for it, this device does not know the file (it was removed here, or never
 * arrived) and the time check did not already list it.
 *
 * Costs nothing in the usual case: only when such a file exists is the vault listed once more.
 */
import type ObsidianGoogleDrive from '../main';
import type { FileMetadata } from './drive';

/** The feed is in time order: the last change of a file says what happened to it in the end. */
export const lastChangePerFile = <C extends { fileId: string }>(changes: C[]): C[] => {
	const last = new Map<string, number>();
	changes.forEach((change, i) => last.set(change.fileId, i));
	return changes.filter((change, i) => last.get(change.fileId) === i);
};

/**
 * The files Drive reports as changed that this device does not know and that the time check missed.
 * `undefined` when Drive could not be asked (the caller must not go on as if there were none).
 */
export const findUnseenChanged = async <C extends { fileId: string; removed: boolean }>(
	t: ObsidianGoogleDrive,
	changes: C[],
	listed: { id: string }[],
): Promise<FileMetadata[] | undefined> => {
	const known = new Set(Object.keys(t.settings.driveIdToPath));
	const seen = new Set(listed.map(({ id }) => id));
	const candidates = new Set(
		lastChangePerFile(changes)
			.filter(({ removed, fileId }) => !removed && !known.has(fileId) && !seen.has(fileId))
			.map(({ fileId }) => fileId),
	);
	if (!candidates.size) return [];
	const everything = await t.drive.searchFiles({
		include: ['id', 'modifiedTime', 'properties', 'mimeType'],
	});
	if (!everything) return undefined;
	// only this plugin's files: they carry their path
	return everything.filter(
		({ id, properties }) => candidates.has(id) && !!properties && properties.path !== undefined,
	);
};
