import { checkConnection, getDriveClient, unSplitPath } from './helpers/drive';
import { refreshAccessToken } from './helpers/requests';
import { pull } from './helpers/pull';
import { push } from './helpers/push';
import { reset } from './helpers/reset';
import {
	App,
	debounce,
	Notice,
	Plugin,
	PluginSettingTab,
	type SettingDefinitionItem,
	TAbstractFile,
	TFile,
} from 'obsidian';
import { fixDrivePath } from './helpers/fix_drive_path';
import { DiagnosticsManager, sanitizeMessage } from './helpers/diagnostics';
import type { DiagnosticEntry, SyncPhase } from './helpers/diagnostics';

interface PluginSettings {
	refreshToken: string;
	clientId: string;
	clientSecret: string;
	accessTokenUrl: string;
	autoPush: boolean;
	operations: Record<string, 'create' | 'delete' | 'modify'>;
	driveIdToPath: Record<string, string>;
	rootFolderId: string;
	lastSyncedAt: number;
	changesToken: string;
	enableDiagnostics: boolean;
	maskFilePaths: boolean;
	lastInstalledVersion: string;
}

const DEFAULT_SETTINGS: PluginSettings = {
	refreshToken: '',
	clientId: '',
	clientSecret: '',
	accessTokenUrl: '',
	autoPush: false,
	operations: {},
	driveIdToPath: {},
	rootFolderId: '',
	lastSyncedAt: 0,
	changesToken: '',
	enableDiagnostics: false,
	maskFilePaths: true,
	lastInstalledVersion: '',
};

export default class ObsidianGoogleDrive extends Plugin {
	settings!: PluginSettings;
	diagnostics = new DiagnosticsManager();
	accessToken = {
		token: '',
		expiresAt: 0,
	};
	drive = getDriveClient(this);
	ribbonIcon!: HTMLElement;
	syncing!: boolean;
	autoPushTimer?: number;

	async onload() {
		const { vault } = this.app;

		await this.loadSettings();
		this.diagnostics.enabled = this.settings.enableDiagnostics;
		this.diagnostics.maskPaths = this.settings.maskFilePaths;

		this.addSettingTab(new SettingsTab(this.app, this));

		if (!this.settings.refreshToken) {
			new Notice(
				"Please add your refresh token to Google Drive sync through our website or our readme/this plugin's settings. If you haven't already, please read through this plugin's readme or website for instructions on how to use this plugin. Be careful of your first sync, and make sure to back up your data before your first sync.",
				10000,
			);
			return;
		}

		await this.checkAndMigrate();

		this.ribbonIcon = this.addRibbonIcon(
			'refresh-cw',
			'Push to Google Drive',
			() => {
				if (this.syncing) return;
				void push(this);
			},
		);

		this.addCommand({
			id: 'push',
			name: 'Push to Google Drive',
			callback: () => push(this),
		});

		this.addCommand({
			id: 'pull',
			name: 'Pull from Google Drive',
			callback: () => pull(this),
		});

		this.addCommand({
			id: 'reset',
			name: 'Reset local vault to Google Drive',
			callback: () => reset(this),
		});

		this.addCommand({
			id: 'fix-drive-path',
			name: 'Fix Google Drive paths',
			callback: () => fixDrivePath(this),
		});

		this.addCommand({
			id: 'export-diagnostics',
			name: 'Copy sync diagnostics to clipboard',
			callback: () => {
				void navigator.clipboard.writeText(this.diagnostics.export());
				new Notice(
					this.diagnostics.getEntries().length
						? 'Diagnostics copied to clipboard.'
						: 'No diagnostic entries recorded.',
				);
			},
		});

		this.registerEvent(
			this.app.workspace.on('quit', () => this.saveSettings()),
		);

		this.app.workspace.onLayoutReady(() => {
			this.registerEvent(
				vault.on('create', this.handleCreate.bind(this)),
			);
			this.registerEvent(
				vault.on('delete', this.handleDelete.bind(this)),
			);
			this.registerEvent(
				vault.on('modify', this.handleModify.bind(this)),
			);
			this.registerEvent(
				vault.on('rename', this.handleRename.bind(this)),
			);

			void checkConnection().then(async (connected) => {
				if (!connected) {
					this.diagnostics.record({
						phase: 'auto-sync',
						operation: 'check-connection-on-startup',
						message: 'No internet connection at startup',
					});
					return;
				}

				this.syncing = true;
				this.ribbonIcon.addClass('spin');
				let autoSyncPhase: SyncPhase = 'auto-sync';
				try {
					autoSyncPhase = 'download';
					if (await pull(this, true)) {
						autoSyncPhase = 'start-token';
						await this.endSync();
					} else {
						this.diagnostics.record({
							phase: 'auto-sync',
							operation: 'initial-pull',
							message: 'Automatic sync on startup failed (see earlier entries)',
						});
						new Notice(
							'Automatic sync failed. Try syncing manually or check diagnostics.',
							8000,
						);
					}
				} catch (error) {
					this.diagnostics.record({
						phase: autoSyncPhase,
						operation: 'auto-sync-error',
						message: sanitizeMessage(error),
						stack: error instanceof Error ? error.stack : undefined,
					});
					new Notice(
						'Automatic sync encountered an error. Check diagnostics.',
						8000,
					);
				} finally {
					if (this.syncing) this.abortSync();
				}
			});
		});
	}

	onunload() {
		this.clearAutoPushTimer();
		void this.saveSettings();
		return;
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			(await this.loadData()) as PluginSettings,
		);
	}

	saveSettings() {
		return this.saveData(this.settings);
	}

	debouncedSaveSettings = debounce(this.saveSettings.bind(this), 500, true);

	clearAutoPushTimer() {
		if (this.autoPushTimer === undefined) return;
		window.clearTimeout(this.autoPushTimer);
		this.autoPushTimer = undefined;
	}

	scheduleAutoPush() {
		this.clearAutoPushTimer();
		if (!this.settings.autoPush || this.syncing) return;

		this.autoPushTimer = window.setTimeout(() => {
			this.autoPushTimer = undefined;
			if (
				this.syncing ||
				!this.settings.autoPush ||
				!Object.keys(this.settings.operations).length
			) {
				return;
			}
			void push(this, true);
		}, 60_000);
	}

	resumeAutoPushIfNeeded() {
		if (Object.keys(this.settings.operations).length) {
			this.scheduleAutoPush();
		}
	}

	handleCreate(file: TAbstractFile) {
		if (this.settings.operations[file.path] === 'delete') {
			if (file instanceof TFile) {
				this.settings.operations[file.path] = 'modify';
			} else {
				delete this.settings.operations[file.path];
			}
		} else {
			if (file.path.includes('"')) {
				new Notice(
					`File path ${file.path} contains double quotes and will not be synced.`,
				);
				return;
			}
			this.settings.operations[file.path] = 'create';
		}
		this.debouncedSaveSettings();
		this.scheduleAutoPush();
	}

	handleDelete(file: TAbstractFile) {
		if (this.settings.operations[file.path] === 'create') {
			delete this.settings.operations[file.path];
		} else if (!file.path.includes('"')) {
			this.settings.operations[file.path] = 'delete';
		}
		this.debouncedSaveSettings();
		this.scheduleAutoPush();
	}

	handleModify(file: TAbstractFile) {
		const operation = this.settings.operations[file.path];
		if (operation === 'create' || operation === 'modify') {
			this.scheduleAutoPush();
			return;
		}
		this.settings.operations[file.path] = 'modify';
		this.debouncedSaveSettings();
		this.scheduleAutoPush();
	}

	handleRename(file: TAbstractFile, oldPath: string) {
		this.handleDelete({ ...file, path: oldPath });
		this.handleCreate(file);
		this.debouncedSaveSettings();
	}

	async createFolder(path: string) {
		const oldOperation = this.settings.operations[path];
		await this.app.vault.createFolder(path);
		if (oldOperation) this.settings.operations[path] = oldOperation;
		else delete this.settings.operations[path];
	}

	async createFile(
		path: string,
		content: ArrayBuffer,
		modificationDate?: number | string | Date,
	) {
		const oldOperation = this.settings.operations[path];
		if (typeof modificationDate === 'string') {
			modificationDate = new Date(modificationDate);
		}
		if (modificationDate instanceof Date) {
			modificationDate = modificationDate.getTime();
		}

		await this.app.vault.createBinary(path, content, {
			mtime: modificationDate,
		});
		if (oldOperation) this.settings.operations[path] = oldOperation;
		else delete this.settings.operations[path];
	}

	async modifyFile(
		file: TFile,
		content: ArrayBuffer,
		modificationDate?: number | string | Date,
	) {
		const oldOperation = this.settings.operations[file.path];
		if (typeof modificationDate === 'string') {
			modificationDate = new Date(modificationDate);
		}
		if (modificationDate instanceof Date) {
			modificationDate = modificationDate.getTime();
		}

		await this.app.vault.modifyBinary(file, content, {
			mtime: modificationDate,
		});
		if (oldOperation) this.settings.operations[file.path] = oldOperation;
		else delete this.settings.operations[file.path];
	}

	async upsertFile(
		file: string,
		content: ArrayBuffer,
		modificationDate?: number | string | Date,
	) {
		const oldOperation = this.settings.operations[file];
		if (typeof modificationDate === 'string') {
			modificationDate = new Date(modificationDate);
		}
		if (modificationDate instanceof Date) {
			modificationDate = modificationDate.getTime();
		}

		await this.app.vault.adapter.writeBinary(file, content, {
			mtime: modificationDate,
		});
		if (oldOperation) this.settings.operations[file] = oldOperation;
		else delete this.settings.operations[file];
	}

	async deleteFile(file: TAbstractFile) {
		const oldOperation = this.settings.operations[file.path];
		await this.app.fileManager.trashFile(file);
		delete this.settings.operations[file.path];
		if (!oldOperation) delete this.settings.operations[file.path];
	}

	async startSync(operationName = 'Syncing') {
		if (!(await checkConnection())) {
			new Notice(
				'You are not connected to the internet, so you cannot sync right now. Please try syncing once you have connection again.',
			);
			throw new Error('No internet connection');
		}
		this.clearAutoPushTimer();
		this.ribbonIcon.addClass('spin');
		this.syncing = true;
		return new Notice(`${operationName}...`, 0);
	}

	async endSync(syncNotice?: Notice, retainConfigChanges = true) {
		const syncedAt = Date.now();
		if (retainConfigChanges) {
			const configFilesToSync = await this.drive.getConfigFilesToSync();

			await Promise.all(
				configFilesToSync.map(async (file) =>
					this.app.vault.adapter.writeBinary(
						file,
						await this.app.vault.adapter.readBinary(file),
						{ mtime: Date.now() },
					),
				),
			);
		}

		const changesToken = await this.drive.getChangesStartToken();
		if (!changesToken) {
			new Notice(
				'An error occurred fetching Google Drive changes token.',
			);
			this.abortSync(syncNotice);
			return false;
		}
		this.settings.lastSyncedAt = syncedAt;
		this.settings.changesToken = changesToken;
		await this.saveSettings();
		this.ribbonIcon.removeClass('spin');
		this.syncing = false;
		syncNotice?.hide();
		this.resumeAutoPushIfNeeded();
		return true;
	}

	abortSync(syncNotice?: Notice) {
		void this.saveLog(this.diagnostics.getEntries());
		this.ribbonIcon.removeClass('spin');
		this.syncing = false;
		syncNotice?.hide();
		this.resumeAutoPushIfNeeded();
	}

	async saveLog(entries: readonly DiagnosticEntry[]): Promise<void> {
		if (!entries.length) return;
		try {
			const logsDir = `${this.app.vault.configDir}/plugins/google-drive-sync/logs`;
			if (!(await this.app.vault.adapter.exists(logsDir))) {
				await this.app.vault.adapter.mkdir(logsDir);
			}
			const ts = new Date(entries[0]!.timestamp)
				.toISOString()
				.replace(/[-:]/g, '')
				.replace('T', '-')
				.replace(/\.\d+Z/, '');
			const filePath = `${logsDir}/sync-log-${ts}.md`;
			const content = new TextEncoder().encode(
				this.formatLogEntries(entries),
			);
			await this.app.vault.adapter.writeBinary(
				filePath,
				content.buffer,
				{ mtime: Date.now() },
			);
			void this.cleanupOldLogs(logsDir);
		} catch (error) {
			console.error('Failed to save sync log:', error);
		}
	}

	private formatLogEntries(entries: readonly DiagnosticEntry[]): string {
		if (!entries.length) return '';
		const first = entries[0]!;
		const date = new Date(first.timestamp)
			.toISOString()
			.replace('T', ' ')
			.replace(/\.\d+Z$/, ' UTC');
		const result = entries.some(
			(e) => e.httpStatus || e.phase !== 'auto-sync',
		)
			? '⚠️ Issues detected'
			: '✅ Clean sync';
		let md = `# Sync Log — ${date}\n\n`;
		md += '| | |\n|---|---|\n';
		md += `| **Date** | ${date} |\n`;
		md += `| **Result** | ${result} |\n`;
		md += `| **Entries** | ${entries.length} |\n\n`;
		for (const e of entries) {
			const t = new Date(e.timestamp)
				.toISOString()
				.replace(/.*T/, '')
				.replace(/\.\d+Z/, '');
			md += `### ${t} — ${e.phase}/${e.operation}\n\n`;
			md += `- **Message**: ${e.message}\n`;
			if (e.httpStatus) md += `- **HTTP Status**: ${e.httpStatus}\n`;
			md += `- **Likely cause**: ${e.likelyCause}\n`;
			md += `- **Suggested action**: ${e.suggestedAction}\n`;
			if (e.stack) {
				md += `- **Stack trace**:\n\`\`\`\n`;
				md += `${e.stack.split('\n').slice(0, 5).join('\n')}\n`;
				md += '```\n';
			}
			md += '\n';
		}
		return md;
	}

	private async cleanupOldLogs(logsDir: string): Promise<void> {
		try {
			const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
			const listing = await this.app.vault.adapter.list(logsDir);
			for (const file of listing.files) {
				if (!file.endsWith('.md')) continue;
				const stat = await this.app.vault.adapter.stat(file);
				if (stat && stat.mtime < cutoff) {
					await this.app.vault.adapter.remove(file);
				}
			}
		} catch {
			/* logs dir may not exist yet */
		}
	}

	compareVersions(a: string, b: string): number {
		const pa = a.split('.').map(Number);
		const pb = b.split('.').map(Number);
		for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
			const na = pa[i] || 0;
			const nb = pb[i] || 0;
			if (na !== nb) return na - nb;
		}
		return 0;
	}

	private async runPathMigration(): Promise<boolean> {
		try {
			if (!this.accessToken.token) {
				if (!(await refreshAccessToken(this))) {
					return false;
				}
			}
			const driveFiles = await this.drive.searchFiles({
				include: ['id', 'properties'],
			});
			if (!driveFiles) return false;
			const idToPath = Object.fromEntries(
				driveFiles.map(({ id, properties }) => [
					id,
					unSplitPath(properties),
				]),
			);
			this.settings.driveIdToPath = idToPath;
			await this.saveSettings();
			return true;
		} catch {
			return false;
		}
	}

	async checkAndMigrate(): Promise<void> {
		const prevVersion = this.settings.lastInstalledVersion;
		const currentVersion = this.manifest.version;

		if (
			prevVersion === '' &&
			Object.keys(this.settings.driveIdToPath).length > 0
		) {
			const migrated = await this.runPathMigration();
			if (migrated) {
				this.settings.lastInstalledVersion = currentVersion;
				await this.saveSettings();
			}
			return;
		}

		if (
			prevVersion !== '' &&
			this.compareVersions(prevVersion, '3.0.0') < 0
		) {
			const migrated = await this.runPathMigration();
			if (migrated) {
				this.settings.lastInstalledVersion = currentVersion;
				await this.saveSettings();
			}
			return;
		}

		this.settings.lastInstalledVersion = currentVersion;
		await this.saveSettings();
	}
}

class SettingsTab extends PluginSettingTab {
	plugin: ObsidianGoogleDrive;

	constructor(app: App, plugin: ObsidianGoogleDrive) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: 'Get refresh token',
				render: (setting) => {
					setting.settingEl.empty();
					setting.settingEl.createEl('a', {
						href: 'https://ogd.richardxiong.com',
						text: 'Get refresh token',
					});
				},
			},
			{
				name: 'Refresh token',
				desc: 'A refresh token is required to access your Google Drive for syncing. We suggest cloning your Google Drive vault to the current vault before syncing.',
				control: {
					type: 'text',
					key: 'refreshToken',
					placeholder: 'Refresh Token',
					validate: async (value: string) => {
						if (!value) {
							return 'Refresh token cannot be empty';
						}

						if (value === this.plugin.settings.refreshToken) {
							return;
						}

						if (!(await refreshAccessToken(this.plugin, value))) {
							return 'Failed to refresh access token.';
						}

						const changesToken =
							await this.plugin.drive.getChangesStartToken();
						if (!changesToken) {
							return 'An error occurred fetching Google Drive changes token.';
						}
						this.plugin.settings.changesToken = changesToken;

						await this.plugin.saveSettings();
						new Notice('Refresh token saved! Beginning to sync.');
						window.setTimeout(
							() =>
								void this.plugin
									.onload()
									.then(
										() =>
											new Notice(
												'Sync complete! Please close settings and restart Obsidian to see the changes properly sync.',
												0,
											),
									),
							1_000,
						);
						return;
					},
				},
			},
			{
				name: 'Automatically push changes',
				desc: 'Push one minute after the most recent local file change.',
				control: {
					type: 'toggle',
					key: 'autoPush',
					defaultValue: false,
				},
			},
			{
				name: 'Access token endpoint',
				desc: 'Service used to exchange the refresh token for a Google access token. The refresh token is sent to this URL. This is just so you can self-host the access token refresher. The code to host the website is available at https://github.com/RichardX366/Obsidian-Google-Drive-website. Defaults to my hosted service at https://ogd-server.richardxiong.com/api/access.',
				control: {
					type: 'text',
					key: 'accessTokenUrl',
					placeholder:
						'https://ogd-server.richardxiong.com/api/access',
					validate: (value: string) => {
						if (!value) return;
						try {
							if (new URL(value).protocol !== 'https:') {
								return 'Access token endpoint must use HTTPS.';
							}
						} catch {
							return 'Enter a valid access token endpoint URL.';
						}
						return;
					},
				},
			},
			{
				name: 'Client ID',
				desc: 'Optional OAuth client ID. When both a client ID and client secret are set, the plugin exchanges refresh tokens directly with Google.',
				control: {
					type: 'text',
					key: 'clientId',
					placeholder: 'Client ID',
				},
			},
			{
				name: 'Client secret',
				desc: 'Optional OAuth client secret. When both a client ID and client secret are set, the plugin exchanges refresh tokens directly with Google.',
				control: {
					type: 'text',
					key: 'clientSecret',
					placeholder: 'Client secret',
				},
			},
			{
				name: 'Enable diagnostic logging',
				desc: 'Record detailed error information when sync fails. Stored locally only — never sent automatically.',
				control: {
					type: 'toggle',
					key: 'enableDiagnostics',
					defaultValue: false,
				},
			},
			{
				name: 'Mask file paths in diagnostics',
				desc: 'Replace file path segments with *** for privacy. Disable if you need paths for debugging.',
				control: {
					type: 'toggle',
					key: 'maskFilePaths',
					defaultValue: true,
				},
			},
			{
				name: 'Diagnostics',
				render: (setting) => {
					setting.settingEl.empty();
					const count = this.plugin.diagnostics.getEntries().length;
					setting.setName(
						`Diagnostics (${count} ${count === 1 ? 'entry' : 'entries'})`,
					);
					const btns = setting.settingEl.createDiv({
						cls: 'setting-item-control',
					});
					const copyBtn = btns.createEl('button', {
						text: 'Copy to clipboard',
					});
					copyBtn.addEventListener('click', () => {
						void navigator.clipboard.writeText(
							this.plugin.diagnostics.export(),
						);
						new Notice('Diagnostics copied to clipboard.');
					});
					const clearBtn = btns.createEl('button', { text: 'Clear' });
					clearBtn.addEventListener('click', () => {
						this.plugin.diagnostics.clear();
						new Notice('Diagnostics cleared.');
						this.update();
					});
				},
			},
		];
	}

	async setControlValue(key: string, value: unknown) {
		await super.setControlValue(key, value);
		if (key === 'autoPush') {
			if (value) this.plugin.resumeAutoPushIfNeeded();
			else this.plugin.clearAutoPushTimer();
		}
		if (key === 'enableDiagnostics') {
			this.plugin.diagnostics.enabled = value as boolean;
		}
		if (key === 'maskFilePaths') {
			this.plugin.diagnostics.maskPaths = value as boolean;
		}
	}
}
