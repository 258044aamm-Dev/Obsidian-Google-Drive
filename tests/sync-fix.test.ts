import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubGlobal('window', globalThis);

interface TrackedNotice {
	message: string;
	hidden: boolean;
}

const createdNotices = vi.hoisted(() => [] as TrackedNotice[]);

vi.mock('obsidian', () => {
	class TAbstractFile {
		path = '';
	}
	class TFile extends TAbstractFile {}
	class TFolder extends TAbstractFile {}
	class Notice {
		message: string;
		hidden = false;
		entry: TrackedNotice;
		constructor(message: string, _timeout?: number) {
			this.message = message;
			this.entry = { message, hidden: false };
			createdNotices.push(this.entry);
		}
		hide() {
			this.hidden = true;
			this.entry.hidden = true;
		}
		setMessage(message: string) {
			this.message = message;
			this.entry.message = message;
		}
	}
	return {
		App: class {},
		Menu: class {},
		Modal: class {},
		Notice,
		Plugin: class {},
		PluginSettingTab: class {},
		Setting: class {},
		TAbstractFile,
		TFile,
		TFolder,
		debounce: (callback: unknown) => callback,
		requestUrl: vi.fn(async () => ({ status: 204 })),
		setIcon: vi.fn(),
	};
});

import ObsidianGoogleDrive from '../main';
import { push } from '../helpers/push';
import { pull } from '../helpers/pull';
import { DiagnosticsManager } from '../helpers/diagnostics';

const createPlugin = () => {
	const mkdir = vi.fn(async (_path: string) => undefined);
	const write = vi.fn(async (_path: string, _data: string) => undefined);
	const writeBinary = vi.fn(
		async (
			_path: string,
			_data: ArrayBuffer,
			_options?: { mtime?: number },
		) => undefined,
	);
	const adapter = {
		exists: vi.fn(async () => false),
		mkdir,
		write,
		writeBinary,
		readBinary: vi.fn(async () => new ArrayBuffer(0)),
		stat: vi.fn(async () => undefined),
		list: vi.fn(async () => ({ files: [], folders: [] })),
		remove: vi.fn(async () => undefined),
	};
	const plugin = Object.assign(Object.create(ObsidianGoogleDrive.prototype), {
		settings: {
			refreshToken: 'refresh',
			accessTokenUrl: '',
			clientId: '',
			clientSecret: '',
			autoPush: false,
			operations: {},
			driveIdToPath: {},
			rootFolderId: 'root-id',
			lastSyncedAt: 0,
			changesToken: 'changes',
			enableDiagnostics: false,
			maskFilePaths: true,
			lastInstalledVersion: '3.1.1',
		},
		accessToken: { token: 'access', expiresAt: Date.now() + 3_600_000 },
		debouncedSaveSettings: vi.fn(),
		saveSettings: vi.fn(async () => undefined),
		ribbonIcon: { addClass: vi.fn(), removeClass: vi.fn() },
		diagnostics: new DiagnosticsManager(),
		drive: {
			searchFiles: vi.fn(async () => [] as unknown[]),
			getChanges: vi.fn(
				async () => [] as { removed: boolean; fileId: string }[],
			),
		},
		app: {
			vault: {
				configDir: 'config',
				adapter,
				getAllLoadedFiles: vi.fn(() => [] as { path: string }[]),
				getAbstractFileByPath: vi.fn(() => null),
				getFileByPath: vi.fn(() => null),
				getFolderByPath: vi.fn(() => null),
			},
		},
		syncing: false,
	}) as unknown as ObsidianGoogleDrive & {
		drive: {
			searchFiles: ReturnType<typeof vi.fn>;
			getChanges: ReturnType<typeof vi.fn>;
		};
	};
	return { plugin, mkdir, write, writeBinary };
};

describe('sync lifecycle regression tests', () => {
	beforeEach(() => {
		createdNotices.length = 0;
	});

	it('hides the push progress notice when its nested silent pull fails', async () => {
		const { plugin } = createPlugin();
		plugin.drive.searchFiles.mockRejectedValue(
			new Error('net::ERR_CONNECTION_RESET'),
		);

		await push(plugin, true);

		const progress = createdNotices.find(
			(n) => n.message === 'Pushing to Google Drive...',
		);
		expect(progress).toBeTruthy();
		expect(progress?.hidden).toBe(true);

		const visible = createdNotices.filter((n) => !n.hidden).map((n) => n.message);
		expect(visible).toEqual([
			'Push aborted: could not sync before pushing. Check diagnostics.',
		]);
		expect(plugin.syncing).toBe(false);
	});

	it('hides its own progress notice when a user-initiated pull fails', async () => {
		const { plugin } = createPlugin();
		plugin.drive.searchFiles.mockRejectedValue(
			new Error('net::ERR_CONNECTION_RESET'),
		);

		await expect(pull(plugin)).resolves.toBe(false);

		const progress = createdNotices.find(
			(n) => n.message === 'Pulling from Google Drive...',
		);
		expect(progress).toBeTruthy();
		expect(progress?.hidden).toBe(true);

		const visible = createdNotices.filter((n) => !n.hidden).map((n) => n.message);
		expect(visible).toEqual([
			'Pull failed during list-files. Use "Copy diagnostics" for details.',
		]);
		expect(plugin.syncing).toBe(false);
	});

	it('creates the logs directory before saving a sync log', async () => {
		const { plugin, mkdir, write } = createPlugin();
		plugin.diagnostics.enabled = true;
		plugin.diagnostics.record({
			phase: 'download',
			operation: 'download-and-write-files',
			message: 'ENOENT: no such file or directory (example)',
		});
		expect(plugin.diagnostics.getEntries()).toHaveLength(1);

		await plugin.saveLog(plugin.diagnostics.getEntries());

		expect(mkdir).toHaveBeenCalledWith(
			'config/plugins/google-drive-sync/logs',
		);
		expect(write).toHaveBeenCalledTimes(1);
		const loggedPath = write.mock.calls[0]?.[0];
		expect(loggedPath).toContain('sync-log-');
		expect(loggedPath?.endsWith('.md')).toBe(true);
	});
});
