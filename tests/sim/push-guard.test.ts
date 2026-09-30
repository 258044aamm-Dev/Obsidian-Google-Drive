/**
 * Push never pulls. It only looks at Drive, and stops (changing nothing, here or on Drive) when
 * there is something the user has not pulled. "Push without pulling" goes ahead unless an item
 * was changed both here and on Drive; it then leaves the sync position alone so the next Pull
 * still brings everything in.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.stubGlobal('window', globalThis);
vi.mock('obsidian', async () => await import('./obsidian-mock'));
import { sleep, dec, notices } from './world';
import { setup, same, simDefaults } from './scenario-helpers';
import { TFile } from './obsidian-mock';
import { formatLocalDate } from '../../helpers/conflict-copy';
import { countRemoteChanges, findCollisions } from '../../helpers/push-guard';

const read = (d: { vault: { disk: Map<string, any> } }, p: string) => {
	const f = d.vault.disk.get(p);
	return f ? dec(f.data as Uint8Array) : undefined;
};
const copies = (tree: string[]) => tree.filter((p) => /\(Drive \d{4}-\d{2}-\d{2}(-\d+)?\)/.test(p));
const stopped = () => notices.some((n) => n.includes('Push stopped'));
const today = () => formatLocalDate(new Date());

describe.each([true, false])('push never pulls (deleteToTrash=%s)', (trash) => {
	beforeEach(() => {
		simDefaults.deleteToTrash = trash;
	});

	async function edit(d: { vault: any }, path: string, text: string) {
		await d.vault.modify(d.vault.getFileByPath(path) as TFile, text);
		await sleep(20);
	}

	it('stops when Drive has newer changes, and changes nothing on the device or on Drive', async () => {
		const { w, desktop, mobile } = await setup();
		await edit(desktop, 'Inbox/b.md', 'desktop b');
		await desktop.push();
		await edit(mobile, 'Inbox/a.md', 'phone a');
		const driveBefore = w.drive.snapshotNonConfig();
		const treeBefore = mobile.tree();
		const token = mobile.plugin.settings.changesToken;

		await mobile.push();

		expect(stopped()).toBe(true);
		expect(read(mobile, 'Inbox/b.md')).toBe('b'); // no silent pull
		expect(read(mobile, 'Inbox/a.md')).toBe('phone a');
		expect(mobile.tree()).toEqual(treeBefore);
		expect(w.drive.snapshotNonConfig()).toEqual(driveBefore);
		expect(mobile.ops()).toEqual({ 'Inbox/a.md': 'modify' });
		expect(mobile.plugin.settings.changesToken).toBe(token);
		expect(mobile.plugin.syncing).toBe(false);
	});

	it('after the user presses Pull, Push goes through and every side ends up identical', async () => {
		const { w, desktop, mobile } = await setup();
		await edit(desktop, 'Inbox/b.md', 'desktop b');
		await desktop.push();
		await edit(mobile, 'Inbox/a.md', 'phone a');
		await mobile.push();
		expect(stopped()).toBe(true);
		await mobile.pull();
		await mobile.push();
		expect(stopped()).toBe(false);
		await desktop.pull();
		expect(read(mobile, 'Inbox/b.md')).toBe('desktop b');
		expect(read(desktop, 'Inbox/a.md')).toBe('phone a');
		expect(same(mobile.tree(), desktop.tree())).toBe('IDENTICAL');
		expect(same(mobile.tree(), w.drive.snapshotNonConfig())).toBe('IDENTICAL');
		expect(mobile.ops()).toEqual({});
	});

	it('a remote deletion also stops the push', async () => {
		const { w, desktop, mobile } = await setup();
		await desktop.vault.delete(desktop.vault.getAbstractFileByPath('Archive/old.md')!);
		await sleep(20);
		await desktop.push();
		await edit(mobile, 'Inbox/a.md', 'phone a');
		const driveBefore = w.drive.snapshotNonConfig();
		await mobile.push();
		expect(stopped()).toBe(true);
		expect(read(mobile, 'Archive/old.md')).toBe('old');
		expect(w.drive.snapshotNonConfig()).toEqual(driveBefore);
	});

	it('nothing newer on Drive: a plain Push just uploads', async () => {
		const { w, mobile } = await setup();
		await edit(mobile, 'Inbox/a.md', 'phone a');
		await mobile.push();
		expect(stopped()).toBe(false);
		expect(mobile.ops()).toEqual({});
		expect(same(mobile.tree(), w.drive.snapshotNonConfig())).toBe('IDENTICAL');
	});

	describe('Push without pulling', () => {
		it('uploads when nothing collides, does not pull, and keeps the sync position for the next Pull', async () => {
			const { w, desktop, mobile } = await setup();
			await edit(desktop, 'Inbox/b.md', 'desktop b');
			await desktop.push();
			await edit(mobile, 'Inbox/a.md', 'phone a');
			const token = mobile.plugin.settings.changesToken;
			const syncedAt = mobile.plugin.settings.lastSyncedAt;

			await mobile.pushWithoutPull();

			expect(stopped()).toBe(false);
			expect(notices.some((n) => n.includes('not pulled'))).toBe(true);
			expect(mobile.ops()).toEqual({});
			expect(read(mobile, 'Inbox/b.md')).toBe('b'); // still not pulled
			expect(mobile.plugin.settings.changesToken).toBe(token);
			expect(mobile.plugin.settings.lastSyncedAt).toBe(syncedAt);
			const drive = w.drive.snapshotNonConfig();
			expect(drive).toContain('Inbox/a.md');

			await mobile.pull();
			expect(notices.filter((n) => /fail/i.test(n))).toEqual([]);
			expect(read(mobile, 'Inbox/b.md')).toBe('desktop b');
			expect(read(mobile, 'Inbox/a.md')).toBe('phone a');
			expect(copies(mobile.tree())).toEqual([]);
			await desktop.pull();
			expect(same(mobile.tree(), desktop.tree())).toBe('IDENTICAL');
			expect(same(mobile.tree(), w.drive.snapshotNonConfig())).toBe('IDENTICAL');
		});

		it('with nothing newer on Drive it behaves like a normal Push (sync position moves on)', async () => {
			const { mobile } = await setup();
			await edit(mobile, 'Inbox/a.md', 'phone a');
			const token = mobile.plugin.settings.changesToken;
			await mobile.pushWithoutPull();
			expect(notices.some((n) => n.includes('not pulled'))).toBe(false);
			expect(mobile.plugin.settings.changesToken).not.toBe(token);
		});

		it('stops when the same note was changed on both sides; Drive keeps the other device\'s version', async () => {
			const { w, desktop, mobile } = await setup();
			await edit(mobile, 'Inbox/b.md', 'phone b');
			await edit(desktop, 'Inbox/b.md', 'desktop b');
			await desktop.push();
			await mobile.pushWithoutPull();
			expect(stopped()).toBe(true);
			expect(notices.some((n) => n.includes('Inbox/b.md'))).toBe(true);
			expect(dec([...w.drive.files.values()].find((f) => f.properties.path === 'Inbox/b.md' && !f.trashed)!.content as Uint8Array)).toBe('desktop b');
			expect(mobile.ops()).toEqual({ 'Inbox/b.md': 'modify' });
			// the normal route still works and keeps both versions
			await mobile.pull();
			await mobile.push();
			expect(read(mobile, 'Inbox/b.md')).toBe('phone b');
			expect(read(mobile, `Inbox/b (Drive ${today()}).md`)).toBe('desktop b');
		});

		it('stops when this device edits a note inside a folder that was deleted on Drive', async () => {
			const { w, desktop, mobile } = await setup();
			await desktop.vault.delete(desktop.vault.getAbstractFileByPath('Archive')!);
			await sleep(20);
			await desktop.push();
			await edit(mobile, 'Archive/old.md', 'edited on phone');
			const driveBefore = w.drive.snapshotNonConfig();
			await mobile.pushWithoutPull();
			expect(stopped()).toBe(true);
			expect(w.drive.snapshotNonConfig()).toEqual(driveBefore);
			expect(read(mobile, 'Archive/old.md')).toBe('edited on phone');
		});

		it('stops when this device deletes a folder that got a new file on Drive', async () => {
			const { w, desktop, mobile } = await setup();
			await desktop.vault.create('Projects/Beta/new.md', 'new on desktop');
			await sleep(20);
			await desktop.push();
			await mobile.vault.delete(mobile.vault.getAbstractFileByPath('Projects/Beta')!);
			await sleep(20);
			const driveBefore = w.drive.snapshotNonConfig();
			await mobile.pushWithoutPull();
			expect(stopped()).toBe(true);
			expect(w.drive.snapshotNonConfig()).toEqual(driveBefore);
			expect(w.drive.snapshotNonConfig()).toContain('Projects/Beta/new.md');
		});

		it('new files in the same folder on both sides do not collide', async () => {
			const { w, desktop, mobile } = await setup();
			await desktop.vault.create('Inbox/from-desktop.md', 'd');
			await sleep(20);
			await desktop.push();
			await mobile.vault.create('Inbox/from-phone.md', 'p');
			await sleep(20);
			await mobile.pushWithoutPull();
			expect(stopped()).toBe(false);
			const drive = w.drive.snapshotNonConfig();
			expect(drive).toContain('Inbox/from-desktop.md');
			expect(drive).toContain('Inbox/from-phone.md');
			await mobile.pull();
			await desktop.pull();
			expect(same(mobile.tree(), desktop.tree())).toBe('IDENTICAL');
			expect(same(mobile.tree(), w.drive.snapshotNonConfig())).toBe('IDENTICAL');
		});

		it('a folder moved on Drive collides with a local edit of a note in it', async () => {
			const { w, desktop, mobile } = await setup();
			// "move" on the desktop = delete the folder and recreate the notes under another name
			await desktop.vault.rename(desktop.vault.getAbstractFileByPath('Projects/Beta')!, 'Projects/Gamma');
			await sleep(20);
			await desktop.push();
			await edit(mobile, 'Projects/Beta/readme.md', 'edited on phone');
			const driveBefore = w.drive.snapshotNonConfig();
			await mobile.pushWithoutPull();
			expect(stopped()).toBe(true);
			expect(w.drive.snapshotNonConfig()).toEqual(driveBefore);
		});
	});
});

describe('findCollisions', () => {
	const file = (path: string, previousPath?: string) => ({ path, previousPath, isFolder: false });
	const folder = (path: string) => ({ path, isFolder: true });

	it('same path collides', () => {
		expect(findCollisions([file('a.md')], [], ['a.md'])).toEqual(['a.md']);
	});
	it('different paths do not', () => {
		expect(findCollisions([file('a.md')], ['c.md'], ['b.md'])).toEqual([]);
	});
	it('a folder whose content changed does not collide with local ops inside it', () => {
		expect(findCollisions([folder('Inbox')], [], ['Inbox/x.md'])).toEqual([]);
	});
	it('a remote change inside a folder that was deleted or created locally collides', () => {
		expect(findCollisions([file('Inbox/x.md')], [], ['Inbox'])).toEqual(['Inbox/x.md']);
	});
	it('a path removed on Drive collides with local ops on it or below it', () => {
		expect(findCollisions([], ['Archive'], ['Archive/old.md'])).toEqual(['Archive']);
		expect(findCollisions([], ['Archive/old.md'], ['Archive/old.md'])).toEqual(['Archive/old.md']);
		expect(findCollisions([], ['Archive/old.md'], ['Archive/other.md'])).toEqual([]);
	});
	it('a moved item collides through its previous path', () => {
		expect(findCollisions([file('New/x.md', 'Old/x.md')], [], ['Old/x.md'])).toEqual(['Old/x.md']);
		expect(findCollisions([folder('New')], [], [])).toEqual([]);
	});
	it('names that merely start with the same letters do not collide', () => {
		expect(findCollisions([], ['Arch'], ['Archive/old.md'])).toEqual([]);
		expect(findCollisions([file('Archive2/x.md')], [], ['Archive'])).toEqual([]);
	});
	it('counts each remote path once', () => {
		expect(countRemoteChanges([file('a.md', 'a.md'), file('b.md', 'old/b.md')], ['c.md', 'c.md'])).toBe(4);
		expect(countRemoteChanges([], [])).toBe(0);
	});
});
