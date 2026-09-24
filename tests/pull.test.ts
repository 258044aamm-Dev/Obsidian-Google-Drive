import { beforeEach, describe, expect, it, vi } from 'vitest';

const notices = vi.hoisted(() => [] as string[]);

vi.mock('obsidian', () => {
	class TFile {
		path: string;
		constructor(path: string) {
			this.path = path;
		}
	}
	class TFolder {
		path: string;
		children: { path: string }[] = [];
		constructor(path: string) {
			this.path = path;
		}
	}
	return {
		Notice: class {
			constructor(message: string) {
				notices.push(message);
			}
		},
		requestUrl: vi.fn(),
		TAbstractFile: class {},
		TFile,
		TFolder,
	};
});

import { pull } from '../helpers/pull';
import { TFile } from 'obsidian';

const createPlugin = () => {
	const adapter = {
		exists: vi.fn(async () => false),
		stat: vi.fn(
			async (
				_path: string,
			): Promise<{ type: 'file' | 'folder' } | undefined> =>
				undefined,
		),
		trashLocal: vi.fn(async () => true),
		trashSystem: vi.fn(async () => true),
		remove: vi.fn(async () => undefined),
		list: vi.fn(async () => ({ files: [], folders: [] })),
		rmdir: vi.fn(async () => undefined),
	};
	const vault = {
		adapter,
		configDir: 'config',
		getAllLoadedFiles: vi.fn((): { path: string }[] => []),
		getAbstractFileByPath: vi.fn(
			(_path: string): TFile | null => null,
		),
		getFileByPath: vi.fn((_path: string) => null),
		getFolderByPath: vi.fn((_path: string) => null),
		getConfig: vi.fn(() => 'local'),
	};
	return {
		accessToken: { token: 'access', expiresAt: Date.now() + 3_600_000 },
		app: { vault },
		settings: {
			lastSyncedAt: 0,
			changesToken: 'changes',
			driveIdToPath: {} as Record<string, string>,
			operations: {} as Record<string, 'create' | 'delete' | 'modify'>,
		},
		drive: {
			searchFiles: vi.fn(
				async (): Promise<unknown[] | undefined> => [],
			),
			getChanges: vi.fn(
				async (): Promise<{ removed: boolean; fileId: string }[]> => [],
			),
			deleteFilesMinimumOperations: vi.fn(async () => undefined),
			getFile: vi.fn(),
		},
		abortSync: vi.fn(),
		startSync: vi.fn(async () => ({ setMessage: vi.fn(), hide: vi.fn() })),
		saveLog: vi.fn(async () => undefined),
		endSync: vi.fn(async () => true),
		createFolder: vi.fn(),
		modifyFile: vi.fn(),
		upsertFile: vi.fn(),
		diagnostics: {
			enabled: false,
			currentPhase: null,
			withContext: vi.fn(
				async (_p: string, _o: string, fn: () => Promise<unknown>) =>
					fn(),
			),
			record: vi.fn(),
			getEntries: vi.fn(() => []),
		},
	};
};

describe('pull', () => {
	beforeEach(() => {
		notices.length = 0;
	});

	it('finishes a silent no-change pull without advancing the checkpoint itself', async () => {
		const plugin = createPlugin();

		await expect(pull(plugin as never, true)).resolves.toBe(true);

		expect(plugin.endSync).not.toHaveBeenCalled();
		expect(plugin.abortSync).not.toHaveBeenCalled();
	});

	it('leaves cleanup to the caller when a silent pull cannot list Drive files', async () => {
		const plugin = createPlugin();
		plugin.drive.searchFiles.mockResolvedValueOnce(undefined);

		await expect(pull(plugin as never, true)).resolves.toBe(false);

		expect(plugin.abortSync).not.toHaveBeenCalled();
	});

	it('aborts a user-initiated pull when Drive files cannot be listed', async () => {
		const plugin = createPlugin();
		const syncNotice = { setMessage: vi.fn(), hide: vi.fn() };
		plugin.startSync = vi.fn(async () => syncNotice);
		plugin.drive.searchFiles.mockResolvedValueOnce(undefined);

		await expect(pull(plugin as never)).resolves.toBe(false);

		expect(plugin.abortSync).toHaveBeenCalledOnce();
		expect(plugin.abortSync).toHaveBeenCalledWith(syncNotice);
	});

	it('reconciles creates, deletes, and renames made while Obsidian was closed', async () => {
		const plugin = createPlugin();
		plugin.settings.driveIdToPath = {
			'old-id': 'old.md',
			'stable-id': 'stable.md',
		};
		plugin.app.vault.getAllLoadedFiles.mockReturnValue([
			{ path: '/' },
			{ path: 'renamed.md' },
			{ path: 'stable.md' },
		]);

		await expect(pull(plugin as never, true)).resolves.toBe(true);

		expect(plugin.settings.operations).toEqual({
			'old.md': 'delete',
			'renamed.md': 'create',
		});
	});

	it('cleans stale operations while preserving config operations', async () => {
		const plugin = createPlugin();
		plugin.settings.driveIdToPath = {
			'stable-id': 'stable.md',
			'missing-id': 'missing.md',
		};
		plugin.settings.operations = {
			'ghost.md': 'create',
			'stable.md': 'delete',
			'missing.md': 'modify',
			'config/plugins/example/data.json': 'modify',
		};
		plugin.app.vault.getAllLoadedFiles.mockReturnValue([
			{ path: '/' },
			{ path: 'stable.md' },
		]);

		await expect(pull(plugin as never, true)).resolves.toBe(true);

		expect(plugin.settings.operations).toEqual({
			'stable.md': 'modify',
			'missing.md': 'delete',
			'config/plugins/example/data.json': 'modify',
		});
	});

	it('uses the preserved ID mapping to trash a remotely deleted config file', async () => {
		const plugin = createPlugin();
		const path = 'config/plugins/example/data.json';
		plugin.settings.driveIdToPath['drive-id'] = path;
		plugin.drive.getChanges.mockResolvedValueOnce([
			{ removed: true, fileId: 'drive-id' },
		]);
		plugin.app.vault.adapter.stat.mockResolvedValueOnce({ type: 'file' });

		await expect(pull(plugin as never, true)).resolves.toBe(true);

		expect(plugin.app.vault.adapter.trashLocal).toHaveBeenCalledWith(path);
		expect(plugin.settings.driveIdToPath).not.toHaveProperty('drive-id');
	});

	it('pulls folders and files while applying regular and config deletions', async () => {
		const plugin = createPlugin();
		const deletedFile = new TFile();
		Object.assign(deletedFile, { path: 'deleted.md' });
		const configPath = 'config/plugins/example/data.json';
		plugin.settings.driveIdToPath = {
			'deleted-id': deletedFile.path,
			'config-id': configPath,
		};
		plugin.app.vault.getAbstractFileByPath.mockImplementation(
			(path: string) => (path === deletedFile.path ? deletedFile : null),
		);
		plugin.app.vault.getAllLoadedFiles.mockReturnValue([
			{ path: deletedFile.path },
		]);
		plugin.app.vault.adapter.stat.mockImplementation(async (path: string) =>
			path === configPath ? { type: 'file' as const } : undefined,
		);
		plugin.drive.searchFiles.mockResolvedValueOnce([
			{
				id: 'folder-id',
				mimeType: 'application/vnd.google-apps.folder',
				properties: { path: 'remote' },
				modifiedTime: '2025-01-01T00:00:00.000Z',
			},
			{
				id: 'note-id',
				mimeType: 'text/markdown',
				properties: { path: 'remote/note.md' },
				modifiedTime: '2025-01-01T00:00:00.000Z',
			},
		]);
		plugin.drive.getChanges.mockResolvedValueOnce([
			{ removed: true, fileId: 'deleted-id' },
			{ removed: true, fileId: 'config-id' },
		]);
		plugin.drive.getFile.mockReturnValue({
			arrayBuffer: vi.fn(async () => new ArrayBuffer(4)),
		});

		await expect(pull(plugin as never, true)).resolves.toBe(true);

		expect(plugin.drive.deleteFilesMinimumOperations).toHaveBeenCalledWith([
			deletedFile,
		]);
		expect(plugin.createFolder).toHaveBeenCalledWith('remote');
		expect(plugin.upsertFile).toHaveBeenCalledWith(
			'remote/note.md',
			expect.any(ArrayBuffer),
			'2025-01-01T00:00:00.000Z',
		);
		expect(plugin.app.vault.adapter.trashLocal).toHaveBeenCalledWith(
			configPath,
		);
		expect(plugin.settings.driveIdToPath).toEqual({
			'folder-id': 'remote',
			'note-id': 'remote/note.md',
		});
	});

	it('creates missing ancestor folders for pulled files even when the Drive folder is stale', async () => {
		const plugin = createPlugin();
		plugin.drive.searchFiles.mockResolvedValueOnce([
			{
				id: 'manifest-id',
				mimeType: 'application/json',
				properties: { path: 'config/plugins/pdf-writer/manifest.json' },
				modifiedTime: '2025-01-01T00:00:00.000Z',
			},
			{
				id: 'main-id',
				mimeType: 'text/javascript',
				properties: { path: 'config/plugins/pdf-writer/main.js' },
				modifiedTime: '2025-01-01T00:00:00.000Z',
			},
		]);
		plugin.drive.getFile.mockReturnValue({
			arrayBuffer: vi.fn(async () => new ArrayBuffer(4)),
		});

		await expect(pull(plugin as never, true)).resolves.toBe(true);

		expect(plugin.createFolder).toHaveBeenCalledWith(
			'config/plugins/pdf-writer',
		);
		expect(plugin.upsertFile).toHaveBeenCalledWith(
			'config/plugins/pdf-writer/manifest.json',
			expect.any(ArrayBuffer),
			'2025-01-01T00:00:00.000Z',
		);
		expect(plugin.upsertFile).toHaveBeenCalledWith(
			'config/plugins/pdf-writer/main.js',
			expect.any(ArrayBuffer),
			'2025-01-01T00:00:00.000Z',
		);
	});

	it('clears a pending delete operation for a recreated ancestor folder', async () => {
		const plugin = createPlugin();
		plugin.settings.driveIdToPath = { 'folder-id': 'Notes/New' };
		plugin.drive.searchFiles.mockResolvedValueOnce([
			{
				id: 'file-id',
				mimeType: 'text/markdown',
				properties: { path: 'Notes/New/note.md' },
				modifiedTime: '2025-01-01T00:00:00.000Z',
			},
		]);
		plugin.drive.getFile.mockReturnValue({
			arrayBuffer: vi.fn(async () => new ArrayBuffer(4)),
		});

		await expect(pull(plugin as never, true)).resolves.toBe(true);

		expect(plugin.settings.operations).not.toHaveProperty('Notes/New');
		expect(plugin.createFolder).toHaveBeenCalledWith('Notes');
		expect(plugin.createFolder).toHaveBeenCalledWith('Notes/New');
		expect(plugin.upsertFile).toHaveBeenCalledWith(
			'Notes/New/note.md',
			expect.any(ArrayBuffer),
			'2025-01-01T00:00:00.000Z',
		);
	});

	it('shows the correct completion message after syncing files', async () => {
		const syncNotice = { setMessage: vi.fn(), hide: vi.fn() };
		const plugin = createPlugin();
		plugin.startSync = vi.fn(async () => syncNotice);
		plugin.drive.searchFiles
			.mockResolvedValueOnce([
				{
					id: 'file-id',
					mimeType: 'text/markdown',
					properties: { path: 'note.md' },
					modifiedTime: '2025-01-01T00:00:00.000Z',
				},
			])
			.mockResolvedValueOnce([]);
		plugin.drive.getChanges.mockResolvedValueOnce([]);
		plugin.drive.getFile.mockReturnValue({
			arrayBuffer: vi.fn(async () => new ArrayBuffer(4)),
		});

		const result = await pull(plugin as never, false);

		expect(result).toBe(true);
		expect(notices).toContainEqual(
			expect.stringContaining('Pull complete — 1 file synced'),
		);
	});

	it('shows the correct message when there are no changes to pull', async () => {
		const syncNotice = { setMessage: vi.fn(), hide: vi.fn() };
		const plugin = createPlugin();
		plugin.startSync = vi.fn(async () => syncNotice);
		plugin.settings.lastSyncedAt = Date.now();

		const result = await pull(plugin as never, false);

		expect(result).toBe(true);
		expect(notices).toContainEqual(
			expect.stringContaining('Pull complete — already up to date'),
		);
	});
});
