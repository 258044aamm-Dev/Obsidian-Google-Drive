/**
 * 3.8.1: on a phone Obsidian reports the files a Pull just wrote LATER, from its file watcher,
 * after the write call has returned. The plugin used to take those reports for edits made on the
 * phone: the next Pull then kept the phone's (old) note and saved the new Drive version next to it
 * as "Note (Drive YYYY-MM-DD).md", for every note changed on the desktop. Pull now judges a
 * pending mark by the note's content, so such a late report no longer matters.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.stubGlobal('window', globalThis);
vi.mock('obsidian', async () => await import('./obsidian-mock'));
import { sleep, dec, notices } from './world';
import { setup, simDefaults } from './scenario-helpers';
import { TFile } from './obsidian-mock';
import { findFalseMarks } from '../../helpers/sync-state';

const copies = (tree: string[]) => tree.filter((p) => /\(Drive \d{4}-\d{2}-\d{2}(-\d+)?\)/.test(p));
const read = (d: { vault: { disk: Map<string, any> } }, p: string) => {
	const f = d.vault.disk.get(p);
	return f ? dec(f.data as Uint8Array) : undefined;
};
const edit = async (d: any, path: string, text: string) => {
	await d.vault.modify(d.vault.getFileByPath(path) as TFile, text);
	await sleep(20);
};

describe.each([true, false])('file events that arrive after a Pull wrote the file (deleteToTrash=%s)', (trash) => {
	beforeEach(() => {
		simDefaults.deleteToTrash = trash;
	});

	it('desktop edit + Push, then phone Pull: the note is updated, no "(Drive ...)" copy', async () => {
		const { desktop, mobile } = await setup();
		mobile.vault.lateEventsMs = 30;
		// the phone's earlier Pull brought the current state; its late events arrive afterwards
		await edit(desktop, 'Inbox/a.md', 'a v2');
		await desktop.push();
		await mobile.pull();
		await sleep(80);
		expect(read(mobile, 'Inbox/a.md')).toBe('a v2');

		// three identical copies now; the user edits on the desktop only
		await edit(desktop, 'Inbox/a.md', 'a v3');
		await desktop.push();
		await mobile.pull();
		await sleep(80);
		expect(read(mobile, 'Inbox/a.md')).toBe('a v3');
		expect(copies(mobile.tree())).toEqual([]);
		// a late report may leave a mark on an unchanged note; it is harmless: Push does not change Drive
		await mobile.push();
		expect(copies(mobile.tree())).toEqual([]);
		await desktop.pull();
		expect(read(desktop, 'Inbox/a.md')).toBe('a v3');
		expect(notices.join('\n')).not.toMatch(/kept|copy|copies/i);
	});

	it('every changed note, not only one', async () => {
		const { desktop, mobile } = await setup();
		mobile.vault.lateEventsMs = 30;
		for (const [p, t] of [['Inbox/a.md', 'a2'], ['Inbox/b.md', 'b2'], ['root.md', 'r2']]) await edit(desktop, p!, t!);
		await desktop.push();
		await mobile.pull();
		await sleep(80);
		for (const [p, t] of [['Inbox/a.md', 'a3'], ['Inbox/b.md', 'b3'], ['root.md', 'r3']]) await edit(desktop, p!, t!);
		await desktop.push();
		await mobile.pull();
		await sleep(80);
		expect(copies(mobile.tree())).toEqual([]);
		expect(read(mobile, 'Inbox/b.md')).toBe('b3');
		expect(notices.join('\n')).not.toMatch(/kept|copy|copies/i);
	});
});

describe('real edits stay protected, nothing else changes', () => {
	beforeEach(() => {
		simDefaults.deleteToTrash = true;
	});

	it('a phone edit made after its Pull is still kept; Drive\'s version goes to a copy', async () => {
		const { desktop, mobile } = await setup();
		mobile.vault.lateEventsMs = 30;
		await edit(desktop, 'Inbox/a.md', 'a v2');
		await desktop.push();
		await mobile.pull();
		await sleep(80);
		await edit(mobile, 'Inbox/a.md', 'phone edit'); // within a minute of the Pull
		await sleep(80);
		expect(mobile.ops()['Inbox/a.md']).toBe('modify');
		await edit(desktop, 'Inbox/a.md', 'a v3');
		await desktop.push();
		await mobile.pull();
		await sleep(80);
		expect(read(mobile, 'Inbox/a.md')).toBe('phone edit');
		const found = copies(mobile.tree());
		expect(found).toHaveLength(1);
		expect(read(mobile, found[0]!)).toBe('a v3');
		expect(mobile.ops()[found[0]!]).toBe('create'); // the copy still goes to Drive on the next Push
	});

	it('the conflict copy keeps its pending mark even though its own file event arrives late', async () => {
		const { desktop, mobile } = await setup();
		mobile.vault.lateEventsMs = 30;
		await edit(mobile, 'Inbox/b.md', 'phone version');
		await edit(desktop, 'Inbox/b.md', 'desktop version');
		await desktop.push();
		await mobile.pull();
		await sleep(150);
		const found = copies(mobile.tree());
		expect(found).toHaveLength(1);
		expect(mobile.ops()[found[0]!]).toBe('create');
		await mobile.push();
		expect(mobile.ops()).toEqual({});
		expect(read(mobile, 'Inbox/b.md')).toBe('phone version');
	});

	it('an edit that is undone before the Pull is not an edit: the Drive version is taken', async () => {
		const { desktop, mobile } = await setup();
		await edit(mobile, 'Inbox/a.md', 'oops');
		await edit(mobile, 'Inbox/a.md', 'a'); // back to what it was
		await edit(desktop, 'Inbox/a.md', 'a from desktop');
		await desktop.push();
		await mobile.pull();
		expect(read(mobile, 'Inbox/a.md')).toBe('a from desktop');
		expect(copies(mobile.tree())).toEqual([]);
	});

	it('a note pulled for the first time is not duplicated or changed by the next Push', async () => {
		const { desktop, mobile } = await setup();
		mobile.vault.lateEventsMs = 30;
		await desktop.vault.create('brand-new.md', 'new note');
		await sleep(20);
		await desktop.push();
		await mobile.pull();
		await sleep(100);
		expect(read(mobile, 'brand-new.md')).toBe('new note');
		await mobile.push();
		expect(copies(mobile.tree())).toEqual([]);
		await desktop.pull();
		expect(read(desktop, 'brand-new.md')).toBe('new note');
	});

	it('without a remembered state the old, careful behaviour stays: a marked note keeps a copy', async () => {
		const { desktop, mobile } = await setup();
		mobile.plugin.settings.syncedFiles = {};
		mobile.plugin.settings.operations['Inbox/a.md'] = 'modify';
		await edit(desktop, 'Inbox/a.md', 'a from desktop');
		await desktop.push();
		await mobile.pull();
		expect(read(mobile, 'Inbox/a.md')).toBe('a');
		expect(copies(mobile.tree())).toHaveLength(1);
	});

	it('a stale mark on an unchanged note is ignored by Pull and noted in the diagnostics', async () => {
		const { desktop, mobile } = await setup();
		mobile.plugin.diagnostics.enabled = true;
		mobile.plugin.settings.operations['Inbox/a.md'] = 'modify';
		await edit(desktop, 'Inbox/a.md', 'a from desktop');
		await desktop.push();
		await mobile.pull();
		expect(read(mobile, 'Inbox/a.md')).toBe('a from desktop');
		expect(copies(mobile.tree())).toEqual([]);
		expect(mobile.ops()).toEqual({});
		expect(JSON.stringify(mobile.plugin.diagnostics.getEntries())).toMatch(/false-pending-mark/);
	});

	it('a note whose mark is real (edited) and a note with a false mark in the same Pull are handled apart', async () => {
		const { desktop, mobile } = await setup();
		mobile.plugin.settings.operations['Inbox/a.md'] = 'modify'; // false mark
		await edit(mobile, 'Inbox/b.md', 'phone b'); // real edit
		await edit(desktop, 'Inbox/a.md', 'desktop a');
		await edit(desktop, 'Inbox/b.md', 'desktop b');
		await desktop.push();
		await mobile.pull();
		expect(read(mobile, 'Inbox/a.md')).toBe('desktop a');
		expect(read(mobile, 'Inbox/b.md')).toBe('phone b');
		const found = copies(mobile.tree());
		expect(found).toEqual(['Inbox/b (Drive ' + found[0]!.match(/\d{4}-\d{2}-\d{2}/)![0] + ').md']);
	});
});

describe('findFalseMarks (read-only)', () => {
	it('lists only marked notes that are unchanged since the last sync, and changes nothing', async () => {
		const { mobile } = await setup();
		mobile.plugin.settings.operations['Inbox/a.md'] = 'modify'; // false: unchanged
		await edit(mobile, 'Inbox/b.md', 'phone b'); // real edit, marked by its event
		mobile.plugin.settings.operations['brand-new-local.md'] = 'create'; // not on Drive
		const before = { ...mobile.ops() };
		expect(await findFalseMarks(mobile.plugin)).toEqual(['Inbox/a.md']);
		expect(mobile.ops()).toEqual(before);
	});
});
