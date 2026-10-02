/**
 * 3.6.3: Pull never overwrites a note that was really edited on this device, even when the
 * edit event was missed (no pending operation). "Edited" is judged against the state the note
 * had when it last matched Drive (time, size and a content fingerprint).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.stubGlobal('window', globalThis);
vi.mock('obsidian', async () => await import('./obsidian-mock'));
import { sleep, dec, notices } from './world';
import { setup, simDefaults } from './scenario-helpers';
import { TFile } from './obsidian-mock';

const read = (d: any, p: string) => {
	const f = d.vault.disk.get(p);
	return f ? dec(f.data as Uint8Array) : undefined;
};
const driveText = async (w: any, path: string) => {
	const f = [...w.drive.files.values()].find((x: any) => w.drive.shown(x) === path && !x.trashed);
	return f ? dec(await w.drive.contentOf(f)) : undefined;
};
const copies = (d: any) => d.tree().filter((p: string) => /\(Drive \d{4}-\d{2}-\d{2}(-\d+)?\)/.test(p));

async function edit(d: any, path: string, text: string) {
	await d.vault.modify(d.vault.getFileByPath(path) as TFile, text);
	await sleep(20);
}
/** an edit whose event never reached the plugin */
async function editWithoutEvent(d: any, path: string, text: string) {
	await edit(d, path, text);
	delete d.plugin.settings.operations[path];
}

describe.each([true, false])('Pull protects local edits (deleteToTrash=%s)', (trash) => {
	beforeEach(() => {
		simDefaults.deleteToTrash = trash;
	});

	it('an edit without a recorded event is kept; Drive version saved as a copy; Push uploads the edit', async () => {
		const { w, desktop, mobile } = await setup();
		await edit(desktop, 'Inbox/a.md', 'desktop a');
		await desktop.push();
		await editWithoutEvent(mobile, 'Inbox/a.md', 'mobile a');

		await mobile.pull();

		expect(read(mobile, 'Inbox/a.md')).toBe('mobile a');
		const kept = copies(mobile);
		expect(kept).toHaveLength(1);
		expect(read(mobile, kept[0])).toBe('desktop a');
		expect(mobile.ops()['Inbox/a.md']).toBe('modify');

		await mobile.push();
		expect(await driveText(w, 'Inbox/a.md')).toBe('mobile a');
	});

	it('an edit that keeps the same size is still detected (content fingerprint)', async () => {
		const { desktop, mobile } = await setup();
		await edit(desktop, 'Inbox/a.md', 'aaaa');
		await desktop.push();
		await mobile.pull();
		await editWithoutEvent(mobile, 'Inbox/a.md', 'bbbb');
		await edit(desktop, 'Inbox/a.md', 'cccc');
		await desktop.push();

		await mobile.pull();

		expect(read(mobile, 'Inbox/a.md')).toBe('bbbb');
		const kept = copies(mobile);
		expect(kept).toHaveLength(1);
		expect(read(mobile, kept[0])).toBe('cccc');
	});

	it('a note that was only touched (same content, new time) is overwritten by Drive as usual', async () => {
		const { desktop, mobile } = await setup();
		await edit(desktop, 'Inbox/a.md', 'desktop a');
		await desktop.push();
		await editWithoutEvent(mobile, 'Inbox/a.md', 'a'); // same bytes as it had, new time

		await mobile.pull();

		expect(read(mobile, 'Inbox/a.md')).toBe('desktop a');
		expect(copies(mobile)).toEqual([]);
		expect(mobile.ops()).toEqual({});
	});

	it('a Drive-only change still overwrites an untouched note and makes no copy', async () => {
		const { desktop, mobile } = await setup();
		await edit(desktop, 'Inbox/a.md', 'desktop a');
		await desktop.push();
		await mobile.pull();
		expect(read(mobile, 'Inbox/a.md')).toBe('desktop a');
		expect(copies(mobile)).toEqual([]);
		expect(mobile.ops()).toEqual({});
	});

	it('an edit that equals the new Drive content makes no copy and no pending edit', async () => {
		const { desktop, mobile } = await setup();
		await edit(desktop, 'Inbox/a.md', 'same edit');
		await desktop.push();
		await editWithoutEvent(mobile, 'Inbox/a.md', 'same edit');
		await mobile.pull();
		expect(read(mobile, 'Inbox/a.md')).toBe('same edit');
		expect(copies(mobile)).toEqual([]);
		expect(mobile.ops()).toEqual({});
	});

	it('a note deleted on Drive but edited here (no event) is kept and uploaded again', async () => {
		const { w, desktop, mobile } = await setup();
		await desktop.vault.delete(desktop.vault.getAbstractFileByPath('Inbox/b.md')!);
		await sleep(20);
		await desktop.push();
		await editWithoutEvent(mobile, 'Inbox/b.md', 'mobile b');

		await mobile.pull();

		expect(read(mobile, 'Inbox/b.md')).toBe('mobile b');
		expect(mobile.ops()['Inbox/b.md']).toBe('create');
		await mobile.push();
		expect(await driveText(w, 'Inbox/b.md')).toBe('mobile b');
	});

	it('a note deleted on Drive and not edited here is still deleted here', async () => {
		const { desktop, mobile } = await setup();
		await desktop.vault.delete(desktop.vault.getAbstractFileByPath('Inbox/b.md')!);
		await sleep(20);
		await desktop.push();
		await mobile.pull();
		expect(read(mobile, 'Inbox/b.md')).toBeUndefined();
	});

	it('nothing remembered (a joined or copied vault): Drive wins, as before, and no copies appear', async () => {
		const { desktop, mobile } = await setup();
		await edit(desktop, 'Inbox/a.md', 'desktop a');
		await desktop.push();
		await editWithoutEvent(mobile, 'Inbox/a.md', 'stale phone a');
		delete mobile.plugin.settings.syncedFiles;
		await mobile.pull();
		expect(read(mobile, 'Inbox/a.md')).toBe('desktop a');
		expect(copies(mobile)).toEqual([]);
	});

	it('state saved by 3.6.2 (no fingerprint): a different size counts as an edit, a different time alone does not', async () => {
		const { desktop, mobile } = await setup();
		await edit(desktop, 'Inbox/a.md', 'desktop a');
		await edit(desktop, 'Inbox/b.md', 'desktop b');
		await desktop.push();
		await editWithoutEvent(mobile, 'Inbox/a.md', 'a much longer phone edit');
		await editWithoutEvent(mobile, 'Inbox/b.md', 'b'); // touched only
		for (const p of ['Inbox/a.md', 'Inbox/b.md']) delete mobile.plugin.settings.syncedFiles[p].h;
		await mobile.pull();
		expect(read(mobile, 'Inbox/a.md')).toBe('a much longer phone edit');
		expect(read(mobile, 'Inbox/b.md')).toBe('desktop b');
		expect(copies(mobile)).toHaveLength(1);
	});

	it('tells the user where the Drive copy went', async () => {
		const { desktop, mobile } = await setup();
		await edit(desktop, 'Inbox/a.md', 'desktop a');
		await desktop.push();
		await editWithoutEvent(mobile, 'Inbox/a.md', 'mobile a');
		await mobile.pull();
		expect(notices.some((n) => /Your version was kept and the Drive version saved as/.test(n))).toBe(true);
	});
});
