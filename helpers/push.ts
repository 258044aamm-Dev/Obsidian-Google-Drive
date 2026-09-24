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
import type { SyncPhase } from './diagnostics';
import { sanitizeMessage } from './diagnostics';

export class ConfirmPushModal extends Modal {
	proceed: (res: boolean) => void;

	constructor(
		t: ObsidianGoogleDrive,
		initialOperations: [string, 'create' | 'delete' | 'modify'][],
		proceed: (res: boolean) => void,
	) {
		super(t.app);
		this.proceed = proceed;

		this.setTitle('Push confirmation');
		this.contentEl
			.createEl('p')
			.setText(
				'Do you want to push the following changes to Google Drive:',
			);
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
					.getFile(this.filePathToId[path] as string)
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
				.getFile(this.filePathToId[path] as string)
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
) => {
	if (t.syncing) return;
	const initialOperations = Object.entries(t.settings.operations).sort(
		([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
	); // Alphabetical

	const { vault } = t.app;
	const adapter = vault.adapter;

	const proceed =
		skipConfirmation ||
		(await new Promise<boolean>((resolve) => {
			new ConfirmPushModal(t, initialOperations, resolve).open();
		}));

	if (!proceed) return;

	const syncNotice = await t.startSync('Pushing to Google Drive');

	let lastPhase: SyncPhase = 'upload';

	try {
		if (!(await pull(t, true))) {
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
				if (!(await adapter.exists(path))) {
					deletes.push([path, 'delete']);
				}
			}),
		);

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
							}),
						);
					}
				}

				const notes = files.filter((file) => file instanceof TFile);

				await batchAsync(
					notes.map((note) => async () => {
						const id = await t.drive.uploadFile(
							new Blob([await vault.readBinary(note)]),
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
						const id = await t.drive.updateFile(
							pathToId[file.path] as string,
							new Blob([await vault.readBinary(file)]),
							{ modifiedTime: new Date().toISOString() },
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
					}),
				);
			});
		}

		const configFilesToSync = await t.diagnostics.withContext(
			'config-sync',
			'get-config-files',
			async () => {
				lastPhase = 'config-sync';
				return t.drive.getConfigFilesToSync();
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
				if (pathsToIds[path]) {
					await t.drive.updateFile(
						pathsToIds[path],
						new Blob([await adapter.readBinary(path)]),
						{ modifiedTime: new Date().toISOString() },
					);
					return;
				}

				const id = await t.drive.uploadFile(
					new Blob([await adapter.readBinary(path)]),
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
			}),
		);

		await t.drive.updateFile(
			pathsToIds[
				vault.configDir + '/plugins/google-drive-sync/data.json'
			] as string,
			new Blob([JSON.stringify(t.settings, null, 2)]),
			{ modifiedTime: new Date().toISOString() },
		);

		t.settings.operations = {};

		if (!(await t.endSync(syncNotice, false))) return;

		await t.saveLog(t.diagnostics.getEntries());
		const totalFiles = creates.length + modifies.length;
		new Notice(
			`Push complete — ${totalFiles} file${totalFiles === 1 ? '' : 's'} synced.`,
		);
	} catch (error) {
		t.diagnostics.record({
			phase: lastPhase,
			operation: 'push-unknown',
			message: sanitizeMessage(error),
			stack: error instanceof Error ? error.stack : undefined,
		});
		new Notice(
			`Push failed during ${lastPhase}. Use "Copy diagnostics" for details.`,
			8000,
		);
		console.error('Google Drive push failed', error);
	} finally {
		if (t.syncing) t.abortSync(syncNotice);
	}
};
