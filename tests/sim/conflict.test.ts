/**
 * Keep-both conflicts: a note changed on Drive AND on this device (not pushed yet) keeps
 * this device's version and gets the Drive version saved as "Note (Drive YYYY-MM-DD).md".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.stubGlobal('window', globalThis);
vi.mock('obsidian', async () => await import('./obsidian-mock'));
import { sleep, dec, enc, notices } from './world';
import { setup, same, simDefaults } from './scenario-helpers';
import { TFile } from './obsidian-mock';
import { formatLocalDate } from '../../helpers/conflict-copy';

const failures = () => notices.filter((n) => /fail/i.test(n));
const today = () => formatLocalDate(new Date());
const read = (d: { vault: { disk: Map<string, any> } }, p: string) => {
	const f = d.vault.disk.get(p);
	return f ? dec(f.data as Uint8Array) : undefined;
};
const copies = (tree: string[]) => tree.filter((p) => /\(Drive \d{4}-\d{2}-\d{2}(-\d+)?\)/.test(p));

describe.each([true, false])('keep-both conflicts (deleteToTrash=%s)', (trash) => {
	beforeEach(() => {
		simDefaults.deleteToTrash = trash;
	});

	async function bothEdit() {
		const s = await setup();
		await s.mobile.vault.modify(s.mobile.vault.getFileByPath('Inbox/b.md') as TFile, 'phone version');
		await s.mobile.save();
		await s.desktop.vault.modify(s.desktop.vault.getFileByPath('Inbox/b.md') as TFile, 'desktop version');
		await sleep(20);
		await s.desktop.push();
		return s;
	}

	it('keeps the local note and saves the Drive version as a copy; nothing is lost', async () => {
		const { mobile } = await bothEdit();
		await mobile.pull();
		expect(failures()).toEqual([]);

		expect(read(mobile, 'Inbox/b.md')).toBe('phone version');
		const copy = `Inbox/b (Drive ${today()}).md`;
		expect(read(mobile, copy)).toBe('desktop version');
		expect(copies(mobile.tree())).toEqual([copy]);
		expect(mobile.ops()[copy]).toBe('create');
		expect(mobile.ops()['Inbox/b.md']).toBe('modify');
	});

	it('the copy and the local version both reach Drive and the other device on Push', async () => {
		const { w, desktop, mobile } = await bothEdit();
		await mobile.pull(); // the user pulls: the copy is created
		await mobile.push(); // the push uploads note + copy
		expect(failures()).toEqual([]);
		expect(mobile.ops()).toEqual({});

		const copy = `Inbox/b (Drive ${today()}).md`;
		expect(w.drive.snapshotNonConfig()).toContain(copy);

		await desktop.pull();
		expect(failures()).toEqual([]);
		expect(read(desktop, 'Inbox/b.md')).toBe('phone version');
		expect(read(desktop, copy)).toBe('desktop version');
		expect(same(desktop.tree(), mobile.tree())).toBe('IDENTICAL');
		expect(same(mobile.tree(), w.drive.snapshotNonConfig())).toBe('IDENTICAL');
	});

	it('pulling again never creates the same copy twice', async () => {
		const { mobile } = await bothEdit();
		await mobile.pull();
		await mobile.pull();
		await mobile.pull();
		expect(copies(mobile.tree())).toHaveLength(1);
	});

	it('a different Drive version on the same day gets its own numbered copy', async () => {
		const { desktop, mobile } = await bothEdit();
		await mobile.pull();
		await desktop.vault.modify(desktop.vault.getFileByPath('Inbox/b.md') as TFile, 'desktop version 2');
		await sleep(20);
		await desktop.push();
		await mobile.pull();
		const d = today();
		expect(read(mobile, `Inbox/b (Drive ${d}).md`)).toBe('desktop version');
		expect(read(mobile, `Inbox/b (Drive ${d}-2).md`)).toBe('desktop version 2');
		expect(read(mobile, 'Inbox/b.md')).toBe('phone version');
	});

	it('identical edits on both sides create no copy', async () => {
		const { desktop, mobile } = await setup();
		await mobile.vault.modify(mobile.vault.getFileByPath('Inbox/b.md') as TFile, 'same text');
		await mobile.save();
		await desktop.vault.modify(desktop.vault.getFileByPath('Inbox/b.md') as TFile, 'same text');
		await sleep(20);
		await desktop.push();
		await mobile.pull();
		expect(copies(mobile.tree())).toEqual([]);
		expect(read(mobile, 'Inbox/b.md')).toBe('same text');
	});

	it('a plain Drive update to a note with no local change is applied without any copy', async () => {
		const { desktop, mobile } = await setup();
		await desktop.vault.modify(desktop.vault.getFileByPath('Inbox/b.md') as TFile, 'only desktop changed');
		await sleep(20);
		await desktop.push();
		await mobile.pull();
		expect(read(mobile, 'Inbox/b.md')).toBe('only desktop changed');
		expect(copies(mobile.tree())).toEqual([]);
	});

	it('binary attachments in nested folders are kept too, with their extension', async () => {
		const { desktop, mobile } = await setup();
		const path = 'Projects/Alpha/notes/pic.png';
		await desktop.vault.createBinary(path, new Uint8Array([1, 2, 3]).buffer);
		await sleep(20);
		await desktop.push();
		await mobile.pull();
		await mobile.vault.modifyBinary(mobile.vault.getFileByPath(path) as TFile, new Uint8Array([9, 9]).buffer);
		await mobile.save();
		await desktop.vault.modifyBinary(desktop.vault.getFileByPath(path) as TFile, new Uint8Array([4, 5, 6, 7]).buffer);
		await sleep(20);
		await desktop.push();
		await mobile.pull();
		const copy = `Projects/Alpha/notes/pic (Drive ${today()}).png`;
		expect([...(mobile.vault.disk.get(path)!.data as Uint8Array)]).toEqual([9, 9]);
		expect([...(mobile.vault.disk.get(copy)!.data as Uint8Array)]).toEqual([4, 5, 6, 7]);
	});

	it('a note that exists locally but was never synced, and differs from Drive, is kept and the Drive version saved', async () => {
		const { mobile, desktop } = await setup();
		// as after copying a vault to a new device: the file is there, the plugin does not know it
		await mobile.vault.modify(mobile.vault.getFileByPath('Inbox/a.md') as TFile, 'older copy on phone');
		mobile.plugin.settings.operations['Inbox/a.md'] = 'create';
		await mobile.save();
		await desktop.vault.modify(desktop.vault.getFileByPath('Inbox/a.md') as TFile, 'desktop a');
		await sleep(20);
		await desktop.push();
		await mobile.pull();
		expect(read(mobile, 'Inbox/a.md')).toBe('older copy on phone');
		expect(read(mobile, `Inbox/a (Drive ${today()}).md`)).toBe('desktop a');
	});

	it('the copy notice is shown on Pull; Push alone does not pull, so it makes no copy and stops', async () => {
		const { w, mobile } = await bothEdit();
		const before = w.drive.snapshotNonConfig();
		const localBefore = read(mobile, 'Inbox/b.md');
		await mobile.push();
		expect(notices.some((n) => n.includes('Push stopped'))).toBe(true);
		expect(copies(mobile.tree())).toEqual([]);
		expect(read(mobile, 'Inbox/b.md')).toBe(localBefore);
		expect(w.drive.snapshotNonConfig()).toEqual(before);
		notices.length = 0;
		await mobile.pull();
		expect(notices.some((n) => n.includes('Drive version saved') || n.includes('saved as'))).toBe(true);
	});

	it('the plugin folder and config files never get conflict copies', async () => {
		const { w, mobile } = await setup();
		const disk = mobile.vault.disk as Map<string, any>;
		disk.set('.obsidian/app.json', { type: 'file', data: new Uint8Array(enc('{"local":1}')), mtime: Date.now() + 5000 });
		w.drive.add({
			name: 'app.json',
			parents: [w.drive.rootId],
			properties: { path: '.obsidian/app.json', config: 'true', vault: 'V' },
			content: new Uint8Array(enc('{"drive":1}')),
			modifiedTime: new Date(Date.now() + 9000).toISOString(),
		});
		await mobile.pull();
		expect(copies([...disk.keys()])).toEqual([]);
	});
});
