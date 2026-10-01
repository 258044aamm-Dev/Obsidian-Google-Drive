import { Modal, Notice, requestUrl, TFile, TFolder } from 'obsidian';
import type ObsidianGoogleDrive from '../main';
import { unSplitPath, folderMimeType } from './drive';
import { getDriveAgent, refreshAccessToken } from './requests';
import { buildDoctorReport, clockSkewMs, parseScopes, renderReport } from './doctor';
import { isOwnPluginPath } from './own-plugin';
import { unrecordedEditCandidates } from './missed-edits';

class DoctorModal extends Modal {
	constructor(
		plugin: ObsidianGoogleDrive,
		private readonly text: string,
	) {
		super(plugin.app);
	}

	onOpen() {
		this.setTitle('Sync doctor');
		this.contentEl.createEl('p', {
			text: 'Read-only check. Nothing was changed on this device or on Google Drive.',
		});
		this.contentEl.createEl('pre', {
			text: this.text,
			cls: 'ogd-doctor-report',
		});
		const copy = this.contentEl.createEl('button', {
			text: 'Copy report',
		});
		copy.addEventListener('click', () => {
			navigator.clipboard.writeText(this.text).then(
				() => new Notice('Report copied to clipboard.'),
				() => new Notice('Could not copy - clipboard unavailable.'),
			);
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** One small GET: compares this device's clock with the `Date` header Google answers with. Never throws. */
const measureClockSkew = async (
	t: ObsidianGoogleDrive,
): Promise<{ skew: number | null; responseMs: number | null }> => {
	try {
		const sentAt = Date.now();
		const response = await getDriveAgent(t).get('/drive/v3/changes/startPageToken');
		const receivedAt = Date.now();
		const headers = response.headers ?? {};
		const key = Object.keys(headers).find((k) => k.toLowerCase() === 'date');
		return {
			skew: clockSkewMs(sentAt, receivedAt, key ? headers[key] : undefined),
			responseMs: receivedAt - sentAt,
		};
	} catch {
		return { skew: null, responseMs: null };
	}
};

/** Asks Google which permissions this device's access token has (one GET to Google; never throws). */
const readGrantedScopes = async (t: ObsidianGoogleDrive): Promise<string[] | null> => {
	try {
		const token = t.accessToken.token;
		if (!token) return null;
		const response = await requestUrl({
			url: `https://oauth2.googleapis.com/tokeninfo?access_token=${encodeURIComponent(token)}`,
			method: 'GET',
			throw: false,
		});
		if (response.status < 200 || response.status >= 300) return null;
		const info = response.json as { scope?: unknown } | undefined;
		return parseScopes(info?.scope);
	} catch {
		return null;
	}
};

/** Compares this device with Google Drive using GET requests only, then shows the result. */
export const runSyncDoctor = async (t: ObsidianGoogleDrive) => {
	if (t.syncing) {
		new Notice('A sync is running. Try again when it has finished.');
		return;
	}
	try {
		if (!t.accessToken.token && !(await refreshAccessToken(t))) {
			new Notice(
				'Sync doctor: authentication failed. Re-authenticate in plugin settings.',
				8000,
			);
			return;
		}
		const driveFiles = await t.drive.searchFiles({
			include: ['id', 'properties', 'mimeType'],
		});
		if (!driveFiles) {
			new Notice('Could not list drive files for the sync doctor.', 8000);
			return;
		}
		const { vault } = t.app;
		const { skew: clockSkew, responseMs } = await measureClockSkew(t);
		const grantedScopes = await readGrantedScopes(t);
		const localPaths = vault
			.getAllLoadedFiles()
			.filter((f) => f instanceof TFile || f instanceof TFolder)
			.map((f) => f.path)
			.filter((p) => p !== '/' && p !== '' && !isOwnPluginPath(t, p));

		const report = buildDoctorReport({
			pluginVersion: t.manifest?.version ?? 'unknown',
			settings: {
				operations: t.settings.operations,
				driveIdToPath: t.settings.driveIdToPath,
				lastSyncedAt: t.settings.lastSyncedAt,
				hasRefreshToken: !!t.settings.refreshToken,
				hasChangesToken: !!t.settings.changesToken,
				startupPull: !!t.settings.startupPull,
				autoPush: !!t.settings.autoPush,
			},
			localPaths,
			drive: driveFiles
				.filter(({ properties }) => properties?.config !== 'true')
				.map(({ id, properties, mimeType }) => ({
					id,
					path: unSplitPath(properties),
					isFolder: mimeType === folderMimeType,
				})),
			environment: {
				deleteToTrash: t.settings.deleteToTrash === true,
				obsidianTrashOption: (
					vault as unknown as { getConfig?: (key: string) => unknown }
				).getConfig?.('trashOption') as string | undefined,
				clockSkewMs: clockSkew,
				responseMs,
				unrecordedEdits: unrecordedEditCandidates(t),
				vaultEvents: t.vaultEventCount,
				grantedScopes,
				...(t.settings.e2eeEnabled === true && { encryption: t.e2ee ? ('unlocked' as const) : ('locked' as const) }),
			},
		});
		new DoctorModal(t, renderReport(report)).open();
	} catch (error) {
		new Notice(
			`Sync doctor failed: ${error instanceof Error ? error.message : 'unknown error'}`,
			8000,
		);
	}
};
