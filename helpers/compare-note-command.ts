import { Modal, Notice, TFile } from 'obsidian';
import type ObsidianGoogleDrive from '../main';
import { refreshAccessToken } from './requests';
import { sameBytes } from './conflict-copy';
import { isOwnUpload } from './sync-state';
import { renderCompare } from './compare-note';
import type { CompareFacts } from './compare-note';

class CompareModal extends Modal {
	constructor(
		plugin: ObsidianGoogleDrive,
		private readonly text: string,
	) {
		super(plugin.app);
	}

	onOpen() {
		this.setTitle('Compare with Google Drive');
		this.contentEl.createEl('pre', {
			text: this.text,
			cls: 'ogd-doctor-report',
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}

/** Compares the open note with its Google Drive copy using GET requests only, then shows the result. */
export const runCompareActiveNote = async (t: ObsidianGoogleDrive) => {
	if (t.syncing) {
		new Notice('A sync is running. Try again when it has finished.');
		return;
	}
	const file = t.app.workspace.getActiveFile();
	if (!(file instanceof TFile)) {
		new Notice('Open a note first, then run this command.');
		return;
	}
	if (t.settings.e2eeEnabled === true && !t.e2ee) {
		new Notice('Encryption is locked on this device. Unlock it in the plugin settings first.', 8000);
		return;
	}
	try {
		if (!t.accessToken.token && !(await refreshAccessToken(t))) {
			new Notice('Authentication failed. Re-authenticate in plugin settings.', 8000);
			return;
		}
		const id = Object.entries(t.settings.driveIdToPath).find(
			([, path]) => path === file.path,
		)?.[0];
		const facts: CompareFacts = {
			path: file.path,
			encrypted: t.settings.e2eeEnabled === true,
			pending: t.settings.operations[file.path],
			localMtime: file.stat.mtime,
			localSize: file.stat.size,
			baseline: t.settings.syncedFiles?.[file.path],
			knownOnDrive: !!id,
			ownUpload: false,
		};
		if (id) {
			try {
				const status = await t.drive.getFileStatus(id);
				if (!status) throw new Error('no answer');
				facts.drive = status;
				facts.ownUpload = isOwnUpload(t, id, status.modifiedTime);
				const remote = await t.drive.getFile(id, file.path).arrayBuffer();
				if (remote) {
					facts.same = sameBytes(await t.app.vault.readBinary(file), remote);
				}
			} catch (error) {
				facts.error = error instanceof Error ? error.message : 'unknown error';
			}
		}
		new CompareModal(t, renderCompare(facts)).open();
	} catch (error) {
		new Notice(
			`Compare failed: ${error instanceof Error ? error.message : 'unknown error'}`,
			8000,
		);
	}
};
