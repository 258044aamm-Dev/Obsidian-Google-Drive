/**
 * Safety net for Push. The pending list (`settings.operations`) is built from Obsidian's
 * create / modify / delete events. New and deleted files are also found by comparing the
 * vault with the saved id map, but an EDIT of a synced note is only known through its event.
 * If that event was ever missed, Push would say "nothing to push" while the note differs
 * from Drive.
 *
 * So, before Push builds its list, notes that were written after the last sync and are not
 * pending are compared with their Drive copy; only real differences become `modify`.
 * Nothing is uploaded without the usual confirmation.
 */
import type ObsidianGoogleDrive from '../main';
import { TFile } from 'obsidian';
import { sameBytes } from './conflict-copy';
import { isOwnPluginPath } from './own-plugin';
import { sanitizeMessage } from './diagnostics';
import { recordSynced } from './sync-state';

/** Candidates beyond this number are not compared one by one (a bulk edit): they are all added. */
export const MAX_COMPARED_EDITS = 50;

export interface LocalFile {
	path: string;
	mtime: number;
	size?: number;
}

/** Remembered state of a file when it last matched Drive (see helpers/sync-state.ts). */
export type Baselines = Record<string, { m: number; s: number }>;

/**
 * Notes that Drive knows (saved id), that are not pending and that may differ from Drive.
 * A note with a remembered state (`baselines`) counts only when its time or size no longer
 * matches it, whatever the last sync time says. A note without one falls back to the older
 * rule: written after the last sync. Purely a filter; the comparison happens afterwards.
 */
export const editedSinceLastSync = (
	files: LocalFile[],
	pathToId: Record<string, string>,
	operations: Record<string, string>,
	lastSyncedAt: number,
	baselines: Baselines = {},
) =>
	files
		.filter(({ path, mtime, size }) => {
			if (!pathToId[path] || operations[path]) return false;
			const base = baselines[path];
			if (base && size !== undefined) {
				return base.m !== mtime || base.s !== size;
			}
			return lastSyncedAt > 0 && mtime > lastSyncedAt;
		})
		.map(({ path }) => path)
		.sort();

const localFiles = (t: ObsidianGoogleDrive): (LocalFile & { file: TFile })[] => {
	const { vault } = t.app;
	return vault
		.getFiles()
		.filter(
			(file) =>
				file.path !== vault.configDir &&
				!file.path.startsWith(vault.configDir + '/') &&
				!isOwnPluginPath(t, file.path),
		)
		.map((file) => ({
			path: file.path,
			mtime: file.stat.mtime,
			size: file.stat.size,
			file,
		}));
};

const pathIds = (t: ObsidianGoogleDrive) =>
	Object.fromEntries(
		Object.entries(t.settings.driveIdToPath).map(([id, path]) => [path, id]),
	);

/** Same filter as Push uses, without any network access (used by the Sync doctor). */
export const unrecordedEditCandidates = (t: ObsidianGoogleDrive) =>
	editedSinceLastSync(
		localFiles(t),
		pathIds(t),
		t.settings.operations,
		t.settings.lastSyncedAt,
		t.settings.syncedFiles,
	);

/**
 * Adds a `modify` operation for every note whose content differs from Drive but that is not
 * pending. Returns the paths it added. Never throws; a file that cannot be compared is added
 * too (the user sees it in the Push window and Drive keeps its old version in any case).
 */
export const recordMissedEdits = async (
	t: ObsidianGoogleDrive,
): Promise<string[]> => {
	try {
		const files = localFiles(t);
		const byPath = new Map(files.map((entry) => [entry.path, entry.file]));
		const ids = pathIds(t);
		const candidates = editedSinceLastSync(
			files,
			ids,
			t.settings.operations,
			t.settings.lastSyncedAt,
			t.settings.syncedFiles,
		);
		const added: string[] = [];
		let settingsChanged = false;
		for (const [index, path] of candidates.entries()) {
			const file = byPath.get(path);
			const id = ids[path];
			if (!file || !id) continue;

			let differs = true;
			if (index < MAX_COMPARED_EDITS) {
				try {
					const remote = await t.drive.getFile(id, path).arrayBuffer();
					if (remote) {
						differs = !sameBytes(
							await t.app.vault.readBinary(file),
							remote,
						);
						// Identical to Drive: remember that, so it is not looked at again.
						if (!differs) {
							recordSynced(t, path, {
								m: file.stat.mtime,
								s: file.stat.size,
							});
							settingsChanged = true;
						}
					}
				} catch {
					differs = true;
				}
			}
			if (differs) {
				t.settings.operations[path] = 'modify';
				added.push(path);
			}
		}
		if (added.length) {
			t.diagnostics.record({
				phase: 'upload',
				operation: 'missed-edits',
				message: `${added.length} edited note(s) were not in the pending list and were added`,
			});
		}
		if (added.length || settingsChanged) await t.saveSettings();
		return added;
	} catch (error) {
		t.diagnostics.record({
			phase: 'upload',
			operation: 'missed-edits-error',
			message: sanitizeMessage(error),
		});
		return [];
	}
};
