import { Modal, Notice } from 'obsidian';
import type ObsidianGoogleDrive from '../main';
import {
	collectVaultComparison,
	countRows,
	exactCheckBytes,
	exactCompare,
	prettyBytes,
	renderVaultReport,
	type Row,
} from './compare-vault';

/** Lines shown per list in the window; the copied report has every line. */
const WINDOW_LIMIT = 200;

class CompareVaultModal extends Modal {
	private stop = false;
	private running = false;

	constructor(
		private readonly t: ObsidianGoogleDrive,
		private readonly rows: Row[],
		private readonly encrypted: boolean,
	) {
		super(t.app);
	}

	private text(limit = WINDOW_LIMIT) {
		return renderVaultReport(this.rows, { encrypted: this.encrypted, limit });
	}

	onOpen() {
		this.setTitle('Compare the whole vault with Google Drive');
		this.contentEl.createEl('p', {
			text: 'Read-only check. Nothing was changed on this device or on Google Drive.',
		});
		const report = this.contentEl.createEl('pre', { text: this.text(), cls: 'ogd-doctor-report' });
		const buttons = this.contentEl.createDiv();

		const bytes = exactCheckBytes(this.rows);
		const undecided = countRows(this.rows).unknown;
		if (undecided > 0) {
			const exact = buttons.createEl('button', {
				text: `Exact check (downloads ${undecided} file${undecided === 1 ? '' : 's'}, about ${prettyBytes(bytes)})`,
			});
			const cancel = buttons.createEl('button', { text: 'Stop' });
			cancel.addClass('ogd-hidden');
			cancel.addEventListener('click', () => {
				this.stop = true;
			});
			exact.addEventListener('click', () => {
				if (this.running) return;
				this.running = true;
				this.stop = false;
				exact.disabled = true;
				cancel.removeClass('ogd-hidden');
				void exactCompare(this.rows, {
					readLocal: (path) => {
						const file = this.t.app.vault.getFileByPath(path);
						if (!file) throw new Error('missing');
						return this.t.app.vault.readBinary(file);
					},
					download: (row) => this.t.drive.getFile(row.id!, row.path).arrayBuffer(),
					stopped: () => this.stop || this.t.syncing === true,
					onProgress: (done, total) => {
						exact.setText(`Checking ${done} of ${total} ...`);
						report.setText(this.text());
					},
				}).then(() => {
					this.running = false;
					cancel.addClass('ogd-hidden');
					report.setText(this.text());
					const left = countRows(this.rows).unknown;
					exact.setText(left ? `Exact check again (${left} not decided)` : 'Exact check finished');
					exact.disabled = left === 0;
				});
			});
		}
		const copy = buttons.createEl('button', { text: 'Copy report' });
		copy.addEventListener('click', () => {
			navigator.clipboard.writeText(this.text(Infinity)).then(
				() => new Notice('Report copied to clipboard.'),
				() => new Notice('Could not copy - clipboard unavailable.'),
			);
		});
	}

	onClose() {
		this.stop = true;
		this.contentEl.empty();
	}
}

/** Compares every synced file of this device with Google Drive (GET requests only), then shows the result. */
export const runCompareVault = async (t: ObsidianGoogleDrive) => {
	if (t.syncing) {
		new Notice('A sync is running. Try again when it has finished.');
		return;
	}
	const working = new Notice('Comparing this device with Google Drive ...', 0);
	try {
		const result = await collectVaultComparison(t);
		if ('error' in result) {
			new Notice(result.error, 8000);
			return;
		}
		new CompareVaultModal(t, result.rows, result.encrypted).open();
	} catch (error) {
		new Notice(`Compare failed: ${error instanceof Error ? error.message : 'unknown error'}`, 8000);
	} finally {
		working.hide();
	}
};
