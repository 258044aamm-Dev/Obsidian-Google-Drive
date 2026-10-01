/**
 * What happens when someone changes the vault in the Google Drive web interface.
 * Each helper does what the web page does to the stored file (same id, same custom properties unless
 * the page really drops them), then a device pulls or pushes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.stubGlobal('window', globalThis);
vi.mock('obsidian', async () => await import('./obsidian-mock'));
import { sleep, notices } from './world';
import { setup, simDefaults } from './scenario-helpers';

const text = async (d: any, path: string) => new TextDecoder().decode(await d.vault.adapter.readBinary(path));
const find = (w: any, path: string) => [...w.drive.files.values()].find((f: any) => w.drive.shown(f) === path);
const bump = (w: any, f: any) => w.drive.changes.push({ seq: w.drive.changes.length + 1, fileId: f.id, removed: false });

/** "Manage versions → Upload new version": same file, same properties, new content. */
const webEdit = (w: any, path: string, content: string) => {
	const f = find(w, path);
	f.content = new TextEncoder().encode(content);
	f.revisions.push({ id: 'web' + w.drive.seq++, content: f.content.slice() });
	f.modifiedTime = new Date().toISOString();
	bump(w, f);
};
/** Rename in the web page: only the Drive name changes. */
const webRename = (w: any, path: string, name: string) => {
	const f = find(w, path);
	f.name = name;
	bump(w, f);
};
/** Drag into another folder in the web page: only the parent changes. */
const webMove = (w: any, path: string, folderPath: string) => {
	const f = find(w, path);
	f.parents = [find(w, folderPath).id];
	bump(w, f);
};
/** "New → File upload" in the web page: a plain file, no custom properties of this plugin. */
const webUpload = (w: any, name: string, folderPath: string, content: string) =>
	w.drive.add({ name, parents: [find(w, folderPath).id], content: new TextEncoder().encode(content), mimeType: 'text/markdown' });

const failures = () => notices.filter((n) => /fail|error/i.test(n));

beforeEach(() => {
	simDefaults.deleteToTrash = true;
});

describe('edited in the Drive web page', () => {
	it('a file this device did not touch gets the new content', async () => {
		const { w, mobile } = await setup();
		await sleep(30);
		webEdit(w, 'Inbox/a.md', 'edited on the web');
		await mobile.pull();
		expect(await text(mobile, 'Inbox/a.md')).toBe('edited on the web');
		expect(mobile.ops()).toEqual({});
		expect(failures()).toEqual([]);
	});
});

describe('restored from the Drive Trash', () => {
	// KNOWN GAP (found by this test): Pull only downloads files whose Drive modifiedTime is newer than the last
	// sync, and restoring from the Trash does not change modifiedTime (as far as the simulator and my reading of
	// the Drive docs go; not checked on real Drive). So a device that already removed the file does not get it back
	// until the file is next edited somewhere. Marked as an expected failure until the owner decides on a fix.
	it.fails('a file that was trashed, pulled (so removed here) and then restored comes back', async () => {
		const { w, mobile } = await setup();
		await sleep(30);
		w.drive.trash(find(w, 'Inbox/a.md').id);
		await mobile.pull();
		expect(mobile.vault.getFileByPath('Inbox/a.md')).toBeNull();
		await sleep(30);
		w.drive.untrash(find(w, 'Inbox/a.md').id);
		await mobile.pull();
		expect(await text(mobile, 'Inbox/a.md')).toBe('a');
		expect(mobile.ops()).toEqual({});
		await mobile.push();
		expect(find(w, 'Inbox/a.md').trashed).toBe(false);
	});

	it('the restored file does come back as soon as it is edited on any device', async () => {
		const { w, desktop, mobile } = await setup();
		await sleep(30);
		w.drive.trash(find(w, 'Inbox/a.md').id);
		await mobile.pull();
		expect(mobile.vault.getFileByPath('Inbox/a.md')).toBeNull();
		await sleep(30);
		w.drive.untrash(find(w, 'Inbox/a.md').id);
		await desktop.vault.modify(desktop.vault.getFileByPath('Inbox/a.md')!, 'a2');
		await sleep(20);
		await desktop.push();
		await mobile.pull();
		expect(await text(mobile, 'Inbox/a.md')).toBe('a2');
		expect(failures()).toEqual([]);
	});

	it('trashed and restored before this device pulled: nothing happens', async () => {
		const { w, mobile } = await setup();
		await sleep(30);
		w.drive.trash(find(w, 'Inbox/a.md').id);
		w.drive.untrash(find(w, 'Inbox/a.md').id);
		await mobile.pull();
		expect(await text(mobile, 'Inbox/a.md')).toBe('a');
		expect(mobile.ops()).toEqual({});
	});
});

describe('renamed or moved in the Drive web page', () => {
	it('a rename changes nothing here, and later edits still reach the same Drive file', async () => {
		const { w, desktop, mobile } = await setup();
		await sleep(30);
		const id = find(w, 'Inbox/a.md').id;
		webRename(w, 'Inbox/a.md', 'renamed-on-web.md');
		await mobile.pull();
		expect(await text(mobile, 'Inbox/a.md')).toBe('a');
		expect(mobile.vault.getFileByPath('renamed-on-web.md')).toBeNull();
		await sleep(30);
		await desktop.vault.modify(desktop.vault.getFileByPath('Inbox/a.md')!, 'a2');
		await sleep(20);
		await desktop.pull();
		await desktop.push();
		expect(w.drive.files.get(id)!.content && new TextDecoder().decode(w.drive.files.get(id)!.content!)).toBe('a2');
		expect([...w.drive.files.values()].filter((f: any) => w.drive.shown(f) === 'Inbox/a.md' && !f.trashed)).toHaveLength(1);
		await mobile.pull();
		expect(await text(mobile, 'Inbox/a.md')).toBe('a2');
		expect(failures()).toEqual([]);
	});

	it('a move into another folder changes nothing here, and later edits still reach the same Drive file', async () => {
		const { w, desktop, mobile } = await setup();
		await sleep(30);
		const id = find(w, 'Inbox/a.md').id;
		webMove(w, 'Inbox/a.md', 'Archive');
		await mobile.pull();
		expect(await text(mobile, 'Inbox/a.md')).toBe('a');
		await sleep(30);
		await desktop.vault.modify(desktop.vault.getFileByPath('Inbox/a.md')!, 'a2');
		await sleep(20);
		await desktop.pull();
		await desktop.push();
		expect(new TextDecoder().decode(w.drive.files.get(id)!.content!)).toBe('a2');
		expect([...w.drive.files.values()].filter((f: any) => w.drive.shown(f) === 'Inbox/a.md' && !f.trashed)).toHaveLength(1);
		expect(failures()).toEqual([]);
	});
});

describe('a new file uploaded in the Drive web page', () => {
	it('is not seen by Pull, and does not disturb it or Push', async () => {
		const { w, desktop, mobile } = await setup();
		await sleep(30);
		webUpload(w, 'from-the-web.md', 'Inbox', 'hello from the web');
		await mobile.pull();
		expect(mobile.vault.getFileByPath('Inbox/from-the-web.md')).toBeNull();
		expect(mobile.ops()).toEqual({});
		await desktop.vault.modify(desktop.vault.getFileByPath('root.md')!, 'r2');
		await sleep(20);
		await desktop.pull();
		await desktop.push();
		await mobile.pull();
		expect(await text(mobile, 'root.md')).toBe('r2');
		expect(failures()).toEqual([]);
	});
});
