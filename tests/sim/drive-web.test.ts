/**
 * What happens when someone changes the vault in the Google Drive web interface.
 * Each helper does what the web page does to the stored file (same id, same custom properties unless
 * the page really drops them), then a device pulls or pushes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.stubGlobal('window', globalThis);
vi.mock('obsidian', async () => await import('./obsidian-mock'));
import { sleep, notices, netLog, dec } from './world';
import { setup, simDefaults, simE2ee } from './scenario-helpers';

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
	// the web page cannot write encrypted content, so this one is for plain vaults
	it.skipIf(simE2ee.on)('a file this device did not touch gets the new content', async () => {
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
	it('a file that was trashed, pulled (so removed here) and then restored comes back', async () => {
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
		expect(dec((await w.drive.contentOf(w.drive.files.get(id)!))!)).toBe('a2');
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
		expect(dec((await w.drive.contentOf(w.drive.files.get(id)!))!)).toBe('a2');
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

describe('restored from the Trash when the feed reports a trashed file as removed', () => {
	it('trashed and restored before this device pulled: the local file stays', async () => {
		const { w, mobile } = await setup();
		w.drive.trashEmitsRemoved = true;
		await sleep(30);
		w.drive.trash(find(w, 'Inbox/a.md').id);
		w.drive.untrash(find(w, 'Inbox/a.md').id);
		await mobile.pull();
		expect(await text(mobile, 'Inbox/a.md')).toBe('a');
		expect(mobile.ops()).toEqual({});
	});
});

describe('files restored from the Trash, more cases', () => {
	const listings = () => netLog.filter((l) => l.startsWith('GET') && l.includes('/drive/v3/files?')).length;

	it('a whole folder with its files comes back', async () => {
		const { w, mobile } = await setup();
		await sleep(30);
		w.drive.trash(find(w, 'Projects/Alpha').id);
		await mobile.pull();
		expect(mobile.vault.getFileByPath('Projects/Alpha/plan.md')).toBeNull();
		await sleep(30);
		w.drive.untrash(find(w, 'Projects/Alpha').id);
		await mobile.pull();
		expect(await text(mobile, 'Projects/Alpha/plan.md')).toBe('plan');
		expect(await text(mobile, 'Projects/Alpha/notes/n1.md')).toBe('n1');
		expect(mobile.ops()).toEqual({});
		expect(failures()).toEqual([]);
	});

	it('does not overwrite a new note that was made here under the same name: both are kept', async () => {
		const { w, mobile } = await setup();
		await sleep(30);
		w.drive.trash(find(w, 'Inbox/a.md').id);
		await mobile.pull();
		await sleep(30);
		await mobile.vault.create('Inbox/a.md', 'written on the phone');
		await sleep(20);
		w.drive.untrash(find(w, 'Inbox/a.md').id);
		await mobile.pull();
		expect(await text(mobile, 'Inbox/a.md')).toBe('written on the phone');
		const copies = mobile.vault.tree().filter((p: string) => p.startsWith('Inbox/a (Drive'));
		expect(copies).toHaveLength(1);
		expect(await text(mobile, copies[0]!)).toBe('a');
	});

	it('is counted as waiting on Drive until it is pulled', async () => {
		const { w, mobile } = await setup();
		await sleep(30);
		w.drive.trash(find(w, 'Inbox/a.md').id);
		await mobile.pull();
		await sleep(30);
		w.drive.untrash(find(w, 'Inbox/a.md').id);
		const { countWaitingOnDrive } = await import('../../helpers/badge');
		expect(await countWaitingOnDrive(mobile.plugin)).toBe(1);
		await mobile.pull();
		expect(await countWaitingOnDrive(mobile.plugin)).toBe(0);
	});

	it('costs one more listing only when a file really was restored', async () => {
		const { w, mobile } = await setup();
		await sleep(30);
		webEdit(w, 'root.md', 'r2');
		let before = listings();
		await mobile.pull();
		const plain = listings() - before;
		await sleep(30);
		w.drive.trash(find(w, 'Inbox/a.md').id);
		await mobile.pull();
		await sleep(30);
		w.drive.untrash(find(w, 'Inbox/a.md').id);
		before = listings();
		await mobile.pull();
		expect(listings() - before).toBe(plain + 1);
	});
});
