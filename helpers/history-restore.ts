/**
 * Restoring the vault to a restore point.
 *
 * The restore is LOCAL FIRST: it changes the files on this device only, through Obsidian's own
 * vault functions, so the plugin records every change as a normal pending operation. Nothing is
 * sent to Drive until the user reviews the result and presses Push (with its usual confirmation
 * list). Before anything is changed a fresh restore point is saved, so a restore can be undone
 * by restoring that point.
 */
import { TFile, TFolder } from 'obsidian';
import type ObsidianGoogleDrive from '../main';
import { batchAsync } from './drive';
import { pull } from './pull';
import { refreshAccessToken } from './requests';
import {
	downloadRevision,
	listDriveEntries,
	readRestorePoint,
	recordRestorePoint,
	revisionExists,
	type RestorePointData,
	type RestorePointInfo,
} from './history';
import { planRestore, type PlanItem, type RestorePlan } from './history-plan';
import { isConfigPathSynced } from './config-scope';

const GONE = 'Drive no longer has that old version (it expired or the file was deleted for good)';
const MAX_FAILURES = 5;

export const ensureToken = async (t: ObsidianGoogleDrive) => {
	if (t.accessToken.token) return true;
	return refreshAccessToken(t);
};

const pendingCount = (t: ObsidianGoogleDrive) =>
	Object.keys(t.settings.operations).length;

/** A reason why a restore cannot start now, or undefined when it can. */
export const restoreBlocker = (t: ObsidianGoogleDrive): string | undefined => {
	if (t.syncing) return 'A sync is running. Try again when it has finished.';
	if (t.settings.autoPush) {
		return 'Turn off "Automatically push changes" first, so you can check the restored vault before anything is uploaded.';
	}
	if (pendingCount(t)) {
		return 'This device has changes that are not pushed yet. Push first, then restore.';
	}
	return undefined;
};

/**
 * Brings this device level with Drive (a normal Pull) and checks that nothing is pending.
 * Returns a message when the restore must not go on.
 */
export const prepareRestore = async (
	t: ObsidianGoogleDrive,
): Promise<string | undefined> => {
	const blocker = restoreBlocker(t);
	if (blocker) return blocker;
	if (!(await ensureToken(t))) {
		return 'Authentication failed. Re-authenticate in the plugin settings.';
	}
	if (!(await pull(t))) {
		return 'The Pull before the restore did not finish, so nothing was changed. Fix that first (see the diagnostics).';
	}
	if (pendingCount(t)) {
		return 'The Pull left changes that need to be pushed (for example copies of notes that changed in two places). Push first, then restore.';
	}
	return undefined;
};

export interface BuiltPlan {
	point: RestorePointData;
	plan: RestorePlan;
}

/** Reads a restore point, compares it with Drive as it is now and checks that the old versions still exist. */
export const buildRestorePlan = async (
	t: ObsidianGoogleDrive,
	info: RestorePointInfo,
	includeConfig: boolean,
	onProgress: (done: number, total: number) => void = () => {},
): Promise<BuiltPlan> => {
	if (!(await ensureToken(t))) throw new Error('Authentication failed.');
	const point = await readRestorePoint(t, info.id);
	const current = await listDriveEntries(t);
	// A kind of settings file that is switched off (themes, snippets, settings files) is not part of the restore.
	const plan = planRestore(
		point.e.filter((entry) => isConfigPathSynced(t, entry.p)),
		current.filter((entry) => isConfigPathSynced(t, entry.path)),
		includeConfig,
	);

	const items = [...plan.revert, ...plan.recreate];
	const missing = new Set<PlanItem>();
	let done = 0;
	await batchAsync(
		items.map((item) => async () => {
			if (!(await revisionExists(t, item.id, item.rev))) missing.add(item);
			onProgress(++done, items.length);
		}),
		5,
	);
	if (missing.size) {
		plan.revert = plan.revert.filter((i) => !missing.has(i));
		plan.recreate = plan.recreate.filter((i) => !missing.has(i));
		for (const item of missing) plan.skipped.push({ path: item.path, reason: GONE });
		plan.skipped.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	}
	return { point, plan };
};

export interface RestoreResult {
	reverted: number;
	recreated: number;
	removed: number;
	foldersRemoved: number;
	foldersCreated: number;
	failed: { path: string; error: string }[];
	/** the restore point saved just before, for undoing this restore */
	safetyPoint?: RestorePointInfo;
	stoppedEarly: boolean;
}

const parentOf = (path: string) => path.split('/').slice(0, -1).join('/');

const ensureVaultFolders = async (t: ObsidianGoogleDrive, dir: string) => {
	if (!dir) return;
	const { vault } = t.app;
	const parts = dir.split('/');
	for (let i = 1; i <= parts.length; i++) {
		const path = parts.slice(0, i).join('/');
		const existing = vault.getAbstractFileByPath(path);
		if (existing instanceof TFolder) continue;
		if (existing) throw new Error(`a file is in the way at ${path}`);
		try {
			await vault.createFolder(path);
		} catch (error) {
			// Another file of the same restore may have just created it.
			if (!(vault.getAbstractFileByPath(path) instanceof TFolder)) throw error;
		}
	}
};

const ensureAdapterFolders = async (t: ObsidianGoogleDrive, dir: string) => {
	if (!dir) return;
	const { adapter } = t.app.vault;
	if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
};

const isConfigPath = (t: ObsidianGoogleDrive, path: string) => {
	const dir = t.app.vault.configDir;
	return path === dir || path.startsWith(dir + '/');
};

/**
 * Carries out a plan on this device. Files are handled a few at a time so that the memory use
 * stays small on a phone. It never uploads anything. If it is interrupted, the changes made so
 * far are pending operations like any other edit: push them, then run the restore again.
 */
export const applyRestorePlan = async (
	t: ObsidianGoogleDrive,
	plan: RestorePlan,
	onProgress: (done: number, total: number) => void = () => {},
): Promise<RestoreResult> => {
	const blocker = restoreBlocker(t);
	if (blocker) throw new Error(blocker);

	const result: RestoreResult = {
		reverted: 0,
		recreated: 0,
		removed: 0,
		foldersRemoved: 0,
		foldersCreated: 0,
		failed: [],
		stoppedEarly: false,
	};
	const { vault } = t.app;

	// Hold the sync lock so that nothing else syncs while the vault is being rewritten.
	t.syncing = true;
	t.clearAutoPushTimer();
	t.setSpinning(true);
	try {
		// Safety net: the state as it is now. A failure here stops the restore before any change.
		try {
			const saved = await recordRestorePoint(t);
			result.safetyPoint = saved.info;
		} catch (error) {
			throw new Error(
				`Could not save a restore point of the current state first, so nothing was changed. ${error instanceof Error ? error.message : ''}`.trim(),
			);
		}

		const writes = [
			...plan.revert.map((item) => ({ item, created: false })),
			...plan.recreate.map((item) => ({ item, created: true })),
		];
		const total = writes.length + plan.remove.length;
		let done = 0;

		const writeOne = async ({ item, created }: { item: PlanItem; created: boolean }) => {
			const downloaded = await downloadRevision(t, item.id, item.rev);
			// the size in the restore point is the size on Drive (encrypted bytes when encryption is on)
			if (item.size !== undefined && downloaded.byteLength !== item.size) {
				throw new Error(
					`the downloaded old version has ${downloaded.byteLength} bytes, expected ${item.size}`,
				);
			}
			const data = t.e2ee
				? await t.e2ee.decryptFile(downloaded, item.path)
				: downloaded;
			if (isConfigPath(t, item.path)) {
				await ensureAdapterFolders(t, parentOf(item.path));
				// A current modification time makes the next Push include the file.
				await vault.adapter.writeBinary(item.path, data, { mtime: Date.now() });
			} else {
				const existing = vault.getAbstractFileByPath(item.path);
				if (existing instanceof TFile) {
					await vault.modifyBinary(existing, data);
				} else if (existing) {
					throw new Error('a folder is in the way');
				} else {
					await ensureVaultFolders(t, parentOf(item.path));
					await vault.createBinary(item.path, data);
				}
			}
			if (created) result.recreated++;
			else result.reverted++;
		};

		const guarded = async (path: string, fn: () => Promise<void>) => {
			if (result.failed.length >= MAX_FAILURES) {
				result.stoppedEarly = true;
				return;
			}
			try {
				await fn();
			} catch (error) {
				result.failed.push({
					path,
					error: error instanceof Error ? error.message : String(error),
				});
			}
			onProgress(++done, total);
		};

		for (let i = 0; i < writes.length && !result.stoppedEarly; i += 4) {
			await Promise.all(
				writes
					.slice(i, i + 4)
					.map((write) => guarded(write.item.path, () => writeOne(write))),
			);
			if (i % 40 === 0) await t.saveSettings();
		}

		// Files that did not exist yet go through Obsidian's own "deleted files" setting.
		for (const entry of plan.remove.filter((r) => !r.isFolder)) {
			if (result.stoppedEarly) break;
			await guarded(entry.path, async () => {
				const file = vault.getAbstractFileByPath(entry.path);
				if (!file) return;
				if (!(file instanceof TFile)) throw new Error('expected a file');
				await t.app.fileManager.trashFile(file);
				result.removed++;
			});
		}

		if (!result.stoppedEarly) {
			// Folders only when they are empty by now: anything else in them stays.
			const folders = plan.remove
				.filter((r) => r.isFolder)
				.map((r) => r.path)
				.sort((a, b) => b.split('/').length - a.split('/').length);
			for (const path of folders) {
				const folder = vault.getAbstractFileByPath(path);
				if (folder instanceof TFolder && folder.children.length === 0) {
					try {
						await t.app.fileManager.trashFile(folder);
						result.foldersRemoved++;
					} catch (error) {
						result.failed.push({
							path,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				}
			}
			for (const path of plan.folders) {
				try {
					if (isConfigPath(t, path)) {
						await ensureAdapterFolders(t, path);
					} else if (!vault.getAbstractFileByPath(path)) {
						await ensureVaultFolders(t, path);
						result.foldersCreated++;
					}
				} catch (error) {
					result.failed.push({
						path,
						error: error instanceof Error ? error.message : String(error),
					});
				}
			}
		}
	} finally {
		t.setSpinning(false);
		t.syncing = false;
		await t.saveSettings();
	}
	return result;
};
