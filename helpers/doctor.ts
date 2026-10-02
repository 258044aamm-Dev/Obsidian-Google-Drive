/**
 * Sync doctor: a READ-ONLY comparison of this device, the Drive copy and the plugin's saved
 * state. It is pure (no I/O) so it can be unit tested; the command in `doctor-command.ts`
 * gathers the inputs with GET requests only and never modifies anything.
 */

export type Operation = 'create' | 'delete' | 'modify';

export interface DoctorDriveEntry {
	id: string;
	path: string;
	isFolder: boolean;
}

export interface DoctorInput {
	pluginVersion: string;
	settings: {
		operations: Record<string, Operation>;
		driveIdToPath: Record<string, string>;
		lastSyncedAt: number;
		hasRefreshToken: boolean;
		hasChangesToken: boolean;
		startupPull: boolean;
		autoPush: boolean;
	};
	/** Local vault paths (files and folders, without the config folder). Folders end without a slash. */
	localPaths: string[];
	/** Every entry on Drive that belongs to the vault (config files excluded). */
	drive: DoctorDriveEntry[];
	/** Optional extra facts. When left out the report is exactly as before. */
	environment?: DoctorEnvironment;
}

export interface DoctorEnvironment {
	/** This plugin's "Drive deletions go to the Trash" setting. */
	deleteToTrash?: boolean;
	/** Obsidian's "Deleted files" option: 'system', 'local' (.trash) or 'none' (permanently delete). */
	obsidianTrashOption?: string;
	/** This device's clock minus Google's clock in milliseconds, or null when it could not be measured. */
	clockSkewMs?: number | null;
	/** Notes marked as changed on this device that are exactly what they were at the last sync (false alarms). */
	falseMarks?: string[];
	/** Notes marked as changed on this device with no remembered synced state (Pull keeps a copy of Drive's version each time). */
	unrememberedMarks?: string[];
	/** How long one small request to Google took in milliseconds, or null when it failed. */
	responseMs?: number | null;
	/** Notes written after the last sync that are not in the pending list (not yet compared with Drive). */
	unrecordedEdits?: string[];
	/** How many create / modify / delete / rename events this plugin has seen since it was loaded. */
	vaultEvents?: number;
	/** Permissions (OAuth scopes) Google says this device's token has, or null when they could not be read. */
	grantedScopes?: string[] | null;
	/** Only set while end-to-end encryption is on: whether this device has the key. */
	encryption?: 'unlocked' | 'locked';
}

const SCOPE_PREFIX = 'https://www.googleapis.com/auth/';
/** Scopes that let an app see Drive files it did not create. */
const BROAD_DRIVE_SCOPES = ['drive', 'drive.readonly', 'drive.metadata', 'drive.metadata.readonly', 'drive.photos.readonly'];

/** Scopes from Google's tokeninfo answer (a space separated string). */
export const parseScopes = (scope: unknown): string[] | null =>
	typeof scope === 'string' && scope.trim() ? scope.trim().split(/\s+/) : null;

/** One line for the report, plus a warning when the token can see more than the plugin's own files. */
export const describeGrantedScopes = (scopes: string[] | null): { line: string; warning?: string } => {
	if (!scopes) return { line: 'Google permission: could not be checked (no answer from Google).' };
	const short = (x: string) => (x.startsWith(SCOPE_PREFIX) ? x.slice(SCOPE_PREFIX.length) : x);
	const broad = scopes.map(short).filter((x) => BROAD_DRIVE_SCOPES.includes(x));
	if (broad.length) {
		return {
			line: `Google permission: ${scopes.map(short).join(', ')}`,
			warning: `This device's Google token can see your WHOLE Drive (${broad.join(', ')}), not just the files this plugin created. Revoke it at myaccount.google.com/connections and sign in again with the plugin's sign-in page, which only asks for "drive.file".`,
		};
	}
	if (scopes.map(short).includes('drive.file')) {
		return {
			line: 'Google permission: drive.file. This plugin can only see and change Drive files it created itself, not the rest of your Drive.',
		};
	}
	return { line: `Google permission: ${scopes.map(short).join(', ')} (no Drive access).` };
};

/** A clock that differs from Google's by more than this is reported. */
export const CLOCK_SKEW_LIMIT_MS = 60_000;

/**
 * Device clock minus server clock. `sentAt` and `receivedAt` are device times around the request, and
 * `serverDate` is the HTTP `Date` header (whole seconds). Returns null if the header is missing or invalid.
 */
export const clockSkewMs = (
	sentAt: number,
	receivedAt: number,
	serverDate: string | undefined,
): number | null => {
	if (!serverDate) return null;
	const server = Date.parse(serverDate);
	if (!Number.isFinite(server)) return null;
	return Math.round((sentAt + receivedAt) / 2 - server);
};

const describeSkew = (ms: number) => {
	const seconds = Math.round(Math.abs(ms) / 1000);
	const amount = seconds >= 120 ? `${Math.round(seconds / 60)} minutes` : `${seconds} seconds`;
	return `${amount} ${ms > 0 ? 'ahead of' : 'behind'}`;
};

export interface DoctorReport {
	pluginVersion: string;
	lastSyncedAt: string;
	startupPull: boolean;
	autoPush: boolean;
	hasRefreshToken: boolean;
	hasChangesToken: boolean;
	counts: { local: number; drive: number; mappedIds: number };
	operationCounts: Record<Operation, number>;
	pendingOperations: [string, Operation][];
	/** On this device and in the saved id map, but gone from Drive: probably deleted on Drive. A Pull removes them here. */
	deletedOnDrive: string[];
	/** On this device only and never synced: new local content. A Push uploads it. */
	newLocal: string[];
	/** On Drive only: a Pull downloads them. */
	onlyOnDrive: string[];
	/** Paths that more than one Drive entry claims. */
	duplicateDrivePaths: { path: string; ids: string[] }[];
	/** Ids in the saved map that no longer exist on Drive. */
	staleMapIds: { id: string; path: string }[];
	verdict: string[];
	/** Optional lines describing the environment; empty when no environment facts were given. */
	environmentLines: string[];
}

export const buildDoctorReport = (input: DoctorInput): DoctorReport => {
	const { settings } = input;
	const local = new Set(input.localPaths);
	const drivePaths = new Map<string, string[]>();
	input.drive.forEach(({ id, path }) => {
		drivePaths.set(path, [...(drivePaths.get(path) ?? []), id]);
	});
	const driveIds = new Set(input.drive.map(({ id }) => id));
	const mappedPaths = new Set(Object.values(settings.driveIdToPath));

	const sort = (a: string[]) => [...a].sort();

	const deletedOnDrive: string[] = [];
	const newLocal: string[] = [];
	local.forEach((path) => {
		if (drivePaths.has(path)) return;
		(mappedPaths.has(path) ? deletedOnDrive : newLocal).push(path);
	});
	const onlyOnDrive = [...drivePaths.keys()].filter((p) => !local.has(p));

	const duplicateDrivePaths = [...drivePaths.entries()]
		.filter(([, ids]) => ids.length > 1)
		.map(([path, ids]) => ({ path, ids }));

	const staleMapIds = Object.entries(settings.driveIdToPath)
		.filter(([id]) => !driveIds.has(id))
		.map(([id, path]) => ({ id, path }));

	const operationCounts: Record<Operation, number> = {
		create: 0,
		delete: 0,
		modify: 0,
	};
	Object.values(settings.operations).forEach((op) => {
		operationCounts[op] = (operationCounts[op] ?? 0) + 1;
	});

	const verdict: string[] = [];
	if (
		!deletedOnDrive.length &&
		!newLocal.length &&
		!onlyOnDrive.length &&
		!duplicateDrivePaths.length
	) {
		verdict.push('This device and Drive have the same paths.');
	}
	if (deletedOnDrive.length) {
		verdict.push(
			`${deletedOnDrive.length} item(s) here were deleted on Drive. Run Pull to remove them here. Do NOT Push first: a Push could put them back on Drive.`,
		);
	}
	if (onlyOnDrive.length) {
		verdict.push(
			`${onlyOnDrive.length} item(s) exist only on Drive. Run Pull to download them.`,
		);
	}
	if (newLocal.length) {
		verdict.push(
			`${newLocal.length} item(s) are new on this device. Push uploads them.`,
		);
	}
	if (duplicateDrivePaths.length) {
		verdict.push(
			`${duplicateDrivePaths.length} path(s) exist more than once on Drive. Resolve these in Google Drive by hand.`,
		);
	}
	if (!settings.hasChangesToken) {
		verdict.push('No changes token saved yet: the first Pull will compare by modified time only.');
	}
	if (settings.startupPull) {
		verdict.push('Startup pull is ON (sync is not manual-only on this device).');
	}
	if (settings.autoPush) {
		verdict.push('Auto-push is ON (sync is not manual-only on this device).');
	}

	const environmentLines: string[] = [];
	const env = input.environment;
	if (env?.deleteToTrash !== undefined) {
		environmentLines.push(
			env.deleteToTrash
				? 'Drive deletions: moved to the Drive Trash (every device that syncs this vault must run this plugin version, otherwise it will not see those deletions).'
				: 'Drive deletions: permanent (Trash mode is off).',
		);
	}
	if (env?.obsidianTrashOption === 'none') {
		verdict.push(
			"Obsidian's \"Deleted files\" option is \"Permanently delete\": a Pull that removes files here cannot be undone. Consider \"Move to Obsidian trash\" (Settings > Files and links).",
		);
	}
	if (env && env.clockSkewMs !== undefined) {
		if (env.clockSkewMs === null) {
			environmentLines.push('Clock check: could not be measured.');
		} else if (Math.abs(env.clockSkewMs) > CLOCK_SKEW_LIMIT_MS) {
			verdict.push(
				`This device's clock is about ${describeSkew(env.clockSkewMs)} Google's. Turn on automatic date and time. A wrong clock can make Pull miss changes or create extra "(Drive date)" copies.`,
			);
		} else {
			environmentLines.push('Clock check: this device agrees with Google (within a minute).');
		}
	}
	if (env?.falseMarks && env.falseMarks.length > 0) {
		const shown = env.falseMarks.slice(0, 5).join(', ');
		environmentLines.push(
			`Pending list: ${env.falseMarks.length} note${env.falseMarks.length === 1 ? ' is' : 's are'} marked as changed here but identical to the last sync (${shown}${env.falseMarks.length > 5 ? ', ...' : ''}). This is a false alarm: Pull takes the Drive version for them without making a "(Drive date)" copy.`,
		);
	}
	if (env?.unrememberedMarks && env.unrememberedMarks.length > 0) {
		const shown = env.unrememberedMarks.slice(0, 5).join(', ');
		environmentLines.push(
			`Pending list: ${env.unrememberedMarks.length} note${env.unrememberedMarks.length === 1 ? ' is' : 's are'} marked as changed here, and this device remembers nothing about their last sync (${shown}${env.unrememberedMarks.length > 5 ? ', ...' : ''}). A Pull cannot tell an edit from a false mark for them and keeps a "(Drive date)" copy each time. Run "Repair sync memory" (command palette or settings).`,
		);
	}
	if (env && env.responseMs !== undefined) {
		environmentLines.push(
			env.responseMs === null
				? 'Connection: a small request to Google Drive failed. Check the internet connection, VPN or firewall.'
				: `Connection: Google Drive answered in ${env.responseMs < 1000 ? `${Math.round(env.responseMs)} ms` : `${(env.responseMs / 1000).toFixed(1)} s`}${env.responseMs > 5000 ? ' (slow: large syncs may need several tries on this connection)' : ''}.`,
		);
	}
	if (env && env.vaultEvents !== undefined) {
		environmentLines.push(
			`Change tracking: ${env.vaultEvents} vault event${env.vaultEvents === 1 ? '' : 's'} seen since the plugin loaded.` +
				(env.vaultEvents === 0
					? ' If you have edited notes since then, tracking is not working: restart Obsidian and run Sync doctor again.'
					: ''),
		);
	}
	if (env && env.grantedScopes !== undefined) {
		const { line, warning } = describeGrantedScopes(env.grantedScopes);
		environmentLines.push(line);
		if (warning) verdict.push(warning);
	}
	if (env && env.encryption) {
		environmentLines.push(
			env.encryption === 'unlocked'
				? 'End-to-end encryption: on, and this device has the key. Drive holds only encrypted files and names; the paths above were decrypted on this device.'
				: 'End-to-end encryption: on, but this device does not have the key.',
		);
	}
	if (env && env.unrecordedEdits?.length) {
		const sample = env.unrecordedEdits.slice(0, 5).join(', ');
		const more = env.unrecordedEdits.length > 5 ? ` and ${env.unrecordedEdits.length - 5} more` : '';
		environmentLines.push(
			`Edited on this device after the last sync but not in the pending list: ${env.unrecordedEdits.length} (${sample}${more}). Push compares these with Drive and adds the ones that really differ.`,
		);
	}

	return {
		pluginVersion: input.pluginVersion,
		lastSyncedAt: settings.lastSyncedAt
			? new Date(settings.lastSyncedAt).toISOString()
			: 'never',
		startupPull: settings.startupPull,
		autoPush: settings.autoPush,
		hasRefreshToken: settings.hasRefreshToken,
		hasChangesToken: settings.hasChangesToken,
		counts: {
			local: local.size,
			drive: drivePaths.size,
			mappedIds: Object.keys(settings.driveIdToPath).length,
		},
		operationCounts,
		pendingOperations: Object.entries(settings.operations).sort(([a], [b]) =>
			a.localeCompare(b),
		),
		deletedOnDrive: sort(deletedOnDrive),
		newLocal: sort(newLocal),
		onlyOnDrive: sort(onlyOnDrive),
		duplicateDrivePaths,
		staleMapIds,
		verdict,
		environmentLines,
	};
};

const LIST_LIMIT = 60;

const section = (title: string, lines: string[]) => {
	if (!lines.length) return [`${title}: none`];
	const shown = lines.slice(0, LIST_LIMIT).map((line) => `  - ${line}`);
	if (lines.length > LIST_LIMIT) {
		shown.push(`  ... and ${lines.length - LIST_LIMIT} more`);
	}
	return [`${title} (${lines.length}):`, ...shown];
};

export const renderReport = (report: DoctorReport): string => {
	const lines = [
		'Google Drive Sync doctor (read-only)',
		`Plugin version: ${report.pluginVersion}`,
		`Last synced: ${report.lastSyncedAt}`,
		`Refresh token: ${report.hasRefreshToken ? 'present' : 'MISSING'}; changes token: ${report.hasChangesToken ? 'present' : 'missing'}`,
		`Startup pull: ${report.startupPull ? 'on' : 'off'}; auto-push: ${report.autoPush ? 'on' : 'off'}`,
		...report.environmentLines,
		`Paths on this device: ${report.counts.local}; on Drive: ${report.counts.drive}; ids in saved map: ${report.counts.mappedIds}`,
		`Pending operations: create ${report.operationCounts.create}, modify ${report.operationCounts.modify}, delete ${report.operationCounts.delete}`,
		'',
		'Verdict:',
		...report.verdict.map((v) => `  * ${v}`),
		'',
		...section('Deleted on Drive, still here (Pull removes)', report.deletedOnDrive),
		...section('Only on Drive (Pull downloads)', report.onlyOnDrive),
		...section('New on this device (Push uploads)', report.newLocal),
		...section(
			'Duplicate paths on Drive',
			report.duplicateDrivePaths.map(({ path, ids }) => `${path} (${ids.length}x)`),
		),
		...section(
			'Pending operations',
			report.pendingOperations.map(([path, op]) => `${op}: ${path}`),
		),
		`Stale ids in saved map (harmless, informational): ${report.staleMapIds.length}`,
	];
	return lines.join('\n');
};
