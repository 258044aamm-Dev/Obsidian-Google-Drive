import { Modal, Notice, Setting } from 'obsidian';
import type ObsidianGoogleDrive from '../main';
import { push } from './push';
import {
	historyRetentionDays,
	listRestorePoints,
	recordRestorePoint,
	type RestorePointInfo,
} from './history';
import { planIsEmpty, planSummary, type RestorePlan } from './history-plan';
import {
	applyRestorePlan,
	buildRestorePlan,
	ensureToken,
	prepareRestore,
	restoreBlocker,
	type RestoreResult,
} from './history-restore';

const LIST_LIMIT = 12;

const when = (ms: number) => new Date(ms).toLocaleString();

const plural = (n: number, one: string, many = one + 's') =>
	`${n} ${n === 1 ? one : many}`;

/** "Create restore point now" (command and settings button). */
export const createRestorePointNow = async (t: ObsidianGoogleDrive) => {
	if (t.syncing) {
		new Notice('A sync is running. Try again when it has finished.');
		return;
	}
	t.syncing = true;
	t.setSpinning(true);
	try {
		if (!(await ensureToken(t))) {
			new Notice('Authentication failed. Re-authenticate in the plugin settings.', 8000);
			return;
		}
		const result = await recordRestorePoint(t);
		new Notice(
			result.status === 'created'
				? `Restore point saved (${plural(result.info.count, 'item')}). It describes Google Drive as it is now.`
				: `Nothing has changed on Drive since the last restore point (${when(result.info.createdAt)}).`,
			6000,
		);
	} catch (error) {
		new Notice(
			`Could not save a restore point: ${error instanceof Error ? error.message : 'unknown error'}`,
			8000,
		);
	} finally {
		t.setSpinning(false);
		t.syncing = false;
	}
};

/** Entry point of the "Restore vault" command. */
export const startVaultRestore = async (t: ObsidianGoogleDrive) => {
	const blocker = restoreBlocker(t);
	if (blocker) {
		new Notice(blocker, 8000);
		return;
	}
	try {
		if (!(await ensureToken(t))) {
			new Notice('Authentication failed. Re-authenticate in the plugin settings.', 8000);
			return;
		}
		const points = await listRestorePoints(t);
		if (!points.length) {
			new Notice(
				'There are no restore points yet. One is saved after every push.',
				8000,
			);
			return;
		}
		new RestoreModal(t, points).open();
	} catch (error) {
		new Notice(
			`Could not read the restore points: ${error instanceof Error ? error.message : 'unknown error'}`,
			8000,
		);
	}
};

class RestoreModal extends Modal {
	private includeConfig = true;
	private busy = false;

	constructor(
		private readonly t: ObsidianGoogleDrive,
		private readonly points: RestorePointInfo[],
	) {
		super(t.app);
	}

	onOpen() {
		this.setTitle('Restore the whole vault');
		this.renderList();
	}

	onClose() {
		this.contentEl.empty();
	}

	private heading(text: string) {
		this.contentEl.empty();
		this.contentEl.createEl('p', { text });
	}

	private renderList() {
		const { contentEl } = this;
		this.heading(
			`Choose the moment to go back to. Restore points are kept for ${plural(historyRetentionDays(this.t), 'day')}. Nothing is uploaded until you press Push afterwards.`,
		);
		new Setting(contentEl)
			.setName('Also restore settings and plugin files')
			.setDesc(
				`The files in the ${this.t.app.vault.configDir} folder that this plugin syncs. Settings files, other plugins, themes and snippets, as far as their sync switches in the plugin settings are on. Restart Obsidian afterwards.`,
			)
			.addToggle((toggle) =>
				toggle.setValue(this.includeConfig).onChange((value) => {
					this.includeConfig = value;
				}),
			);
		for (const point of this.points.slice(0, LIST_LIMIT)) {
			new Setting(contentEl)
				.setName(when(point.createdAt))
				.setDesc(plural(point.count, 'item'))
				.addButton((button) =>
					button.setButtonText('Choose').onClick(() => void this.choose(point)),
				);
		}
		if (this.points.length > LIST_LIMIT) {
			contentEl.createEl('p', {
				text: `${this.points.length - LIST_LIMIT} older restore points are not shown.`,
			});
		}
	}

	private async choose(point: RestorePointInfo) {
		if (this.busy) return;
		this.busy = true;
		try {
			this.heading(
				'First a normal Pull brings this device level with Google Drive...',
			);
			const problem = await prepareRestore(this.t);
			if (problem) {
				new Notice(problem, 10000);
				this.renderList();
				return;
			}
			this.heading('Checking that the old versions are still available...');
			const { plan } = await buildRestorePlan(
				this.t,
				point,
				this.includeConfig,
				(done, total) =>
					this.heading(`Checking old versions (${done}/${total})...`),
			);
			this.renderPlan(point, plan);
		} catch (error) {
			new Notice(
				`Could not prepare the restore: ${error instanceof Error ? error.message : 'unknown error'}`,
				10000,
			);
			this.renderList();
		} finally {
			this.busy = false;
		}
	}

	private renderPlan(point: RestorePointInfo, plan: RestorePlan) {
		const { contentEl } = this;
		const sum = planSummary(plan);
		this.heading(`Restore to ${when(point.createdAt)}`);

		if (planIsEmpty(plan)) {
			contentEl.createEl('p', {
				text: `This device already matches that restore point (${plural(sum.unchanged, 'file')} unchanged).`,
			});
		} else {
			const lines = [
				`${plural(sum.revert, 'file')} go back to their old content`,
				`${plural(sum.recreate, 'deleted file')} come back`,
				`${plural(sum.remove, 'file')} created since then are removed (through Obsidian's "Deleted files" setting)`,
				`${plural(sum.unchanged, 'file')} stay as they are`,
			];
			if (sum.removeFolders) {
				lines.splice(3, 0, `${plural(sum.removeFolders, 'folder')} that did not exist then are removed if they end up empty`);
			}
			const list = contentEl.createEl('ul');
			lines.forEach((line) => list.createEl('li', { text: line }));
			const sample = (title: string, paths: string[]) => {
				if (!paths.length) return;
				contentEl.createEl('p', { text: `${title}:` });
				const ul = contentEl.createEl('ul');
				paths.slice(0, 8).forEach((path) => ul.createEl('li', { text: path }));
				if (paths.length > 8) ul.createEl('li', { text: `... and ${paths.length - 8} more` });
			};
			sample('Go back', plan.revert.map((i) => i.path));
			sample('Come back', plan.recreate.map((i) => i.path));
			sample('Removed', plan.remove.filter((r) => !r.isFolder).map((r) => r.path));
		}
		if (plan.skipped.length) {
			contentEl.createEl('p', {
				text: `${plural(plan.skipped.length, 'item')} cannot be restored and will be left as they are:`,
			});
			const ul = contentEl.createEl('ul');
			plan.skipped
				.slice(0, 8)
				.forEach((s) => ul.createEl('li', { text: `${s.path}: ${s.reason}` }));
			if (plan.skipped.length > 8) ul.createEl('li', { text: `... and ${plan.skipped.length - 8} more` });
		}
		contentEl.createEl('p', {
			text: 'Before anything changes, a restore point of the current state is saved, so you can undo this by restoring that one.',
		});

		const buttons = new Setting(contentEl).addButton((button) =>
			button.setButtonText('Back').onClick(() => this.renderList()),
		);
		if (!planIsEmpty(plan)) {
			buttons.addButton((button) =>
				button
					.setButtonText('Restore on this device')
					.setDestructive()
					.onClick(() => void this.apply(plan)),
			);
		}
	}

	private async apply(plan: RestorePlan) {
		if (this.busy) return;
		this.busy = true;
		try {
			this.heading('Restoring... do not close Obsidian.');
			const result = await applyRestorePlan(this.t, plan, (done, total) =>
				this.heading(`Restoring... (${done}/${total})`),
			);
			this.renderResult(result, plan);
		} catch (error) {
			this.heading(
				`Nothing was restored: ${error instanceof Error ? error.message : 'unknown error'}`,
			);
		} finally {
			this.busy = false;
		}
	}

	private renderResult(result: RestoreResult, plan: RestorePlan) {
		const { contentEl } = this;
		this.heading('Restore finished on this device. Nothing has been uploaded yet.');
		const list = contentEl.createEl('ul');
		list.createEl('li', { text: `${plural(result.reverted, 'file')} went back to their old content` });
		list.createEl('li', { text: `${plural(result.recreated, 'file')} came back` });
		list.createEl('li', { text: `${plural(result.removed, 'file')} removed` });
		if (result.failed.length) {
			contentEl.createEl('p', {
				text: `${plural(result.failed.length, 'item')} could not be restored${result.stoppedEarly ? ' (the restore stopped early)' : ''}. Push what was done, then run the restore again:`,
			});
			const ul = contentEl.createEl('ul');
			result.failed.slice(0, 8).forEach((f) => ul.createEl('li', { text: `${f.path}: ${f.error}` }));
		}
		if (result.safetyPoint) {
			contentEl.createEl('p', {
				text: `To undo this restore, restore the point from ${when(result.safetyPoint.createdAt)}.`,
			});
		}
		if (plan.includeConfig && [...plan.revert, ...plan.recreate].some((i) => i.config)) {
			contentEl.createEl('p', {
				text: 'Settings or plugin files were restored: restart Obsidian for them to take effect.',
			});
		}
		contentEl.createEl('p', {
			text: 'Look through the vault. When it is right, press push: the confirmation lists everything that will change on Google Drive.',
		});
		new Setting(contentEl)
			.addButton((button) => button.setButtonText('Close').onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText('Review and push now')
					.setCta()
					.onClick(() => {
						this.close();
						void push(this.t);
					}),
			);
	}
}
