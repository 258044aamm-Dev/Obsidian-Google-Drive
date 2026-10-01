import type ObsidianGoogleDrive from '../main';
import { Notice, TFile, TFolder } from 'obsidian';
import {
	batchAsync,
	FileMetadata,
	folderMimeType,
	foldersToBatches,
	unSplitPath,
} from './drive';
import { refreshAccessToken } from './requests';
import { E2eeError } from './crypto';
import type { SyncPhase } from './diagnostics';
import { sanitizeMessage } from './diagnostics';
import {
	findImpliedDescendants,
	partitionFolderDeletions,
} from './folder-deletion';
import { isOwnPluginPath } from './own-plugin';
import { isConfigPathSynced } from './config-scope';
import { connectionHint } from './net-retry';
import { addTrashedAsRemoved } from './trash';
import { sameBytes, saveConflictCopy } from './conflict-copy';
import {
	hashOf,
	isOwnUpload,
	locallyEdited,
	recordSynced,
	stampOf,
	unchangedSinceSync,
} from './sync-state';
import {
	countRemoteChanges,
	findCollisions,
	type PullGuard,
	type RemoteChange,
} from './push-guard';

/**
 * `guard` (used only by Push): look at what changed on Drive but never apply it. `pull`
 * returns false (and sets `guard.blocked`) when Push has to stop, true when it may go on.
 */
export const pull = async (
	t: ObsidianGoogleDrive,
	silenceNotices = false,
	guard?: PullGuard,
) => {
	let syncNotice = undefined;

	if (!silenceNotices) {
		if (t.syncing) return;
		syncNotice = await t.startSync('Pulling from Google Drive');
	}

	let lastPhase: SyncPhase = 'auto-sync';
	/** Set once this pull has registered the ids of incoming files; undoes that for files that never arrived. */
	let takeBackUnarrived: (() => void) | undefined;

	try {
		const { vault } = t.app;
		const adapter = vault.adapter;

		lastPhase = 'token-refresh';
		if (!t.accessToken.token) {
			if (!(await refreshAccessToken(t))) {
				new Notice(
					'Pull failed: authentication error. Re-authenticate in plugin settings.',
					8000,
				);
				if (!silenceNotices) t.abortSync(syncNotice);
				return false;
			}
		}

		await t.ensureMigrated?.();

		const listedRecentlyModified = await t.diagnostics.withContext(
			'list-files',
			'search-recently-modified',
			async () => {
				lastPhase = 'list-files';
				return t.drive.searchFiles({
					include: ['id', 'modifiedTime', 'properties', 'mimeType'],
					matches: [
						{
							modifiedTime: {
								gt: new Date(t.settings.lastSyncedAt).toISOString(),
							},
						},
					],
				});
			},
		);
		if (!listedRecentlyModified) {
			new Notice(
				'Pull failed: could not list drive files. Check diagnostics.',
				8000,
			);
			if (!silenceNotices) t.abortSync(syncNotice);
			return false;
		}

		// This plugin's own folder (code + private state) is never pulled.
		const recentlyModified = listedRecentlyModified.filter(
			({ properties }) =>
				!isOwnPluginPath(t, unSplitPath(properties)) &&
				// a switched-off kind of settings file (see config-scope.ts) is neither pulled nor counted
				isConfigPathSynced(t, unSplitPath(properties)),
		);

		const cloudSet = new Set(
			Object.values(t.settings.driveIdToPath).filter(
				(path) =>
					!path.startsWith(vault.configDir + '/') &&
					path !== vault.configDir,
			),
		);

		const localSet = new Set(
			vault
				.getAllLoadedFiles()
				.map((file) => file.path)
				.filter((path) => path !== '/'),
		);

		cloudSet.forEach((path) => {
			if (!localSet.has(path)) {
				t.settings.operations[path] = 'delete';
			}
		});

		for (const path in t.settings.operations) {
			if (
				path === vault.configDir ||
				path.startsWith(vault.configDir + '/')
			) {
				continue;
			}

			const operation = t.settings.operations[path];
			const existsLocally = localSet.has(path);

			if (operation === 'delete' && existsLocally) {
				t.settings.operations[path] = 'modify';
			} else if (operation === 'create' && !existsLocally) {
				delete t.settings.operations[path];
			} else if (operation === 'modify' && !existsLocally) {
				t.settings.operations[path] = 'delete';
			}
		}

		recentlyModified.forEach(({ properties }) =>
			cloudSet.add(unSplitPath(properties)),
		);

		localSet.forEach((path) => {
			if (!cloudSet.has(path)) {
				t.settings.operations[path] = 'create';
			}
		});

		const changes = await t.diagnostics.withContext(
			'fetch-changes',
			'get-changes',
			async () => {
				lastPhase = 'fetch-changes';
				return t.drive.getChanges(t.settings.changesToken);
			},
		);
		if (!changes) {
			new Notice(
				'Pull failed: could not fetch drive changes. Check diagnostics.',
				8000,
			);
			if (!silenceNotices) t.abortSync(syncNotice);
			return false;
		}
		// Files moved to the Drive Trash count as removed, whether or not the feed says so.
		await addTrashedAsRemoved(t, changes);

		const removedPaths = Object.fromEntries(
			changes
				.filter(({ removed }) => removed)
				.map(({ fileId }) => [
					fileId,
					t.settings.driveIdToPath[fileId],
				]),
		);

		// Ids that Drive says are gone. They are only dropped from the id map once the
		// local deletions have really been applied (see below): if this pull dies half
		// way, the next pull must still know which local paths those ids belonged to.
		const removedIds = new Set<string>();

		const deletions = changes
			.filter(({ removed }) => removed)
			.map(({ fileId }) => {
				const path = t.settings.driveIdToPath[fileId];
				if (!path) return;
				removedIds.add(fileId);

				const file = vault.getAbstractFileByPath(path);

				if (!file && t.settings.operations[path] === 'delete') {
					delete t.settings.operations[path];
					return;
				}
				return file;
			});

		if (guard) {
			// A file whose Drive time is exactly what this device's own upload produced is
			// not a change made by anybody else.
			const changed: RemoteChange[] = recentlyModified
				.filter(({ id, modifiedTime }) => !isOwnUpload(t, id, modifiedTime))
				.map(({ id, properties, mimeType }) => ({
					path: unSplitPath(properties),
					previousPath: t.settings.driveIdToPath[id],
					isFolder: mimeType === folderMimeType,
				}));
			const gone = Object.values(removedPaths).filter(
				(path): path is string => !!path && isConfigPathSynced(t, path),
			);
			guard.remoteCount = countRemoteChanges(changed, gone);
			guard.conflicts = findCollisions(
				changed,
				gone,
				Object.keys(t.settings.operations),
			);
			guard.blocked =
				guard.remoteCount > 0 &&
				(guard.mode === 'any' || guard.conflicts.length > 0);
			return !guard.blocked;
		}

		if (!recentlyModified.length && !deletions.length) {
			if (silenceNotices) return true;
			const ended = await t.endSync(syncNotice);
			if (ended) new Notice('Pull complete — already up to date.');
			return ended;
		}

		const pathToId = Object.fromEntries(
			Object.entries(t.settings.driveIdToPath)
				.filter(([id]) => !removedIds.has(id))
				.map(([id, path]) => [path, id]),
		);

		// Entries for removed ids stay in the persisted map until the deletions succeed.
		const pendingRemovals: Record<string, string> = {};
		removedIds.forEach((id) => {
			const path = t.settings.driveIdToPath[id];
			if (path) pendingRemovals[id] = path;
		});

		const updateMap = () => {
			recentlyModified.forEach(({ id, properties }) => {
				pathToId[unSplitPath(properties)] = id;
			});

			t.settings.driveIdToPath = {
				...pendingRemovals,
				...Object.fromEntries(
					Object.entries(pathToId).map(([path, id]) => [id, path]),
				),
			};
		};

		// Ids are registered before their files are downloaded. If this pull stops half way, the
		// ids of files that never reached this device must not stay: the next pull would read
		// "known on Drive, absent here" as "deleted on this device".
		const mapBeforePull = { ...t.settings.driveIdToPath };
		takeBackUnarrived = () => {
			recentlyModified.forEach(({ id, properties }) => {
				if (mapBeforePull[id] !== undefined) return;
				if (vault.getAbstractFileByPath(unSplitPath(properties))) return;
				delete t.settings.driveIdToPath[id];
			});
		};

		updateMap();

		// Copies of Drive versions saved because the same note was also changed on this device.
		const conflictCopies: string[] = [];

		// Ids of local files/folders that are removed only because an ancestor folder was
		// removed on Drive (the feed may not list them). Forgotten once the deletion worked.
		const impliedIds = new Set<string>();

		const deleteFiles = async () => {
			// Notes that Drive removed but that were really edited on this device (the edit event
			// may have been missed): they are kept and uploaded again, like a pending edit.
			const editedHere = new Set<string>();
			{
				const candidates: TFile[] = [];
				for (const entry of deletions) {
					if (entry instanceof TFile) candidates.push(entry);
					else if (entry instanceof TFolder && !pathToId[entry.path]) {
						const prefix = entry.path + '/';
						vault
							.getFiles()
							.filter((f) => f.path.startsWith(prefix))
							.forEach((f) => candidates.push(f));
					}
				}
				for (const file of candidates) {
					if (
						!t.settings.operations[file.path] &&
						(await locallyEdited(t, file, () => vault.readBinary(file)))
					) {
						editedHere.add(file.path);
					}
				}
			}

			const explicitFiles = deletions
				.filter((file) => file instanceof TFile)
				.filter((file: TFile) => {
					if (editedHere.has(file.path)) {
						t.settings.operations[file.path] = 'create';
						return;
					}
					if (t.settings.operations[file.path] === 'modify') {
						if (!pathToId[file.path]) {
							t.settings.operations[file.path] = 'create';
						}
						return;
					}
					return true;
				});

			const removedFolders = deletions
				.filter((folder) => folder instanceof TFolder)
				.filter((folder) => !pathToId[folder.path]);

			const modifiedOnDrive = new Set(recentlyModified.map(({ id }) => id));
			const implied = findImpliedDescendants(
				removedFolders,
				(path, isFolder) => {
					const id = pathToId[path];
					if (!id || modifiedOnDrive.has(id)) return 'unknown';
					const operation = t.settings.operations[path];
					if (!operation) {
						return !isFolder && editedHere.has(path) ? 'edited' : 'gone';
					}
					// A locally edited file whose Drive copy is gone: keep it, upload it again.
					return !isFolder && operation === 'modify' ? 'edited' : 'unknown';
				},
			);

			implied.edited.forEach(({ path }) => {
				t.settings.operations[path] = 'create';
				const id = pathToId[path];
				if (id) impliedIds.add(id);
			});

			const explicitPaths = new Set(explicitFiles.map(({ path }) => path));
			const deletedFiles = [
				...explicitFiles,
				...implied.files.filter(({ path }) => !explicitPaths.has(path)),
			];
			const deletedFilePaths = new Set(deletedFiles.map(({ path }) => path));

			const { remove: deletedFolders, keep: keptFolders } =
				partitionFolderDeletions(
					[
						...new Map(
							[...removedFolders, ...implied.folders].map((f) => [
								f.path,
								f,
							]),
						).values(),
					],
					deletedFilePaths,
				);

			[...implied.files, ...deletedFolders].forEach(({ path }) => {
				const id = pathToId[path];
				if (id && !removedIds.has(id)) impliedIds.add(id);
			});

			// Folders that still hold local content must not be deleted (nor left behind
			// as silent ghosts): treat them as new local folders.
			keptFolders.forEach((folder) => {
				t.settings.operations[folder.path] = 'create';
			});

			await t.drive.deleteFilesMinimumOperations([
				...deletedFolders,
				...deletedFiles,
			]);

			// Obsidian emits a delete event for every descendant of a trashed folder; those
			// events are just this pull mirroring Drive, not pending local deletions.
			deletedFolders.forEach(({ path }) => {
				const prefix = path + '/';
				Object.keys(t.settings.operations).forEach((opPath) => {
					if (
						opPath.startsWith(prefix) &&
						t.settings.operations[opPath] === 'delete'
					) {
						delete t.settings.operations[opPath];
					}
				});
			});
		};

		await t.diagnostics.withContext('delete', 'delete-local-files', async () => {
			lastPhase = 'delete';
			await deleteFiles();
		});

		// The deletions are applied: now it is safe to forget the removed ids.
		removedIds.forEach((id) => delete t.settings.driveIdToPath[id]);
		impliedIds.forEach((id) => delete t.settings.driveIdToPath[id]);

		syncNotice?.setMessage(
			`Pulling... ${deletions.filter(Boolean).length} files removed`,
		);

		const upsertFiles = async () => {
			const newFolders = recentlyModified.filter(
				({ mimeType }) => mimeType === folderMimeType,
			);

			const newNotes = recentlyModified.filter(
				({ mimeType }) => mimeType !== folderMimeType,
			);

			// A Drive folder's modifiedTime is not refreshed when its children
			// change, so a folder can look stale relative to the files inside
			// it. Pre-create every ancestor folder of a pulled file so the
			// writes below never target a missing local directory (ENOENT).
			const ancestorFolders = new Set<string>();
			for (const file of newNotes) {
				const segments = unSplitPath(file.properties).split('/');
				for (let i = 1; i < segments.length; i++) {
					ancestorFolders.add(segments.slice(0, i).join('/'));
				}
			}

			const foldersToEnsure = [
				...new Set([
					...ancestorFolders,
					...newFolders.map(({ properties }) => unSplitPath(properties)),
				]),
			];

			if (foldersToEnsure.length) {
				const batches = foldersToBatches(foldersToEnsure);

				for (const batch of batches) {
					await Promise.all(
						batch.map(async (folder) => {
							delete t.settings.operations[folder];
							if (
								vault.getFolderByPath(folder) ||
								(await adapter.exists(folder))
							) {
								return;
							}
							return t.createFolder(folder);
						}),
					);
				}
			}

			let completed = 0;

			// Why a copy was made (diagnostics only): which rule fired and what was remembered.
			const recordConflictReason = (path: string, reason: string) => {
				const base = t.settings.syncedFiles?.[path];
				t.diagnostics.record({
					phase: 'download',
					operation: 'conflict-copy',
					message: `Kept the local note, saved the Drive version as a copy (${reason}; mark: ${t.settings.operations[path] ?? 'none'}; remembered state: ${base ? (base.h ? 'with fingerprint' : 'without fingerprint') : 'none'})`,
				});
			};

			// A note changed both here (not pushed yet) and on Drive keeps this device's
			// version in place and saves the Drive version next to it as a copy.
			const keepDriveVersionAsCopy = async (
				file: FileMetadata,
				path: string,
				localFile: TFile | boolean,
				reason = 'pending-mark',
			) => {
				if (!(localFile instanceof TFile)) return;
				if (path === vault.configDir || path.startsWith(vault.configDir + '/')) {
					return;
				}
				const driveContent = await t.drive
					.getFile(file.id, path)
					.arrayBuffer();
				if (sameBytes(await adapter.readBinary(path), driveContent)) {
					return;
				}
				const saved = await saveConflictCopy(t, path, driveContent);
				if (saved.created) {
					conflictCopies.push(saved.path);
					recordConflictReason(path, reason);
				}
			};

			// Encrypted vault: a file that fails its integrity check is not written; the others still download.
			const refused: string[] = [];
			const downloadOne = async (file: FileMetadata) => {
				{
					const path = unSplitPath(file.properties);
					const localFile =
						vault.getFileByPath(path) ||
						(await adapter.exists(path));
					let operation = t.settings.operations[path];

					completed++;

					// A `create` / `modify` mark on a note that is exactly what it was at the last sync
					// is not an edit made here (Obsidian reports the files a Pull wrote later, and that
					// was taken for one): take the Drive version instead of keeping an old copy apart.
					if (
						localFile instanceof TFile &&
						(operation === 'modify' || operation === 'create') &&
						path !== vault.configDir &&
						!path.startsWith(vault.configDir + '/') &&
						(await unchangedSinceSync(t, localFile, () =>
							adapter.readBinary(path),
						))
					) {
						t.diagnostics.record({
							phase: 'download',
							operation: 'false-pending-mark',
							message: `Pending "${operation}" mark ignored: the note is unchanged since the last sync`,
						});
						delete t.settings.operations[path];
						operation = undefined;
					}

					if (localFile && operation === 'modify') {
						await keepDriveVersionAsCopy(file, path, localFile);
						return;
					}

					if (localFile && operation === 'create') {
						t.settings.operations[path] = 'modify';
						await keepDriveVersionAsCopy(file, path, localFile);
						return;
					}

					// No pending edit, but the note is not what it was when it last matched Drive:
					// it was edited here without the plugin noticing. Never overwrite it.
					if (
						localFile instanceof TFile &&
						!operation &&
						path !== vault.configDir &&
						!path.startsWith(vault.configDir + '/') &&
						(await locallyEdited(t, localFile, () =>
							adapter.readBinary(path),
						))
					) {
						const driveContent = await t.drive
							.getFile(file.id, path)
							.arrayBuffer();
						const here = await adapter.readBinary(path);
						if (sameBytes(here, driveContent)) {
							// Same as Drive after all: nothing to keep apart, just remember it.
							recordSynced(t, path, stampOf(localFile), await hashOf(here));
							return;
						}
						const saved = await saveConflictCopy(t, path, driveContent);
						if (saved.created) {
							conflictCopies.push(saved.path);
							recordConflictReason(path, 'edited-here');
						}
						t.settings.operations[path] = 'modify';
						return;
					}

					const content = await t.drive
						.getFile(file.id, path)
						.arrayBuffer();

					syncNotice?.setMessage(
						`Pulling... downloading ${completed}/${newNotes.length} files`,
					);

					if (localFile instanceof TFile) {
						return t.modifyFile(
							localFile,
							content,
							file.modifiedTime,
						);
					}

					return t.upsertFile(path, content, file.modifiedTime);
				}
			};

			await batchAsync(
				newNotes.map((file: FileMetadata) => async () => {
					try {
						return await downloadOne(file);
					} catch (error) {
						if (!(error instanceof E2eeError)) throw error;
						refused.push(unSplitPath(file.properties));
					}
				}),
			);

			if (refused.length > 0) {
				const shown =
					refused.slice(0, 5).join(', ') +
					(refused.length > 5 ? ', ...' : '');
				new Notice(
					`${refused.length} file(s) on Drive failed the encryption integrity check and were NOT used (changed, damaged or swapped): ${shown}. The other files were pulled. Nothing was overwritten.`,
					0,
				);
				throw new E2eeError(
					`${refused.length} file(s) failed the encryption integrity check: ${shown}`,
					'corrupt',
				);
			}
		};

		await t.diagnostics.withContext(
			'download',
			'download-and-write-files',
			async () => {
				lastPhase = 'download';
				await upsertFiles();
			},
		);

		const deleteConfigs = async () => {
			const configDeletions = await Promise.all(
				changes
					.filter(({ removed }) => removed)
					.map(async ({ fileId }) => {
						const path = removedPaths[fileId];
						if (!path || vault.getAbstractFileByPath(path)) return;
						if (isOwnPluginPath(t, path)) return;
						if (!isConfigPathSynced(t, path)) return;
						const stat = await adapter.stat(path);
						if (!stat) return;
						return { path, type: stat.type };
					}),
			);

			let configDeletionsFiltered = configDeletions.filter(Boolean) as {
				path: string;
				type: 'file' | 'folder';
			}[];

			const trashMethod = (
				vault as unknown as {
					getConfig: (key: 'trashOption') => 'local' | 'system';
				}
			).getConfig('trashOption');

			if (trashMethod === 'local' || trashMethod === 'system') {
				const deletionMethod =
					trashMethod === 'local'
						? adapter.trashLocal.bind(adapter)
						: adapter.trashSystem.bind(adapter);

				const folders = configDeletionsFiltered.filter(
					(file) => file.type === 'folder',
				);

				if (folders.length) {
					const maxDepth = Math.max(
						...folders.map(({ path }) => path.split('/').length),
					);

					for (let depth = 1; depth <= maxDepth; depth++) {
						const foldersToDelete = configDeletionsFiltered.filter(
							(file) =>
								file.type === 'folder' &&
								file.path.split('/').length === depth,
						);
						await Promise.all(
							foldersToDelete.map(({ path }) =>
								deletionMethod(path),
							),
						);
						foldersToDelete.forEach(
							(folder) =>
								(configDeletionsFiltered =
									configDeletionsFiltered.filter(
										({ path }) =>
											!path.startsWith(
												folder.path + '/',
											) && path !== folder.path,
									)),
						);
					}
				}

				await Promise.all(
					configDeletionsFiltered.map(({ path }) =>
						deletionMethod(path),
					),
				);
				return;
			}

			const deletedFiles = configDeletionsFiltered.filter(
				(file) => file.type === 'file',
			);
			await Promise.all(
				deletedFiles.map(({ path }) => adapter.remove(path)),
			);

			const deletedFolders = configDeletionsFiltered.filter(
				(file) => file.type === 'folder',
			);
			const batches = foldersToBatches(
				deletedFolders.map(({ path }) => path),
			);
			batches.reverse();

			for (const batch of batches) {
				await Promise.all(
					batch.map(async (folder) => {
						const list = await adapter.list(folder);
						if (list.files.length + list.folders.length) return;
						void adapter.rmdir(folder, false);
					}),
				);
			}
		};

		await deleteConfigs();

		if (conflictCopies.length) {
			// Shown even during the silent pull inside Push: the user should know a copy exists.
			new Notice(
				conflictCopies.length === 1
					? `A note was changed on Drive and on this device. Your version was kept and the Drive version saved as "${conflictCopies[0] as string}".`
					: `${conflictCopies.length} notes were changed on Drive and on this device. Your versions were kept and the Drive versions saved as copies named "… (Drive YYYY-MM-DD)".`,
				12000,
			);
		}

		if (silenceNotices) return true;

		const syncedCount = recentlyModified.filter(
			({ mimeType }) => mimeType !== folderMimeType,
		).length;
		const ended = await t.endSync(syncNotice);
		if (ended) {
			await t.saveLog(t.diagnostics.getEntries());
			new Notice(
				`Pull complete — ${syncedCount} file${syncedCount === 1 ? '' : 's'} synced.`,
			);
		}
		return ended;
	} catch (error) {
		takeBackUnarrived?.();
		t.diagnostics.record({
			phase: lastPhase,
			operation: 'pull-unknown',
			message: sanitizeMessage(error),
			stack: error instanceof Error ? error.stack : undefined,
		});
		// Silent pulls are nested inside push/reset/startup, which own the
		// progress notice and the syncing flag — leave cleanup to the caller.
		if (!silenceNotices) {
			t.abortSync(syncNotice);
			new Notice(
				`Pull failed during ${lastPhase}. Use "Copy diagnostics" for details.`,
				8000,
			);
			// the cause was the connection: say so and that pressing Pull again is safe
			const lost = connectionHint(error);
			if (lost) {
				new Notice(
					`${lost} Nothing was lost: press Pull again when the connection is back.`,
					10000,
				);
			}
		}
		console.error('Google Drive pull failed', error);
		return false;
	}
};
