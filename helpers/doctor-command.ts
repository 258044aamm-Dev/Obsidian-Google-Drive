import { Modal, Notice, TFile, TFolder } from 'obsidian';
import type ObsidianGoogleDrive from '../main';
import { unSplitPath, folderMimeType } from './drive';
import { refreshAccessToken } from './requests';
import { buildDoctorReport, renderReport } from './doctor';
import { isOwnPluginPath } from './own-plugin';

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
		});
		new DoctorModal(t, renderReport(report)).open();
	} catch (error) {
		new Notice(
			`Sync doctor failed: ${error instanceof Error ? error.message : 'unknown error'}`,
			8000,
		);
	}
};
