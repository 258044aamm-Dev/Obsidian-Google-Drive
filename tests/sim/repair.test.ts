/**
 * 3.8.3: "Repair sync memory". A phone that holds old `modify` marks and remembers nothing about
 * its notes' last sync kept a "(Drive date)" copy at every Pull and never updated the note.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.stubGlobal('window', globalThis);
vi.mock('obsidian', async () => await import('./obsidian-mock'));
import { sleep, dec, notices } from './world';
import { setup, simDefaults, ROOT } from './scenario-helpers';
import { findUnrememberedMarks } from '../../helpers/sync-state';

const copies = (tree: string[]) => tree.filter((p) => /\((Drive|this device) \d{4}-\d{2}-\d{2}(-\d+)?\)/.test(p));
const read = (d: { vault: { disk: Map<string, any> } }, p: string) => {
	const f = d.vault.disk.get(p);
	return f ? dec(f.data as Uint8Array) : undefined;
};
const edit = async (d: any, path: string, text: string) => {
	await d.vault.modify(d.vault.getFileByPath(path), text);
	await sleep(20);
};
/** The state of the phone in the report: old marks, nothing remembered about the last sync. */
const makeStuck = (mobile: any, paths: string[]) => {
	for (const p of paths) mobile.plugin.settings.operations[p] = 'modify';
	mobile.plugin.settings.syncedFiles = {};
};
const yes = async () => true;

const repairModule = () => import(ROOT + '/helpers/repair.ts');

beforeEach(() => {
	simDefaults.deleteToTrash = true;
});

describe('Repair sync memory', () => {
	it('a note the phone is behind on: the Drive version replaces it, the old version is kept as a copy, and the loop ends', async () => {
		const { desktop, mobile } = await setup();
		const { runRepairSyncMemory } = await repairModule();
		await edit(desktop, 'Inbox/a.md', 'a v2');
		await desktop.push();
		makeStuck(mobile, ['Inbox/a.md']);
		expect(read(mobile, 'Inbox/a.md')).toBe('a');

		const result = await runRepairSyncMemory(mobile.plugin, yes);
		await sleep(40);
		expect(result.updatedFromDrive).toBe(1);
		expect(read(mobile, 'Inbox/a.md')).toBe('a v2');
		const kept = copies(mobile.tree()).filter((p) => p.includes('this device'));
		expect(kept).toHaveLength(1);
		expect(read(mobile, kept[0]!)).toBe('a'); // nothing lost

		// the next change from the desktop now simply arrives: no "(Drive date)" copy
		await edit(desktop, 'Inbox/a.md', 'a v3');
		await desktop.push();
		await mobile.pull();
		await sleep(80);
		expect(read(mobile, 'Inbox/a.md')).toBe('a v3');
		expect(copies(mobile.tree()).filter((p) => p.includes('(Drive '))).toEqual([]);
		expect(notices.join('\n')).not.toMatch(/kept|copy|copies/i);
	});

	it('the stale marks of notes that equal Drive are removed without any copy', async () => {
		const { mobile } = await setup();
		const { runRepairSyncMemory } = await repairModule();
		makeStuck(mobile, ['Inbox/a.md', 'Inbox/b.md', 'root.md']);
		const result = await runRepairSyncMemory(mobile.plugin, yes);
		await sleep(40);
		expect(result.cleared).toBe(3);
		expect(copies(mobile.tree())).toEqual([]);
		expect(mobile.ops()).toEqual({});
		for (const p of ['Inbox/a.md', 'Inbox/b.md', 'root.md']) {
			expect(mobile.plugin.settings.syncedFiles[p]?.h).toBeTruthy(); // remembered now
		}
	});

	it('a note edited on the phone after Drive\'s version stays as it is, mark kept, nothing copied', async () => {
		const { desktop, mobile } = await setup();
		const { runRepairSyncMemory } = await repairModule();
		await edit(desktop, 'Inbox/a.md', 'a from desktop');
		await desktop.push();
		await sleep(30);
		await edit(mobile, 'Inbox/a.md', 'a typed on the phone');
		makeStuck(mobile, ['Inbox/a.md']);

		const result = await runRepairSyncMemory(mobile.plugin, yes);
		await sleep(40);
		expect(result.keptHere).toBe(1);
		expect(read(mobile, 'Inbox/a.md')).toBe('a typed on the phone');
		expect(copies(mobile.tree())).toEqual([]);
		expect(mobile.ops()['Inbox/a.md']).toBe('modify');
	});

	it('an edit made here since the last sync (a remembered fingerprint that no longer matches) is kept without a download', async () => {
		const { mobile } = await setup();
		const { planRepair } = await repairModule();
		await edit(mobile, 'Inbox/b.md', 'b changed here');
		mobile.plugin.settings.operations['Inbox/b.md'] = 'modify';
		const plan = await planRepair(mobile.plugin);
		const item = plan.items.find((i: any) => i.path === 'Inbox/b.md');
		expect(item.action).toBe('keep-here');
		expect(item.why).toMatch(/edited here/);
		expect(item.driveContent).toBeUndefined();
	});

	it('a mark on a note that is unchanged since the last sync is cleared without a download', async () => {
		const { mobile } = await setup();
		const { planRepair, runRepairSyncMemory } = await repairModule();
		mobile.plugin.settings.operations['Inbox/a.md'] = 'modify';
		const plan = await planRepair(mobile.plugin);
		expect(plan.items.map((i: any) => [i.path, i.action, i.why])).toEqual([
			['Inbox/a.md', 'identical', 'unchanged since the last sync'],
		]);
		await runRepairSyncMemory(mobile.plugin, yes);
		expect(mobile.ops()).toEqual({});
	});

	it('saying No changes nothing', async () => {
		const { desktop, mobile } = await setup();
		const { runRepairSyncMemory } = await repairModule();
		await edit(desktop, 'Inbox/a.md', 'a v2');
		await desktop.push();
		makeStuck(mobile, ['Inbox/a.md', 'Inbox/b.md']);
		const before = { tree: mobile.tree(), ops: mobile.ops(), a: read(mobile, 'Inbox/a.md') };
		const result = await runRepairSyncMemory(mobile.plugin, async () => false);
		await sleep(40);
		expect(result).toBeUndefined();
		expect(mobile.tree()).toEqual(before.tree);
		expect(mobile.ops()).toEqual(before.ops);
		expect(read(mobile, 'Inbox/a.md')).toBe(before.a);
		expect(mobile.plugin.syncing).toBe(false);
	});

	it('a note changed while the window was open is left alone', async () => {
		const { desktop, mobile } = await setup();
		const { runRepairSyncMemory } = await repairModule();
		await edit(desktop, 'Inbox/a.md', 'a v2');
		await desktop.push();
		makeStuck(mobile, ['Inbox/a.md']);
		const result = await runRepairSyncMemory(mobile.plugin, async () => {
			await edit(mobile, 'Inbox/a.md', 'typed while the window was open');
			return true;
		});
		await sleep(40);
		expect(result.skipped).toBe(1);
		expect(read(mobile, 'Inbox/a.md')).toBe('typed while the window was open');
		expect(copies(mobile.tree())).toEqual([]);
	});

	it('does not move the position in Drive\'s change list and ends the sync state', async () => {
		const { desktop, mobile } = await setup();
		const { runRepairSyncMemory } = await repairModule();
		await edit(desktop, 'Inbox/a.md', 'a v2');
		await desktop.push();
		makeStuck(mobile, ['Inbox/a.md']);
		const { lastSyncedAt, changesToken } = mobile.plugin.settings;
		await runRepairSyncMemory(mobile.plugin, yes);
		expect(mobile.plugin.settings.lastSyncedAt).toBe(lastSyncedAt);
		expect(mobile.plugin.settings.changesToken).toBe(changesToken);
		expect(mobile.plugin.syncing).toBe(false);
	});

	it('leaves new notes (not on Drive) and everything else untouched', async () => {
		const { mobile } = await setup();
		const { runRepairSyncMemory } = await repairModule();
		await mobile.vault.create('brand-new.md', 'new on the phone');
		await sleep(30);
		makeStuck(mobile, ['Inbox/a.md']);
		await runRepairSyncMemory(mobile.plugin, yes);
		await sleep(40);
		expect(read(mobile, 'brand-new.md')).toBe('new on the phone');
		expect(mobile.ops()['brand-new.md']).toBe('create');
	});

	it('says so and does nothing when no note is marked', async () => {
		const { mobile } = await setup();
		const { runRepairSyncMemory } = await repairModule();
		const result = await runRepairSyncMemory(mobile.plugin, yes);
		expect(result).toBeUndefined();
		expect(notices.join('\n')).toMatch(/Nothing to repair/);
	});

	it('the doctor list names exactly the marked notes with no remembered state', async () => {
		const { mobile } = await setup();
		await mobile.vault.create('brand-new.md', 'new on the phone');
		await sleep(30);
		makeStuck(mobile, ['Inbox/a.md', 'Inbox/b.md']);
		mobile.plugin.settings.syncedFiles['Inbox/b.md'] = { m: 1, s: 1, h: 'x' }; // this one is remembered
		expect(findUnrememberedMarks(mobile.plugin)).toEqual(['Inbox/a.md']);
	});

	it('many stuck notes at once: all settled, each old version kept', async () => {
		const { desktop, mobile } = await setup();
		const { runRepairSyncMemory } = await repairModule();
		const paths = ['Inbox/a.md', 'Inbox/b.md', 'root.md', 'Archive/old.md'];
		for (const p of paths) await edit(desktop, p, `${p} v2`);
		await desktop.push();
		makeStuck(mobile, paths);
		const result = await runRepairSyncMemory(mobile.plugin, yes);
		await sleep(60);
		expect(result.updatedFromDrive).toBe(4);
		for (const p of paths) expect(read(mobile, p)).toBe(`${p} v2`);
		expect(copies(mobile.tree()).filter((p) => p.includes('this device'))).toHaveLength(4);
	});
});
