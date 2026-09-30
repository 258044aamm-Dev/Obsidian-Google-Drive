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
}

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
