import { describe, expect, it, vi } from 'vitest';

vi.stubGlobal('window', globalThis);

vi.mock('obsidian', () => {
	class TAbstractFile {
		path: string;
		constructor(path: string) {
			this.path = path;
		}
	}
	class TFile extends TAbstractFile {}
	return {
		App: class {},
		Menu: class {},
		Modal: class {},
		Notice: class {},
		Plugin: class {},
		PluginSettingTab: class {},
		Setting: class {},
		TAbstractFile,
		TFile,
		TFolder: class extends TAbstractFile {},
		debounce: (callback: unknown) => callback,
		requestUrl: vi.fn(),
		setIcon: vi.fn(),
	};
});

vi.mock('../helpers/requests', () => ({
	refreshAccessToken: vi.fn(async () => ({ token: 'token', expiresAt: Date.now() + 3_600_000 })),
}));

import { TFile } from 'obsidian';
import ObsidianGoogleDrive from '../main';

const createPlugin = () =>
	Object.assign(Object.create(ObsidianGoogleDrive.prototype), {
		settings: {
			refreshToken: 'refresh',
			accessTokenUrl: 'https://ogd-server.richardxiong.com/api/access',
			autoPush: false,
			operations: {},
			driveIdToPath: {},
			rootFolderId: '',
			lastSyncedAt: 0,
			changesToken: 'old-token',
			enableDiagnostics: false,
			maskFilePaths: true,
			lastInstalledVersion: '',
		},
		manifest: { version: '3.0.0' },
		accessToken: { token: '', expiresAt: 0 },
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
		debouncedSaveSettings: vi.fn(),
		saveSettings: vi.fn(async () => undefined),
		ribbonIcon: {
			addClass: vi.fn(),
			removeClass: vi.fn(),
		},
		drive: {
			searchFiles: vi.fn(async () => []),
			getConfigFilesToSync: vi.fn(async () => []),
			getChangesStartToken: vi.fn(async () => 'new-token'),
		},
		app: {
			vault: {
				adapter: {
					readBinary: vi.fn(),
					writeBinary: vi.fn(),
				},
			},
		},
		syncing: true,
	}) as ObsidianGoogleDrive;

describe('ObsidianGoogleDrive operation tracking', () => {
	it('turns recreation of a deleted file into a modification', () => {
		const plugin = createPlugin();
		plugin.settings.operations['note.md'] = 'delete';
		const file = new TFile();
		Object.assign(file, { path: 'note.md' });

		plugin.handleCreate(file);

		expect(plugin.settings.operations['note.md']).toBe('modify');
	});

	it('debounces automatic push scheduling after local changes', () => {
		const setTimeout = vi
			.spyOn(window, 'setTimeout')
			.mockReturnValue(1 as never);
		const clearTimeout = vi.spyOn(window, 'clearTimeout');
		const plugin = createPlugin();
		plugin.syncing = false;
		plugin.settings.autoPush = true;
		const file = new TFile();
		Object.assign(file, { path: 'note.md' });

		plugin.handleModify(file);
		plugin.handleModify(file);

		expect(setTimeout).toHaveBeenCalledTimes(2);
		expect(setTimeout).toHaveBeenLastCalledWith(
			expect.any(Function),
			60_000,
		);
		expect(clearTimeout).toHaveBeenCalledWith(1);
		plugin.clearAutoPushTimer();
		expect(clearTimeout).toHaveBeenCalledTimes(2);
	});

	it('does not schedule automatic pushes while syncing or disabled', () => {
		const setTimeout = vi.spyOn(window, 'setTimeout');
		const plugin = createPlugin();
		plugin.settings.operations['note.md'] = 'modify';

		plugin.scheduleAutoPush();
		expect(setTimeout).not.toHaveBeenCalled();

		plugin.settings.autoPush = true;
		plugin.scheduleAutoPush();
		expect(setTimeout).not.toHaveBeenCalled();
	});

	it('cancels a pending create when the file is deleted', () => {
		const plugin = createPlugin();
		plugin.settings.operations['note.md'] = 'create';
		const file = new TFile();
		Object.assign(file, { path: 'note.md' });

		plugin.handleDelete(file);

		expect(plugin.settings.operations).not.toHaveProperty('note.md');
	});
});

describe('ObsidianGoogleDrive sync lifecycle', () => {
	it('stores a new checkpoint only after it is available', async () => {
		vi.spyOn(Date, 'now').mockReturnValue(1234);
		const plugin = createPlugin();

		await expect(plugin.endSync(undefined, false)).resolves.toBe(true);

		expect(plugin.settings.lastSyncedAt).toBe(1234);
		expect(plugin.settings.changesToken).toBe('new-token');
		expect(plugin.saveSettings).toHaveBeenCalledOnce();
		expect(plugin.syncing).toBe(false);
	});

	it('leaves the previous checkpoint intact when fetching one fails', async () => {
		const plugin = createPlugin();
		plugin.drive.getChangesStartToken = vi.fn(async () => undefined);

		await expect(plugin.endSync(undefined, false)).resolves.toBe(false);

		expect(plugin.settings.lastSyncedAt).toBe(0);
		expect(plugin.settings.changesToken).toBe('old-token');
		expect(plugin.saveSettings).not.toHaveBeenCalled();
		expect(plugin.syncing).toBe(false);
	});
});

describe('compareVersions', () => {
	it('returns 0 for equal versions', () => {
		const plugin = createPlugin();
		expect(plugin.compareVersions('3.0.0', '3.0.0')).toBe(0);
	});

	it('returns negative when first version is lower', () => {
		const plugin = createPlugin();
		expect(plugin.compareVersions('2.5.0', '3.0.0')).toBeLessThan(0);
	});

	it('returns positive when first version is higher', () => {
		const plugin = createPlugin();
		expect(plugin.compareVersions('3.1.0', '3.0.0')).toBeGreaterThan(0);
	});
});

describe('checkAndMigrate', () => {
	it('migrates when previous version is empty and driveIdToPath has entries', async () => {
		const plugin = createPlugin();
		plugin.settings.driveIdToPath = { 'old-id': 'old-path.md' };
		(plugin.drive.searchFiles as ReturnType<typeof vi.fn>) = vi.fn(async () => [
			{ id: 'new-id', properties: { path: 'new-path.md' } },
		]);

		await plugin.checkAndMigrate();

		expect(plugin.drive.searchFiles).toHaveBeenCalled();
		expect(plugin.settings.driveIdToPath).toEqual({
			'new-id': 'new-path.md',
		});
		expect(plugin.settings.lastInstalledVersion).toBe('3.0.0');
	});

	it('migrates when previous version is below 3.0.0', async () => {
		const plugin = createPlugin();
		plugin.settings.lastInstalledVersion = '2.5.0';
		(plugin.drive.searchFiles as ReturnType<typeof vi.fn>) = vi.fn(async () => [
			{ id: 'id1', properties: { path: 'file.md' } },
		]);

		await plugin.checkAndMigrate();

		expect(plugin.drive.searchFiles).toHaveBeenCalled();
		expect(plugin.settings.lastInstalledVersion).toBe('3.0.0');
	});

	it('skips migration when previous version is empty and driveIdToPath is empty', async () => {
		const plugin = createPlugin();
		plugin.drive.searchFiles = vi.fn(async () => []);

		await plugin.checkAndMigrate();

		expect(plugin.drive.searchFiles).not.toHaveBeenCalled();
		expect(plugin.settings.lastInstalledVersion).toBe('3.0.0');
	});

	it('skips migration when previous version is 3.0.0 or higher', async () => {
		const plugin = createPlugin();
		plugin.settings.lastInstalledVersion = '3.0.0';
		plugin.drive.searchFiles = vi.fn(async () => []);

		await plugin.checkAndMigrate();

		expect(plugin.drive.searchFiles).not.toHaveBeenCalled();
		expect(plugin.settings.lastInstalledVersion).toBe('3.0.0');
	});

	it('does not save lastInstalledVersion when migration fails', async () => {
		const plugin = createPlugin();
		plugin.settings.lastInstalledVersion = '2.0.0';
		plugin.drive.searchFiles = vi.fn(async () => undefined);

		await plugin.checkAndMigrate();

		expect(plugin.settings.lastInstalledVersion).toBe('2.0.0');
	});

	it('preserves operations during migration', async () => {
		const plugin = createPlugin();
		plugin.settings.lastInstalledVersion = '2.0.0';
		plugin.settings.operations = { 'pending.md': 'create' };
		(plugin.drive.searchFiles as ReturnType<typeof vi.fn>) = vi.fn(async () => [
			{ id: 'id1', properties: { path: 'file.md' } },
		]);

		await plugin.checkAndMigrate();

		expect(plugin.settings.operations).toEqual({ 'pending.md': 'create' });
		expect(plugin.settings.driveIdToPath).toEqual({
			id1: 'file.md',
		});
	});
});
