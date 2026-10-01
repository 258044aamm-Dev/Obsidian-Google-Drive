import { HeaderButton } from './helpers/header-button';
import { advancedSettingGroup, isAdvancedOpen } from './helpers/advanced';
import { countIgnoredFiles, dropIgnoredMarks, isIgnored } from './helpers/ignore';
import { checkConnection, checkDriveHost, getDriveClient, unSplitPath } from './helpers/drive';
import { resetRetryWindow } from './helpers/net-retry';
import { KEEP_OPEN_NOTICE, holdScreenAwake, onVisibilityChange, releaseScreen } from './helpers/mobile-sync';
import { refreshAccessToken } from './helpers/requests';
import { pull } from './helpers/pull';
import { push } from './helpers/push';
import {
	App,
	debounce,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	type SettingDefinition,
	type SettingDefinitionItem,
	TAbstractFile,
	TFile,
} from 'obsidian';
import { runSyncDoctor } from './helpers/doctor-command';
import { installStatusBar, type StatusBar } from './helpers/status-bar';
import { createKeyStore, loadEncryption, type E2ee, type KeyStore } from './helpers/e2ee';
import { renderRow } from './helpers/settings-row';
import { WAITING_CHECK_MS, badgeText, pullIconLabel, pushIconLabel, refreshWaitingBadge, setBadge } from './helpers/badge';
import { commandsSettingGroup, registerCommands } from './helpers/commands';
import { openChangePassphrase, openDisableEncryption, openEnableEncryption, openUnlockEncryption } from './helpers/e2ee-ui';
import { createRestorePointNow, startVaultRestore } from './helpers/history-ui';
import { HISTORY_MAX_DAYS, HISTORY_MIN_DAYS } from './helpers/history';
import { DiagnosticsManager, sanitizeMessage } from './helpers/diagnostics';
import { maybeOfferTour, maybeShowThemeNotice, openTour, canResumeTour } from './helpers/tour';
import { pruneSyncState, recordSyncedFromDisk, seedConfigBaselines } from './helpers/sync-state';
import type { DiagnosticEntry, SyncPhase } from './helpers/diagnostics';

const isInConfigDir = (configDir: string, path: string) =>
	path === configDir || path.startsWith(configDir + '/');

interface PluginSettings {
	refreshToken: string;
	clientId: string;
	clientSecret: string;
	accessTokenUrl: string;
	autoPush: boolean;
	/** Pull from Drive automatically when Obsidian starts. Off by default: sync is manual. */
	startupPull: boolean;
	/** Files deleted on this device go to the Drive Trash (recoverable) instead of being deleted permanently. */
	deleteToTrash: boolean;
	/** Save a restore point of the whole vault after every Push (see helpers/history.ts). */
	historyEnabled: boolean;
	/** How many days restore points are kept (1 to 30). */
	historyRetentionDays: number;
	operations: Record<string, 'create' | 'delete' | 'modify'>;
	driveIdToPath: Record<string, string>;
	rootFolderId: string;
	lastSyncedAt: number;
	changesToken: string;
	enableDiagnostics: boolean;
	maskFilePaths: boolean;
	lastInstalledVersion: string;
	/** End-to-end encryption is on for this device (see helpers/e2ee.ts). */
	e2eeEnabled: boolean;
	/** Id of this device's key for the encrypted vault (the key itself is in the device's IndexedDB). */
	e2eeKid: string;
	/** The plain Drive link this device had before encryption was turned on, so turning it off can go back. */
	/** Sync the Obsidian settings files and the other plugins' files. On unless explicitly false (see helpers/config-scope.ts). */
	/** Show the pending count on the Push ribbon icon (and the Drive count on the Pull icon, if that check is on). On unless explicitly false. */
	ribbonBadges?: boolean;
	/** Ask Google Drive now and then how many changes are waiting, and show it on the Pull ribbon icon. Off by default. */
	pullBadge?: boolean;
	/** Files and folders sync leaves alone: one pattern per line (see helpers/ignore.ts). */
	ignorePatterns?: string;
	/** The Drive icon in the note header: on unless this is false. */
	headerButton?: boolean;
	syncConfigFiles?: boolean;
	/** Sync the themes in the configuration folder. On unless explicitly false. */
	syncThemes?: boolean;
	/** Sync the CSS snippets in the configuration folder. On unless explicitly false. */
	syncSnippets?: boolean;
	/** The one-time notice about theme and snippet sync has been shown. */
	themeNoticeShown?: boolean;
	/** Progress of the getting-started tour (see helpers/tour-state.ts). */
	tourState?: import('./helpers/tour-state').TourState;
	/** Drive id -> the modifiedTime Drive reported after THIS device uploaded the file (see helpers/sync-state.ts). */
	ownUploads?: Record<string, string>;
	/** Vault path -> { m: mtime, s: size } when the file was last known to match its Drive copy. */
	syncedFiles?: Record<string, { m: number; s: number; h?: string }>;
	e2eePlainLink?: {
		rootFolderId: string;
		driveIdToPath: Record<string, string>;
		operations: Record<string, 'create' | 'delete' | 'modify'>;
		lastSyncedAt: number;
		changesToken: string;
	};
}

const DEFAULT_SETTINGS: PluginSettings = {
	refreshToken: '',
	clientId: '',
	clientSecret: '',
	accessTokenUrl: '',
	autoPush: false,
	startupPull: false,
	deleteToTrash: true,
	historyEnabled: true,
	historyRetentionDays: 10,
	operations: {},
	driveIdToPath: {},
	rootFolderId: '',
	lastSyncedAt: 0,
	changesToken: '',
	enableDiagnostics: false,
	maskFilePaths: true,
	lastInstalledVersion: '',
	e2eeEnabled: false,
	e2eeKid: '',
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
	pullRibbonIcon?: HTMLElement;
	/** Changes waiting on Google Drive, as last counted (only while the opt-in check is on). */
	waitingOnDrive?: number;
	/** The Drive icon in the note header. */
	header?: HeaderButton;
	private migrationChecked = false;
	syncing!: boolean;
	/** the visibility listener is registered (onload can run again after a token is added) */
	private visibilityHooked = false;
	autoPushTimer?: number;
	/** Create / modify / delete / rename events seen since load (shown by the Sync doctor). */
	vaultEventCount = 0;
	private statusBar?: StatusBar;
	/** Encryption helper while end-to-end encryption is on and this device has the key. */
	e2ee?: E2ee;
	/** Where this device keeps the encryption key (IndexedDB; tests inject an in-memory one). */
	keyStore: KeyStore = createKeyStore();
	/** Config-folder files that this sync downloaded from Drive (so they must not count as changed on this device). */
	private pulledConfigPaths?: Set<string>;

	async onload() {
		const { vault } = this.app;

		await this.loadSettings();
		dropIgnoredMarks(this); // a list that was edited while the plugin was off
		await loadEncryption(this);
		this.diagnostics.enabled = this.settings.enableDiagnostics;
		this.diagnostics.maskPaths = this.settings.maskFilePaths;

		this.addSettingTab(new SettingsTab(this.app, this));

		// A phone that was in the background during a sync: say so when it comes back.
		if (!this.visibilityHooked && typeof document !== 'undefined') {
			this.visibilityHooked = true;
			this.registerDomEvent(document, 'visibilitychange', () => {
				const message = onVisibilityChange(
					this,
					document.visibilityState === 'visible',
					this.syncing === true,
				);
				if (message) new Notice(message, 10000);
			});
		}

		// Available before the token is added too: it is how a new user gets started.
		registerCommands(this, false);

		if (!this.settings.refreshToken) {
			// A brand-new device is offered the tour once, with a small notice.
			if (maybeOfferTour(this)) return;
			new Notice(
				"Please add your refresh token to Google Drive sync through our website or our readme/this plugin's settings. If you haven't already, please read through this plugin's readme or website for instructions on how to use this plugin. Be careful of your first sync, and make sure to back up your data before your first sync.",
				10000,
			);
			return;
		}

		this.ribbonIcon = this.addRibbonIcon(
			'refresh-cw',
			'Push to Google Drive',
			() => {
				if (this.syncing) return;
				void push(this);
			},
		);

		this.pullRibbonIcon = this.addRibbonIcon(
			'cloud-download',
			'Pull from Google Drive',
			() => {
				if (this.syncing) return;
				void pull(this);
			},
		);

		// Status bar button (desktop only): pending count and a menu of actions.
		this.statusBar?.remove();
		this.statusBar = installStatusBar(this);
		this.header?.destroy();
		this.header = new HeaderButton(
			this,
			{
				onPush: () => {
					if (!this.syncing) void push(this);
				},
				onPull: () => {
					if (!this.syncing) void pull(this);
				},
			},
		);
		this.header.start();
		this.updateBadges();

		// Push, Pull and the rest of the commands (the list is in helpers/commands.ts).
		registerCommands(this, true);

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

			// Themes and snippets sync by default since 3.7.0: tell a device that already used the plugin, once.
			maybeShowThemeNotice(this);

			// Opt-in: ask Drive now and then how many changes are waiting (shown on the Pull icon).
			const firstCheck = window.setInterval(() => {
				window.clearInterval(firstCheck);
				void refreshWaitingBadge(this);
			}, 10_000);
			this.registerInterval(firstCheck);
			this.registerInterval(
				window.setInterval(() => void refreshWaitingBadge(this), WAITING_CHECK_MS),
			);

			// Sync is manual: nothing is pulled at startup unless the user opted in.
			if (!this.settings.startupPull) return;

			void checkConnection().then(async (connected) => {
				if (!connected) {
					this.diagnostics.record({
						phase: 'auto-sync',
						operation: 'check-connection-on-startup',
						message: 'No internet connection at startup',
					});
					return;
				}

				await this.ensureMigrated();

				resetRetryWindow(this);
				this.syncing = true;
				this.setSpinning(true);
				holdScreenAwake(this);
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
		this.header?.destroy();
		releaseScreen(this);
		this.clearAutoPushTimer();
		void this.saveSettings();
		return;
	}

	async loadSettings() {
		// `operations` and `driveIdToPath` get fresh objects so that no two loads (or
		// devices in tests) ever share the mutable defaults.
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			{ operations: {}, driveIdToPath: {} },
			(await this.loadData()) as PluginSettings,
		);
	}

	saveSettings() {
		return this.saveData(this.settings);
	}

	debouncedSaveSettings = debounce(this.saveSettings.bind(this), 500, true);

	updateStatusBar(spinning?: boolean) {
		this.statusBar?.update(spinning);
		this.updateBadges(spinning);
	}

	/** Counts on the two ribbon icons (see helpers/badge.ts). */
	updateBadges(busy?: boolean) {
		this.header?.update(busy);
		if (this.settings.pullBadge !== true) this.waitingOnDrive = undefined;
		const show = this.settings.ribbonBadges !== false;
		const pending = show ? Object.keys(this.settings.operations).length : 0;
		const waiting = show ? this.waitingOnDrive : undefined;
		setBadge(this.ribbonIcon, badgeText(pending), pushIconLabel(pending));
		setBadge(this.pullRibbonIcon, badgeText(waiting), pullIconLabel(waiting));
	}

	setSpinning(spinning: boolean) {
		this.updateStatusBar(spinning);
		[this.ribbonIcon, this.pullRibbonIcon].forEach((icon) => {
			if (spinning) icon?.addClass('spin');
			else icon?.removeClass('spin');
		});
	}

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
		this.vaultEventCount++;
		if (isIgnored(this, file.path)) return;
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
		this.updateStatusBar();
		this.debouncedSaveSettings();
		this.scheduleAutoPush();
	}

	handleDelete(file: TAbstractFile) {
		this.vaultEventCount++;
		if (isIgnored(this, file.path)) return;
		if (this.settings.operations[file.path] === 'create') {
			delete this.settings.operations[file.path];
		} else if (!file.path.includes('"')) {
			this.settings.operations[file.path] = 'delete';
		}
		this.updateStatusBar();
		this.debouncedSaveSettings();
		this.scheduleAutoPush();
	}

	handleModify(file: TAbstractFile) {
		this.vaultEventCount++;
		if (isIgnored(this, file.path)) return;
		const operation = this.settings.operations[file.path];
		if (operation === 'create' || operation === 'modify') {
			this.scheduleAutoPush();
			return;
		}
		this.settings.operations[file.path] = 'modify';
		this.updateStatusBar();
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
		await recordSyncedFromDisk(this, path, content);
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
		await recordSyncedFromDisk(this, file.path, content);
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
		await recordSyncedFromDisk(this, file, content);
		if (isInConfigDir(this.app.vault.configDir, file)) {
			(this.pulledConfigPaths ||= new Set()).add(file);
		}
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
		if (this.settings.e2eeEnabled === true && !this.e2ee) {
			new Notice(
				'End-to-end encryption is on, but this device does not have the key. Enter the passphrase in the plugin settings first.',
				8000,
			);
			throw new Error('Encryption key missing');
		}
		if (!(await checkConnection())) {
			new Notice(
				'You are not connected to the internet, so you cannot sync right now. Please try syncing once you have connection again.',
			);
			throw new Error('No internet connection');
		}
		// Online, but can Google's servers be reached (a firewall or VPN may block only those)?
		if (!(await checkDriveHost())) {
			new Notice(
				'Your device is online, but Google Drive could not be reached. A firewall, VPN or network filter may be blocking it. Try again on another network or later.',
				10000,
			);
			throw new Error('Google Drive unreachable');
		}
		resetRetryWindow(this);
		this.clearAutoPushTimer();
		this.setSpinning(true);
		this.syncing = true;
		holdScreenAwake(this);
		if (Platform.isMobile) new Notice(KEEP_OPEN_NOTICE, 6000);
		this.pulledConfigPaths = undefined;
		return new Notice(`${operationName}...`, 0);
	}

	async endSync(
		syncNotice?: Notice,
		retainConfigChanges = true,
		advanceCursor = true,
	) {
		const syncedAt = Date.now();
		if (retainConfigChanges) {
			// Keep the config files that were changed on this device marked as changed after the
			// sync point moves on. Files this sync just downloaded are not local changes: marking
			// them would upload them again on the next Push (and bounce between devices).
			const pulled = this.pulledConfigPaths ?? new Set<string>();
			const configFilesToSync = (
				await this.drive.getConfigFilesToSync()
			).filter((file) => !pulled.has(file));

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

		if (advanceCursor) {
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
			this.waitingOnDrive = this.settings.pullBadge === true ? 0 : undefined; // everything up to now is pulled
			await seedConfigBaselines(this);
			pruneSyncState(
				this,
				new Set(Object.values(this.settings.driveIdToPath)),
				syncedAt,
			);
		}
		// else: Drive has changes this device has not pulled; keep the old position so the next Pull gets them.
		this.pulledConfigPaths = undefined;
		await this.saveSettings();
		this.setSpinning(false);
		this.syncing = false;
		releaseScreen(this);
		syncNotice?.hide();
		this.resumeAutoPushIfNeeded();
		return true;
	}

	abortSync(syncNotice?: Notice) {
		void this.saveLog(this.diagnostics.getEntries());
		this.setSpinning(false);
		this.syncing = false;
		releaseScreen(this);
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
			const ts = new Date()
				.toISOString()
				.replace(/[-:]/g, '')
				.replace('T', '-')
				.replace(/\.\d+Z/, '');
			const filePath = `${logsDir}/sync-log-${ts}.md`;
			await this.app.vault.adapter.write(
				filePath,
				this.formatLogEntries(entries),
			);
			void this.cleanupOldLogs(logsDir);
		} catch (error) {
			console.error('Failed to save sync log:', error);
		}
	}

	async copyDiagnosticsToClipboard(): Promise<void> {
		if (!this.diagnostics.getEntries().length) {
			new Notice('No diagnostic entries recorded.');
			return;
		}
		try {
			await navigator.clipboard.writeText(this.diagnostics.export());
			new Notice('Diagnostics copied to clipboard.');
		} catch {
			new Notice('Could not copy diagnostics — clipboard unavailable.');
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
			// Merge, never replace: ids that only the local map knows about carry the
			// information needed to mirror Drive-side deletions on this device.
			this.settings.driveIdToPath = {
				...this.settings.driveIdToPath,
				...idToPath,
			};
			await this.saveSettings();
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Runs the one-time migration check lazily, right before the first manual sync of a
	 * session (instead of at startup).
	 */
	async ensureMigrated(): Promise<void> {
		if (this.migrationChecked) return;
		this.migrationChecked = true;
		try {
			await this.checkAndMigrate();
		} catch (error) {
			// The migration is best effort and must never block a sync.
			this.diagnostics.record({
				phase: 'auto-sync',
				operation: 'migration-error',
				message: sanitizeMessage(error),
			});
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
		const redraw = () => this.update();
		return [
			...this.basicDefinitions(),
			advancedSettingGroup(this.advancedDefinitions(), redraw),
			// the commands belong to the advanced part: they are only there while it is unfolded
			...(isAdvancedOpen() ? [commandsSettingGroup(this.plugin, redraw)] : []),
		];
	}

	/** What every user needs: connect, sync, and the three everyday switches. */
	private basicDefinitions(): SettingDefinition[] {
		return [
			{
				name: 'Getting started',
				render: (setting) => {
					const btns = renderRow(
						setting,
						'Getting started',
						'A short step-by-step tour: connect Google Drive, the first sync, optional encryption, daily use and the safety tools. Every step can be skipped.',
					);
					btns.createEl('button', { text: 'Start the tour' }).addEventListener('click', () => openTour(this.plugin));
					if (canResumeTour(this.plugin)) {
						btns.createEl('button', { text: 'Continue the tour' }).addEventListener('click', () => openTour(this.plugin, true));
					}
				},
			},
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
				name: 'Sync now',
				render: (setting) => {
					const btns = renderRow(
						setting,
						'Sync now',
						'Pull brings changes from Google Drive to this device. Push sends this device\'s changes to Google Drive. The doctor only checks and changes nothing.',
					);
					const pullBtn = btns.createEl('button', { text: 'Pull' });
					pullBtn.addEventListener('click', () => {
						if (this.plugin.syncing) return;
						void pull(this.plugin);
					});
					const pushBtn = btns.createEl('button', { text: 'Push' });
					pushBtn.addEventListener('click', () => {
						if (this.plugin.syncing) return;
						void push(this.plugin);
					});
					const doctorBtn = btns.createEl('button', {
						text: 'Sync doctor',
					});
					doctorBtn.addEventListener('click', () => {
						void runSyncDoctor(this.plugin);
					});
				},
			},
			{
				name: 'Pull when Obsidian starts',
				desc: 'Off by default: sync only happens when you press Pull or Push. Turn on to pull from Google Drive every time Obsidian opens (takes effect after restarting Obsidian).',
				control: {
					type: 'toggle',
					key: 'startupPull',
					defaultValue: false,
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
				name: 'Move deleted files to Google Drive Trash',
				desc: 'On by default: files you delete are moved to the Google Drive Trash, where you can restore them for about 30 days, instead of being deleted permanently. Every device that syncs this vault must run this version of the plugin, otherwise it will not see these deletions. Turn off to delete permanently.',
				control: {
					type: 'toggle',
					key: 'deleteToTrash',
					defaultValue: true,
				},
			},
		];
	}

	/** Everything else. Folded away until the user opens the Advanced section. */
	private advancedDefinitions(): SettingDefinition[] {
		return [
			{
				name: 'Show counts on the ribbon icons',
				desc: 'A small number on the Push icon: how many changes are waiting on this device. Costs nothing. On a phone the ribbon is in the side menu.',
				control: {
					type: 'toggle',
					key: 'ribbonBadges',
					defaultValue: true,
				},
			},
			{
				name: 'Check Google Drive for waiting changes',
				desc: 'Off by default. Turn on to show a number on the Pull icon: how many changes are waiting on Google Drive. It asks Drive once when Obsidian has started and then every 15 minutes while the app is open, never during a sync. The number is a hint; Pull decides what to do.',
				control: {
					type: 'toggle',
					key: 'pullBadge',
					defaultValue: false,
				},
			},
			{
				name: 'Show a Drive icon in the note header',
				desc: 'A small icon next to the three-dots button at the top of every note. Click or tap it to choose Push or Pull. A number on it says how many changes are waiting (on this device and, with the Drive check above, on Google Drive). On a phone it is the way to see the counts, because the ribbon is hidden there.',
				control: {
					type: 'toggle',
					key: 'headerButton',
					defaultValue: true,
				},
			},
			{
				name: 'Ignore list',
				desc: 'Files and folders that sync leaves alone, one pattern per line. A name like BRAT-log.md or *.tmp matches at any depth. Daily/*.md or /Inbox starts at the vault root. * matches within one name, ** also across folders, ? is one character. A folder covers what is inside it. Lines starting with # are notes. Upper and lower case are the same. Files already on Drive stay where they are. This list is only for this device: use the same list on every device.',
				control: {
					type: 'textarea',
					key: 'ignorePatterns',
					placeholder: 'BRAT-log.md\n*.tmp\nArchive/',
					rows: 5,
				},
			},
			{
				name: 'Ignored files',
				render: (setting) => {
					const row = renderRow(setting, 'Ignored files');
					const text = row.createSpan();
					const show = () => {
						const count = countIgnoredFiles(this.plugin);
						text.setText(
							count === 1
								? '1 file in this vault is ignored'
								: `${count} files in this vault are ignored`,
						);
					};
					show();
					const btn = row.createEl('button', { text: 'Count again' });
					btn.addEventListener('click', show);
				},
			},
			{
				name: 'Sync Obsidian settings and other plugins\' files',
				desc: 'On: your Obsidian settings files (appearance, hotkeys, which plugins are enabled ...) and the files of your other plugins are synced. This plugin\'s own folder, open tabs and the graph layout are never synced. Restart Obsidian after a Pull brought new settings.',
				control: {
					type: 'toggle',
					key: 'syncConfigFiles',
					defaultValue: true,
				},
			},
			{
				name: 'Sync themes',
				desc: 'On: the themes in your configuration folder are synced, so the appearance setting finds its theme on every device. Turning it off does not delete anything on Google Drive or on your devices.',
				control: {
					type: 'toggle',
					key: 'syncThemes',
					defaultValue: true,
				},
			},
			{
				name: 'Sync CSS snippets',
				desc: 'On: your CSS snippets are synced. Turning it off does not delete anything on Google Drive or on your devices.',
				control: {
					type: 'toggle',
					key: 'syncSnippets',
					defaultValue: true,
				},
			},
			{
				name: 'Save a restore point after every Push',
				desc: 'On by default: after each successful Push a small list of your files and their Google Drive versions is saved next to the vault on Drive. It lets you restore the whole vault to that moment (command: "Restore the whole vault to an earlier restore point"). Google Drive itself keeps the old versions of files for about 30 days.',
				control: {
					type: 'toggle',
					key: 'historyEnabled',
					defaultValue: true,
				},
			},
			{
				name: 'Keep restore points for (days)',
				desc: 'Older restore points are deleted after each Push. The newest one is always kept. Google Drive forgets old file versions after about 30 days, so 30 is the most that makes sense.',
				control: {
					type: 'slider',
					key: 'historyRetentionDays',
					defaultValue: 10,
					min: HISTORY_MIN_DAYS,
					max: HISTORY_MAX_DAYS,
					step: 1,
					displayFormat: (value: number) => `${value} days`,
				},
			},
			{
				name: 'Version history',
				render: (setting) => {
					const btns = renderRow(
						setting,
						'Version history',
						'Restore the whole vault to an earlier restore point, or save a restore point right now. A restore first changes only this device; you review it and then push.',
					);
					const restoreBtn = btns.createEl('button', {
						text: 'Restore...',
					});
					restoreBtn.addEventListener('click', () => {
						void startVaultRestore(this.plugin);
					});
					const pointBtn = btns.createEl('button', {
						text: 'Create restore point now',
					});
					pointBtn.addEventListener('click', () => {
						void createRestorePointNow(this.plugin);
					});
				},
			},
			{
				name: 'End-to-end encryption',
				render: (setting) => {
										const on = this.plugin.settings.e2eeEnabled === true;
					const locked = on && !this.plugin.e2ee;
					const description = (
						!on
							? 'Off. Advanced option: if you are a beginner, leave this off. Turn it on to keep your notes and their names encrypted on Google Drive with a passphrase that only you know. It starts a NEW encrypted vault next to your current one. Do it on your main device first, then on the others.'
							: locked
								? 'On, but this device does not have the key. Sync is paused until you enter the passphrase.'
								: 'On. Notes and their names are encrypted on this device before they reach Google Drive. Google Drive\'s web preview and search cannot read them. If you lose the passphrase, nobody can recover the notes.'
					);
					const btns = renderRow(
						setting,
						'End-to-end encryption',
						description,
					);
					const refresh = () => this.update();
					const add = (text: string, run: () => void) =>
						btns.createEl('button', { text }).addEventListener('click', run);
					if (!on) {
						add('Turn on...', () => openEnableEncryption(this.plugin, refresh));
					} else {
						if (locked) {
							add('Enter passphrase...', () => openUnlockEncryption(this.plugin, refresh));
						} else {
							add('Change passphrase...', () => openChangePassphrase(this.plugin));
						}
						add('Turn off...', () => openDisableEncryption(this.plugin, refresh));
					}
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
					const count = this.plugin.diagnostics.getEntries().length;
					const btns = renderRow(
						setting,
						`Diagnostics (${count} ${count === 1 ? 'entry' : 'entries'})`,
					);
					const copyBtn = btns.createEl('button', {
						text: 'Copy to clipboard',
					});
					copyBtn.addEventListener('click', () => {
						void this.plugin.copyDiagnosticsToClipboard();
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
		if (key === 'ignorePatterns') {
			if (dropIgnoredMarks(this.plugin)) {
				this.plugin.updateStatusBar();
				this.plugin.debouncedSaveSettings();
			}
		}
		if (key === 'ribbonBadges' || key === 'headerButton') this.plugin.updateBadges();
		if (key === 'pullBadge') {
			this.plugin.updateBadges();
			if (value) void refreshWaitingBadge(this.plugin);
		}
		if (key === 'enableDiagnostics') {
			this.plugin.diagnostics.enabled = value as boolean;
		}
		if (key === 'maskFilePaths') {
			this.plugin.diagnostics.maskPaths = value as boolean;
		}
	}
}
