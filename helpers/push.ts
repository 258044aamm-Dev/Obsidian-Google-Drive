import type ObsidianGoogleDrive from '../main';
import { Modal, Notice, setIcon, Setting, TFile, TFolder } from 'obsidian';
import {
	batchAsync,
	fileNameFromPath,
	folderMimeType,
	foldersToBatches,
	splitPath,
	unSplitPath,
} from './drive';
import { pull } from './pull';
import { blockedMessage, type PullGuard } from './push-guard';
import { isOwnPluginPath } from './own-plugin';
import type { SyncPhase } from './diagnostics';
import { sanitizeMessage } from './diagnostics';
import { massDeleteWarning } from './push-warning';
import { recordRestorePointAfterPush } from './history';
import { recordMissedEdits } from './missed-edits';
import { hashOf, recordSynced, recordSyncedFromDisk, stampOf } from './sync-state';
import { isConfigPathSynced } from './config-scope';
import { verifySummary, verifyUploads } from './push-verify';
import type { UploadedItem } from './push-verify';

export class ConfirmPushModal extends Modal {
	proceed: (res: boolean, withoutPull?: boolean) => void;

	constructor(
		t: ObsidianGoogleDrive,
		initialOperations: [string, 'create' | 'delete' | 'modify'][],
		proceed: (res: boolean, withoutPull?: boolean) => void,
	) {
		super(t.app);
		this.proceed = proceed;

		this.setTitle('Push confirmation');
		this.contentEl
			.createEl('p')
			.setText(
				'Do you want to push the following changes to Google Drive:',
			);
		if (!initialOperations.length) {
			this.contentEl
				.createEl('p')
				.setText(
					'No changes were detected on this device since the last sync.',
				);
		}
		this.contentEl
			.createEl('p')
			.setText(
				'Push does not pull. If Google Drive has newer changes, push stops and asks you to pull first. The button below uploads your changes anyway, unless something changed both on this device and in Google Drive.',
			);
		const warning = massDeleteWarning(
			initialOperations,
			Object.keys(t.settings.driveIdToPath).length,
			t.settings.deleteToTrash === true,
		);
		if (warning) {
			this.contentEl.createEl('p', {
				text: warning,
				cls: 'mod-warning',
			});
		}
		const container = this.contentEl.createDiv();

		const render = (operations: typeof initialOperations) => {
			container.empty();
			operations.map(([path, op]) => {
				const div = container.createDiv();
				div.addClass('operation-container');

				const p = div.createEl('p');
				p.createEl('b').setText(
					`${(op[0] as string).toUpperCase()}${op.slice(1)}`,
				);
				p.createSpan().setText(`: ${path}`);

				if (
					op === 'delete' &&
					operations.some(([file]) => path.startsWith(file + '/'))
				) {
					return;
				}

				const btn = div.createDiv().createEl('button');
				setIcon(btn, 'trash-2');
				btn.onclick = async () => {
					const nestedFiles = operations
						.map(([file]) => file)
						.filter(
							(file) =>
								file.startsWith(path + '/') || file === path,
						);
					const proceed = await new Promise<boolean>((resolve) => {
						new ConfirmUndoModal(
							t,
							op,
							nestedFiles,
							resolve,
						).open();
					});

					if (!proceed) return;

					nestedFiles.forEach(
						(file) => delete t.settings.operations[file],
					);
					const newOperations = operations.filter(
						([file]) => !nestedFiles.includes(file),
					);
					if (!newOperations.length) return this.close();
					render(newOperations);
				};
			});
		};

		render(initialOperations);

		new Setting(this.contentEl)
			.addButton((btn) =>
				btn.setButtonText('Cancel').onClick(() => this.close()),
			)
			.addButton((btn) =>
				btn
					.setButtonText('Confirm')
					.setCta()
					.onClick(() => {
						proceed(true);
						this.close();
					}),
			)
			.addButton((btn) =>
				btn.setButtonText('Push without pulling').onClick(() => {
					proceed(true, true);
					this.close();
				}),
			);
	}

	onClose() {
		this.proceed(false);
	}
}

export class ConfirmUndoModal extends Modal {
	proceed: (res: boolean) => void;
	t: ObsidianGoogleDrive;
	filePathToId: Record<string, string>;

	constructor(
		t: ObsidianGoogleDrive,
		operation: 'create' | 'delete' | 'modify',
		files: string[],
		proceed: (res: boolean) => void,
	) {
		super(t.app);
		this.t = t;
		this.filePathToId = Object.fromEntries(
			Object.entries(this.t.settings.driveIdToPath).map(([id, path]) => [
				path,
				id,
			]),
		);

		const operationMap = {
			create: 'creating',
			delete: 'deleting',
			modify: 'modifying',
		};

		this.setTitle('Undo confirmation');
		this.contentEl
			.createEl('p')
			.setText(
				`Are you sure you want to undo ${operationMap[operation]} the following file(s):`,
			);
		this.contentEl.createEl('ul').append(
			...files.map((file) => {
				const li = this.contentEl.createEl('li');
				li.addClass('operation-file');
				li.setText(file);
				return li;
			}),
		);
		this.proceed = proceed;
		new Setting(this.contentEl)
			.addButton((btn) =>
				btn.setButtonText('Cancel').onClick(() => this.close()),
			)
			.addButton((btn) =>
				btn
					.setButtonText('Confirm')
					.setCta()
					.onClick(async () => {
						btn.setDisabled(true);
						if (operation === 'delete') {
							await this.handleDelete(files);
						}
						if (operation === 'create') {
							await this.handleCreate(files[0] as string);
						}
						if (operation === 'modify') {
							await this.handleModify(files[0] as string);
						}
						proceed(true);
						this.close();
					}),
			);
	}

	onClose() {
		this.proceed(false);
	}

	async handleDelete(paths: string[]) {
		const files = await this.t.drive.searchFiles({
			include: ['id', 'mimeType', 'properties', 'modifiedTime'],
			matches: paths.map((path) => ({ properties: splitPath(path) })),
		});
		if (!files) {
			new Notice(
				'[undo] failed to fetch drive files. Check diagnostics.',
				8000,
			);
			return;
		}

		const pathToFile = Object.fromEntries(
			files.map((file) => [unSplitPath(file.properties), file]),
		);

		const deletedFolders = paths.filter(
			(path) => pathToFile[path]?.mimeType === folderMimeType,
		);

		if (deletedFolders.length) {
			const batches = foldersToBatches(deletedFolders);

			for (const batch of batches) {
				await Promise.all(
					batch.map((folder) => this.t.createFolder(folder)),
				);
			}
		}

		const deletedFiles = paths.filter(
			(path) => pathToFile[path]?.mimeType !== folderMimeType,
		);

		await batchAsync(
			deletedFiles.map((path) => async () => {
				const onlineFile = await this.t.drive
					.getFile(this.filePathToId[path] as string, path)
					.arrayBuffer();
				if (!onlineFile) {
					new Notice(
						'[undo] failed to download file from drive. Check diagnostics.',
						8000,
					);
					return;
				}
				return this.t.createFile(
					path,
					onlineFile,
					pathToFile[path]?.modifiedTime,
				);
			}),
		);
	}

	async handleCreate(path: string) {
		const file = this.app.vault.getAbstractFileByPath(path);
		if (!file) return;
		return this.t.deleteFile(file);
	}

	async handleModify(path: string) {
		const file = this.app.vault.getFileByPath(path);
		if (!file) return;

		const [onlineFile, metadata] = await Promise.all([
			this.t.drive
				.getFile(this.filePathToId[path] as string, path)
				.arrayBuffer(),
			this.t.drive.getFileMetadata(this.filePathToId[path] as string),
		]);
		if (!onlineFile || !metadata) {
			return new Notice(
				'[undo] failed to download file from drive. Check diagnostics.',
				8000,
			);
		}
		return this.t.modifyFile(file, onlineFile, metadata.modifiedTime);
	}
}

export const push = async (
	t: ObsidianGoogleDrive,
	skipConfirmation = false,
	withoutPullOption = false,
) => {
	if (t.syncing) return;
	// Safety net: an edited note whose event was missed would otherwise be skipped.
	await recordMissedEdits(t);
	const initialOperations = Object.entries(t.settings.operations).sort(
		([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
	); // Alphabetical

	const { vault } = t.app;
	const adapter = vault.adapter;

	let withoutPull = withoutPullOption;
	const proceed =
		skipConfirmation ||
		(await new Promise<boolean>((resolve) => {
			new ConfirmPushModal(t, initialOperations, (ok, skipPull) => {
				// closing the window reports `false` after a button was pressed: ignore that
				if (ok) withoutPull = skipPull === true;
				resolve(ok);
			}).open();
		}));

	if (!proceed) return;

	const syncNotice = await t.startSync('Pushing to Google Drive');

	let lastPhase: SyncPhase = 'upload';
	/** Progress (pending list, id map, own uploads) is saved as the Push goes, so a stop or a restart keeps it. */
	const persist = () => {
		try {
			t.debouncedSaveSettings();
		} catch {
			// best effort; the final save still happens
		}
	};
	/** Set once every upload is done and the pending list is empty. */
	let allUploaded = false;
	/** Files this Push uploaded; a sample is checked on Drive at the end. */
	const uploaded: UploadedItem[] = [];

	// Whether Drive holds changes that this device has NOT pulled (only possible when the
	// user chose "Push without pulling"). The sync position then must not move forward.
	let unpulledRemoteChanges = false;

	try {
		// Push never pulls: it only looks at Drive and stops if there is something to pull.
		const guard: PullGuard = { mode: withoutPull ? 'overlap' : 'any' };
		if (!(await pull(t, true, guard))) {
			if (guard.blocked) {
				t.diagnostics.record({
					phase: 'upload',
					operation: 'pre-push-check',
					message: `Push stopped: ${guard.remoteCount} remote change(s), ${guard.conflicts?.length ?? 0} collision(s), mode ${guard.mode}`,
				});
				new Notice(blockedMessage(guard, withoutPull), 12000);
				return;
			}
			t.diagnostics.record({
				phase: 'upload',
				operation: 'pre-push-pull',
				message: 'Prerequisite pull failed before push could begin',
			});
			new Notice(
				'Push aborted: could not sync before pushing. Check diagnostics.',
				8000,
			);
			return;
		}
		unpulledRemoteChanges = (guard.remoteCount ?? 0) > 0;

		lastPhase = 'root-folder';
		if (!(await t.diagnostics.withContext('root-folder', 'verify-root-folder', () =>
			t.drive.getRootFolderId(true),
		))) {
			new Notice(
				'Push failed: could not verify the drive vault folder. Check diagnostics.',
				8000,
			);
			return;
		}

		const operations = Object.entries(t.settings.operations);

		const deletes = operations.filter(([_, op]) => op === 'delete');
		const creates = operations.filter(([_, op]) => op === 'create');
		const modifies = operations.filter(([_, op]) => op === 'modify');

		const pathsToIds = Object.fromEntries(
			Object.entries(t.settings.driveIdToPath).map(([id, path]) => [
				path,
				id,
			]),
		);

		const configOnDrive = await t.diagnostics.withContext(
			'list-files',
			'search-config-on-drive',
			async () => {
				lastPhase = 'list-files';
				return t.drive.searchFiles({
					include: ['properties'],
					matches: [{ properties: { config: 'true' } }],
				});
			},
		);
		if (!configOnDrive) {
			new Notice(
				'Push failed: could not fetch config files. Check diagnostics.',
				8000,
			);
			return;
		}

		await Promise.all(
			configOnDrive.map(async ({ properties }) => {
				const path = unSplitPath(properties);
				// Config files of this plugin itself are not managed by sync.
				if (isOwnPluginPath(t, path)) return;
				// A kind of settings file that is switched off is left alone on Drive.
				if (!isConfigPathSynced(t, path)) return;
				if (!(await adapter.exists(path))) {
					// Missing here is only a deletion if this device HAD the file (it pulled or
					// pushed it before). A device that never had it (a phone that has not pulled
					// yet, a vault joined later) must not remove it from Drive.
					if (t.settings.syncedFiles?.[path]) {
						deletes.push([path, 'delete']);
					}
				}
			}),
		);

		// A delete whose Drive file is not known (for example one that an interrupted Push already
		// deleted) has nothing left to do. Dropping it is the safe direction: Drive is not touched.
		for (let i = deletes.length - 1; i >= 0; i--) {
			const [path] = deletes[i] as [string, string];
			if (pathsToIds[path]) continue;
			delete t.settings.operations[path];
			deletes.splice(i, 1);
			t.diagnostics.record({
				phase: 'batch-delete',
				operation: 'delete-skipped',
				message: 'A pending delete was dropped: its file is no longer known on Drive',
			});
		}

		if (deletes.length) {
			const idsToDelete = deletes.map(([path]) => {
				const id = pathsToIds[path];
				return id;
			});
			if (idsToDelete.some((id) => !id)) {
				new Notice(
					'Push failed: could not identify all drive files to delete. Check diagnostics.',
					8000,
				);
				return;
			}

			const uniqueIds = [...new Set(idsToDelete as string[])];
			const deleteRequest = await t.diagnostics.withContext(
				'batch-delete',
				'batch-delete-drive-files',
				async () => {
					lastPhase = 'batch-delete';
					return t.drive.batchDelete(uniqueIds);
				},
			);
			if (!deleteRequest) {
				new Notice(
					'Push failed: could not delete drive files. Check diagnostics.',
					8000,
				);
				return;
			}
			uniqueIds.forEach((id) => delete t.settings.driveIdToPath[id]);
			// Done on Drive: forget the operations at the same moment as the ids.
			deletes.forEach(([path]) => delete t.settings.operations[path]);
			persist();

			syncNotice.setMessage(
				`Pushing... ${uniqueIds.length} file${uniqueIds.length === 1 ? '' : 's'} deleted`,
			);
		}

	if (creates.length) {
			await t.diagnostics.withContext('upload', 'create-and-upload-files', async () => {
				lastPhase = 'upload';
				let completed = 0;
				const files = creates.map(([path]) =>
					vault.getAbstractFileByPath(path),
				);

				const folders = files.filter((file) => file instanceof TFolder);

				if (folders.length) {
					const batches = foldersToBatches(folders);

					for (const batch of batches) {
						await batchAsync(
							batch.map((folder) => async () => {
								const id = await t.drive.createFolder({
									name: folder.name,
									parent: folder.parent
										? pathsToIds[folder.parent.path]
										: undefined,
									properties: splitPath(folder.path),
									modifiedTime: new Date().toISOString(),
								});
								if (!id) {
									new Notice(
										'Push failed: could not create drive folder. Check diagnostics.',
										8000,
									);
									return;
								}

								completed++;
								syncNotice.setMessage(
									`Pushing... uploading ${completed}/${files.length} files`,
								);

								t.settings.driveIdToPath[id] = folder.path;
								pathsToIds[folder.path] = id;
								delete t.settings.operations[folder.path];
								persist();
							}),
						);
					}
				}

				const notes = files.filter((file) => file instanceof TFile);

				await batchAsync(
					notes.map((note) => async () => {
						// Stamp taken before the read: an edit made during the upload still differs from it.
						const stamp = stampOf(note);
						const data = await vault.readBinary(note);
						const id = await t.drive.uploadFile(
							new Blob([data]),
							note.name,
							note.parent ? pathsToIds[note.parent.path] : undefined,
							{
								properties: splitPath(note.path),
								modifiedTime: new Date().toISOString(),
							},
						);
						if (!id) {
							new Notice(
								'Push failed: could not upload file to drive. Check diagnostics.',
								8000,
							);
							return;
						}

					completed++;
					syncNotice.setMessage(
						`Pushing... uploading ${completed}/${files.length} files`,
					);

					t.settings.driveIdToPath[id] = note.path;
					recordSynced(t, note.path, stamp, await hashOf(data));
					uploaded.push({ id, path: note.path, size: data.byteLength });
					delete t.settings.operations[note.path];
					persist();
				}),
			);
		});
	}

		if (modifies.length) {
			await t.diagnostics.withContext('update', 'update-modified-files', async () => {
				lastPhase = 'update';
				let completed = 0;

				const files = modifies
					.map(([path]) => vault.getFileByPath(path))
					.filter((file) => file instanceof TFile);

				const pathToId = Object.fromEntries(
					Object.entries(t.settings.driveIdToPath).map(([id, path]) => [
						path,
						id,
					]),
				);

				await batchAsync(
					files.map((file) => async () => {
						const stamp = stampOf(file);
						const data = await vault.readBinary(file);
						const id = await t.drive.updateFile(
							pathToId[file.path] as string,
							new Blob([data]),
							{ modifiedTime: new Date().toISOString() },
							file.path,
						);
					if (!id) {
						new Notice(
							'Push failed: could not update file on drive. Check diagnostics.',
							8000,
						);
							return;
						}

					completed++;
					syncNotice.setMessage(
						`Pushing... updating ${completed}/${files.length} files`,
					);
					recordSynced(t, file.path, stamp, await hashOf(data));
					uploaded.push({ id, path: file.path, size: data.byteLength });
					delete t.settings.operations[file.path];
					persist();
					}),
				);
			});
		}

		const configFilesToSync = await t.diagnostics.withContext(
			'config-sync',
			'get-config-files',
			async () => {
				lastPhase = 'config-sync';
				return t.drive.getConfigFilesToSync(
					new Set(configOnDrive.map(({ properties }) => unSplitPath(properties))),
				);
			},
		);

		const foldersToCreate = new Set<string>();
		configFilesToSync.forEach((path) => {
			const parts = path.split('/');
			for (let i = 1; i < parts.length; i++) {
				foldersToCreate.add(parts.slice(0, i).join('/'));
			}
		});

		foldersToCreate.forEach((folder) => {
			if (pathsToIds[folder]) foldersToCreate.delete(folder);
		});

		if (foldersToCreate.size) {
			const batches = foldersToBatches(Array.from(foldersToCreate));

			for (const batch of batches) {
				await batchAsync(
					batch.map((folder) => async () => {
						const id = await t.drive.createFolder({
							name: folder.split('/').pop() || '',
							parent: pathsToIds[
								folder.split('/').slice(0, -1).join('/')
							],
							properties: {
								...splitPath(folder),
								config: 'true',
							},
							modifiedTime: new Date().toISOString(),
						});
						if (!id) {
							new Notice(
								'Push failed: could not create config folder. Check diagnostics.',
								8000,
							);
								return;
							}

						t.settings.driveIdToPath[id] = folder;
						pathsToIds[folder] = id;
					}),
				);
			}
		}

		await batchAsync(
			configFilesToSync.map((path) => async () => {
				const configData = await adapter.readBinary(path);
				if (pathsToIds[path]) {
					await t.drive.updateFile(
						pathsToIds[path],
						new Blob([configData]),
						{ modifiedTime: new Date().toISOString() },
						path,
					);
					await recordSyncedFromDisk(t, path, configData);
					return;
				}

				const id = await t.drive.uploadFile(
					new Blob([configData]),
					fileNameFromPath(path),
					pathsToIds[path.split('/').slice(0, -1).join('/')],
					{
						properties: { ...splitPath(path), config: 'true' },
						modifiedTime: new Date().toISOString(),
					},
				);
			if (!id) {
				new Notice(
					'Push failed: could not upload config file. Check diagnostics.',
					8000,
				);
					return;
				}

				t.settings.driveIdToPath[id] = path;
				pathsToIds[path] = id;
				await recordSyncedFromDisk(t, path, configData);
			}),
		);

		t.settings.operations = {};
		allUploaded = true;

		// Version history: one restore point per Push. Never fails the Push (see history.ts).
		if (t.settings.historyEnabled === true) {
			syncNotice.setMessage('Pushing... saving restore point');
			await recordRestorePointAfterPush(t);
		}

		let verified = '';
		if (uploaded.length) {
			syncNotice.setMessage('Pushing... checking the uploaded files on Drive');
			verified = verifySummary(
				await verifyUploads(t, uploaded),
				t.settings.e2eeEnabled === true,
			);
		}

		const ended = unpulledRemoteChanges
			? await t.endSync(syncNotice, false, false)
			: await t.endSync(syncNotice, false);
		if (!ended) return;

		await t.saveLog(t.diagnostics.getEntries());
		const totalFiles = creates.length + modifies.length;
		if (!totalFiles && !deletes.length) {
			new Notice(
				'Nothing to push: no changes were detected on this device since the last sync. If you edited a note, run the doctor command.',
				8000,
			);
			return;
		}
		new Notice(
			`Push complete — ${totalFiles} file${totalFiles === 1 ? '' : 's'} synced.` +
				(unpulledRemoteChanges
					? ' Google Drive has newer changes that were not pulled: press Pull next.'
					: '') +
				verified,
			verified ? 12000 : undefined,
		);
	} catch (error) {
		t.diagnostics.record({
			phase: lastPhase,
			operation: 'push-unknown',
			message: sanitizeMessage(error),
			stack: error instanceof Error ? error.stack : undefined,
		});
		const pending = Object.keys(t.settings.operations).length;
		new Notice(
			allUploaded
				? `Push failed during ${lastPhase}, after everything was uploaded (the connection may have dropped). Press Push again: nothing will be uploaded twice. Use "Copy diagnostics" for details.`
				: uploaded.length || pending
					? `Push failed during ${lastPhase}. ${uploaded.length} file${uploaded.length === 1 ? ' was' : 's were'} uploaded before it stopped and ${pending} change${pending === 1 ? ' is' : 's are'} still pending. Press Push again once the problem is fixed. Use "Copy diagnostics" for details.`
					: `Push failed during ${lastPhase}. Use "Copy diagnostics" for details.`,
			12000,
		);
		try {
			await t.saveSettings();
		} catch {
			// best effort
		}
		console.error('Google Drive push failed', error);
	} finally {
		if (t.syncing) t.abortSync(syncNotice);
	}
};
