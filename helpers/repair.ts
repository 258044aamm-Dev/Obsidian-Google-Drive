/**
 * "Repair sync memory": settles the notes that are marked as changed on this device (`create` /
 * `modify`) when the mark cannot be trusted. Older versions marked every note a Pull wrote, and a
 * device that never pushes keeps those marks for ever. With no remembered synced state for such a
 * note, Pull cannot tell an edit from a false mark and keeps a "(Drive date)" copy every time.
 *
 * For each marked note that Drive knows:
 *  - unchanged since the last sync, or byte-for-byte what Drive has: the mark is dropped and the
 *    synced state is recorded;
 *  - edited here since the last sync (a remembered fingerprint that no longer matches): kept;
 *  - different from Drive, and older here than on Drive: Drive's version replaces it and this
 *    device's version is saved next to it as "Note (this device DATE).md" (nothing is lost);
 *  - different from Drive, and as new or newer here: kept (the mark stays, Push uploads it).
 * Nothing is deleted. The plan is made first (reading only) and shown; nothing changes until the
 * user agrees, and a note changed in the meantime is left alone.
 */
import { Modal, Notice, Setting } from 'obsidian';
import type ObsidianGoogleDrive from '../main';
import { saveConflictCopy, sameBytes } from './conflict-copy';
import { batchAsync } from './drive';
import { isOwnPluginPath } from './own-plugin';
import { hashOf, knownToDrive, recordSynced, stampOf } from './sync-state';

export type RepairAction = 'identical' | 'take-drive' | 'keep-here' | 'failed';

export interface RepairItem {
	path: string;
	id: string;
	action: RepairAction;
	/** Why, in words (shown in the diagnostics). */
	why: string;
	/** Fingerprint of this device's note when it was read, to notice a change before anything is written. */
	localHash?: string;
	localMtime?: number;
	driveContent?: ArrayBuffer;
	driveModified?: string;
}

export interface RepairPlan {
	items: RepairItem[];
}

export interface RepairResult {
	cleared: number;
	updatedFromDrive: number;
	keptHere: number;
	failed: number;
	/** left alone because the note changed after the plan was made */
	skipped: number;
	copies: string[];
}

const idOfPath = (t: ObsidianGoogleDrive, path: string) =>
	Object.entries(t.settings.driveIdToPath).find(([, p]) => p === path)?.[0];

/** The marked notes this repair looks at: create/modify marks of notes that exist here and that Drive knows. */
export const repairCandidates = (t: ObsidianGoogleDrive): { path: string; id: string }[] => {
	const { vault } = t.app;
	const out: { path: string; id: string }[] = [];
	for (const [path, operation] of Object.entries(t.settings.operations)) {
		if (operation !== 'modify' && operation !== 'create') continue;
		if (path === vault.configDir || path.startsWith(vault.configDir + '/')) continue;
		if (isOwnPluginPath(t, path) || !knownToDrive(t, path)) continue;
		if (!vault.getFileByPath(path)) continue;
		const id = idOfPath(t, path);
		if (id) out.push({ path, id });
	}
	return out.sort((a, b) => a.path.localeCompare(b.path));
};

const judge = async (
	t: ObsidianGoogleDrive,
	path: string,
	id: string,
): Promise<RepairItem> => {
	const { vault } = t.app;
	const file = vault.getFileByPath(path);
	if (!file) return { path, id, action: 'failed', why: 'the note is no longer here' };
	const local = await vault.readBinary(file);
	const localHash = await hashOf(local);
	const localMtime = file.stat.mtime;
	const item = (action: RepairAction, why: string, extra: Partial<RepairItem> = {}): RepairItem => ({
		path,
		id,
		action,
		why,
		localHash,
		localMtime,
		...extra,
	});

	const base = t.settings.syncedFiles?.[path];
	if (base?.h && localHash) {
		return localHash === base.h
			? item('identical', 'unchanged since the last sync')
			: item('keep-here', 'edited here since the last sync');
	}
	if (base && !base.h && base.m === file.stat.mtime && base.s === file.stat.size) {
		return item('identical', 'unchanged since the last sync');
	}

	const status = await t.drive.getFileStatus(id);
	if (!status || status.trashed) return item('failed', 'Drive has no live copy of this note');
	const driveContent = await t.drive.getFile(id, path).arrayBuffer();
	if (!driveContent) return item('failed', 'the Drive version could not be downloaded');
	if (sameBytes(local, driveContent)) return item('identical', 'same as the Drive version');

	const driveTime = Date.parse(status.modifiedTime ?? '');
	if (Number.isFinite(driveTime) && localMtime < driveTime) {
		return item('take-drive', 'older here than on Drive', {
			driveContent,
			driveModified: status.modifiedTime,
		});
	}
	return item('keep-here', 'as new or newer here than on Drive');
};

/** Reads only. Looks at every candidate and says what the repair would do with it. */
export const planRepair = async (
	t: ObsidianGoogleDrive,
	onProgress?: (done: number, total: number) => void,
): Promise<RepairPlan> => {
	const candidates = repairCandidates(t);
	let done = 0;
	const items = await batchAsync<RepairItem>(
		candidates.map(({ path, id }) => async () => {
			let result: RepairItem;
			try {
				result = await judge(t, path, id);
			} catch (error) {
				result = {
					path,
					id,
					action: 'failed',
					why: error instanceof Error ? error.message : 'unknown error',
				};
			}
			onProgress?.(++done, candidates.length);
			return result;
		}),
		5,
	);
	return { items };
};

const count = (plan: RepairPlan, action: RepairAction) =>
	plan.items.filter((i) => i.action === action).length;

/** The text of the confirmation window. */
export const summarizePlan = (plan: RepairPlan): string[] => {
	const lines = [`${plan.items.length} note${plan.items.length === 1 ? ' is' : 's are'} marked as changed on this device.`];
	const identical = count(plan, 'identical');
	const take = count(plan, 'take-drive');
	const keep = count(plan, 'keep-here');
	const failed = count(plan, 'failed');
	if (identical) lines.push(`${identical} are unchanged or the same as Drive: the mark is removed.`);
	if (take) {
		lines.push(
			`${take} are older here than on Drive: the Drive version replaces them, and your old version is saved next to each as "… (this device date)".`,
		);
	}
	if (keep) lines.push(`${keep} are new or edited here: kept as they are, Push will upload them.`);
	if (failed) lines.push(`${failed} could not be checked and stay as they are.`);
	return lines;
};

/** Writes what the plan says. A note that changed since the plan was made is left alone. */
export const applyRepair = async (
	t: ObsidianGoogleDrive,
	plan: RepairPlan,
): Promise<RepairResult> => {
	const { vault } = t.app;
	const result: RepairResult = {
		cleared: 0,
		updatedFromDrive: 0,
		keptHere: 0,
		failed: 0,
		skipped: 0,
		copies: [],
	};

	for (const item of plan.items) {
		if (item.action === 'keep-here') {
			result.keptHere++;
			continue;
		}
		if (item.action === 'failed') {
			result.failed++;
			continue;
		}
		try {
			const file = vault.getFileByPath(item.path);
			if (!file) {
				result.skipped++;
				continue;
			}
			const local = await vault.readBinary(file);
			const nowHash = await hashOf(local);
			const changedSince = item.localHash
				? nowHash !== item.localHash
				: file.stat.mtime !== item.localMtime;
			if (changedSince) {
				result.skipped++;
				continue;
			}

			if (item.action === 'identical') {
				delete t.settings.operations[item.path];
				recordSynced(t, item.path, stampOf(file), nowHash);
				result.cleared++;
				continue;
			}

			// take-drive: keep this device's version as a copy first, then replace the note
			if (!item.driveContent) {
				result.failed++;
				continue;
			}
			const saved = await saveConflictCopy(t, item.path, local, new Date(), 'this device');
			result.copies.push(saved.path);
			delete t.settings.operations[item.path];
			await t.modifyFile(file, item.driveContent, item.driveModified);
			delete t.settings.operations[item.path];
			result.updatedFromDrive++;
			t.diagnostics.record({
				phase: 'download',
				operation: 'repair-sync-memory',
				message: `Took the Drive version (${item.why}); the version from this device was saved as a copy`,
			});
		} catch (error) {
			result.failed++;
			t.diagnostics.record({
				phase: 'download',
				operation: 'repair-sync-memory',
				message: `Could not repair a note: ${error instanceof Error ? error.message : 'unknown error'}`,
			});
		}
	}

	t.updateStatusBar();
	return result;
};

export const describeResult = (r: RepairResult) => {
	const parts: string[] = [];
	if (r.cleared) parts.push(`${r.cleared} false mark${r.cleared === 1 ? '' : 's'} removed`);
	if (r.updatedFromDrive) {
		parts.push(
			`${r.updatedFromDrive} note${r.updatedFromDrive === 1 ? '' : 's'} updated from Drive (your old versions saved as copies)`,
		);
	}
	if (r.keptHere) parts.push(`${r.keptHere} kept as they are`);
	if (r.skipped) parts.push(`${r.skipped} changed meanwhile and left alone`);
	if (r.failed) parts.push(`${r.failed} could not be checked`);
	return `Repair finished: ${parts.join(', ') || 'nothing to do'}.`;
};

class RepairModal extends Modal {
	private answered = false;

	constructor(
		t: ObsidianGoogleDrive,
		private readonly plan: RepairPlan,
		private readonly done: (ok: boolean) => void,
	) {
		super(t.app);
	}

	onOpen() {
		this.setTitle('Repair sync memory');
		for (const line of summarizePlan(this.plan)) {
			this.contentEl.createEl('p', { text: line });
		}
		const show = (action: RepairAction, heading: string) => {
			const paths = this.plan.items.filter((i) => i.action === action).map((i) => i.path);
			if (!paths.length) return;
			this.contentEl.createEl('p', { text: heading });
			const list = this.contentEl.createEl('ul');
			for (const path of paths.slice(0, 8)) list.createEl('li', { text: path });
			if (paths.length > 8) list.createEl('li', { text: `... and ${paths.length - 8} more` });
		};
		show('take-drive', 'Replaced by the Drive version (old version kept as a copy):');
		show('keep-here', 'Kept as they are:');
		new Setting(this.contentEl)
			.addButton((button) => button.setButtonText('Cancel').onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText('Repair')
					.setCta()
					.onClick(() => {
						this.answered = true;
						this.done(true);
						this.close();
					}),
			);
	}

	onClose() {
		this.contentEl.empty();
		if (!this.answered) this.done(false);
	}
}

const askToRepair = (t: ObsidianGoogleDrive, plan: RepairPlan) =>
	new Promise<boolean>((resolve) => {
		new RepairModal(t, plan, resolve).open();
	});

/** The command: check, show what would happen, ask, then repair. */
export const runRepairSyncMemory = async (
	t: ObsidianGoogleDrive,
	confirm: (t: ObsidianGoogleDrive, plan: RepairPlan) => Promise<boolean> = askToRepair,
): Promise<RepairResult | undefined> => {
	if (t.syncing) {
		new Notice('A sync is running. Try again when it has finished.');
		return undefined;
	}
	if (!repairCandidates(t).length) {
		new Notice('Nothing to repair: no note is marked as changed on this device.');
		return undefined;
	}
	let syncNotice: Notice;
	try {
		syncNotice = await t.startSync('Checking sync memory');
	} catch {
		return undefined; // startSync already told the user why
	}
	try {
		const plan = await planRepair(t, (done, total) =>
			syncNotice.setMessage(`Checking sync memory... ${done}/${total}`),
		);
		syncNotice.setMessage('Waiting for your answer...');
		if (!(await confirm(t, plan))) {
			new Notice('Nothing was changed.');
			return undefined;
		}
		syncNotice.setMessage('Repairing...');
		const result = await applyRepair(t, plan);
		new Notice(describeResult(result), 10000);
		return result;
	} catch (error) {
		t.diagnostics.record({
			phase: 'download',
			operation: 'repair-sync-memory',
			message: `Repair failed: ${error instanceof Error ? error.message : 'unknown error'}`,
		});
		new Notice('Repair could not finish. Nothing else was changed. Check diagnostics.', 8000);
		return undefined;
	} finally {
		// the position in Drive's change list is not moved: this is not a Pull
		await t.endSync(syncNotice, false, false);
	}
};
