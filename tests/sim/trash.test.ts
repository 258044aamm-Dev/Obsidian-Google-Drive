/**
 * Drive Trash mode (deleteToTrash, the default) end-to-end on two simulated devices.
 * Drive's feed may or may not report a trashed file as `removed`; Pull must converge either way.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.stubGlobal('window', globalThis);
vi.mock('obsidian', async () => await import('./obsidian-mock'));
import { sleep, dec, notices } from './world';
import { setup, desktopCleanup, same, simDefaults } from './scenario-helpers';
import { TFile } from './obsidian-mock';

const failures = () => notices.filter((n) => /fail/i.test(n));
const live = (w: any) => [...w.drive.files.values()].filter((f: any) => !f.trashed && f.properties.obsidian !== 'vault');
const trashedPaths = (w: any) => [...w.drive.files.values()].filter((f: any) => f.trashed).map((f: any) => w.drive.shown(f) as string).sort();

describe('Drive Trash mode', () => {
	beforeEach(() => {
		simDefaults.deleteToTrash = true;
	});

	for (const feedReportsRemoved of [false, true]) {
		for (const omit of [false, true]) {
			describe(`feed reports trash as removed: ${feedReportsRemoved}, omits descendants: ${omit}`, () => {
				it('desktop cleanup (delete + move folders) trashes on Drive and the phone converges', async () => {
					const { w, desktop, mobile } = await setup();
					w.drive.trashEmitsRemoved = feedReportsRemoved;
					w.drive.omitDescendantRemovals = omit;
					await desktopCleanup(desktop);
					expect(failures()).toEqual([]);

					// nothing was destroyed on Drive: the deleted items are in the Trash
					expect(trashedPaths(w)).toEqual(expect.arrayContaining(['Archive', 'Archive/old.md', 'Inbox/a.md', 'Projects/Beta', 'Projects/Beta/readme.md']));
					expect(w.drive.gone.size).toBe(0);
					expect(same(desktop.tree(), w.drive.snapshotNonConfig())).toBe('IDENTICAL');

					await mobile.pull();
					expect(failures()).toEqual([]);
					expect(same(desktop.tree(), mobile.tree())).toBe('IDENTICAL');
					expect(mobile.ops()).toEqual({});

					// a second pull and a push change nothing
					await mobile.pull();
					await mobile.push();
					expect(failures()).toEqual([]);
					expect(same(desktop.tree(), mobile.tree())).toBe('IDENTICAL');
					expect(same(mobile.tree(), w.drive.snapshotNonConfig())).toBe('IDENTICAL');
					expect(mobile.ops()).toEqual({});
				});
			});
		}
	}

	it('permanent mode is unchanged: files are really gone from Drive, no Trash involved', async () => {
		simDefaults.deleteToTrash = false;
		const { w, desktop, mobile } = await setup();
		await desktopCleanup(desktop);
		expect(trashedPaths(w)).toEqual([]);
		expect(w.drive.gone.size).toBeGreaterThan(0);
		await mobile.pull();
		expect(same(desktop.tree(), mobile.tree())).toBe('IDENTICAL');
	});

	it('a device with Trash off still understands deletions that another device trashed (and vice versa)', async () => {
		const { w, desktop, mobile } = await setup();
		mobile.plugin.settings.deleteToTrash = false; // phone deletes permanently, desktop trashes
		const v = desktop.vault;
		await v.delete(v.getAbstractFileByPath('Inbox/a.md')!);
		await sleep(20);
		await desktop.push();
		await mobile.pull();
		expect(mobile.tree()).not.toContain('Inbox/a.md');

		await mobile.vault.delete(mobile.vault.getAbstractFileByPath('Inbox/b.md')!);
		await sleep(20);
		await mobile.push();
		await desktop.pull();
		expect(same(desktop.tree(), mobile.tree())).toBe('IDENTICAL');
		expect(failures()).toEqual([]);
		expect(same(mobile.tree(), w.drive.snapshotNonConfig())).toBe('IDENTICAL');
	});

	it('when the trashed-file listing fails, Pull still completes; the next Pull catches up', async () => {
		const { w, desktop, mobile } = await setup();
		await desktopCleanup(desktop);
		w.drive.failTrashedList = true;
		expect(await mobile.pull()).not.toBe(false);
		// the feed alone did not reveal the trashed files, so nothing was deleted yet (and nothing broke)
		expect(mobile.tree()).toContain('Archive/old.md');
		w.drive.failTrashedList = false;
		await mobile.pull();
		expect(same(desktop.tree(), mobile.tree())).toBe('IDENTICAL');
		expect(mobile.ops()).toEqual({});
	});

	it('a file edited on the phone but trashed on Drive is kept and uploaded again (edit beats delete)', async () => {
		const { w, desktop, mobile } = await setup();
		await mobile.vault.modify(mobile.vault.getFileByPath('Inbox/b.md') as TFile, 'precious edit on phone');
		await mobile.save();
		const v = desktop.vault;
		await v.delete(v.getAbstractFileByPath('Inbox/b.md')!);
		await sleep(20);
		await desktop.push();
		await mobile.pull();
		expect(dec(mobile.vault.disk.get('Inbox/b.md')!.data as Uint8Array)).toBe('precious edit on phone');
		await mobile.push();
		expect(failures()).toEqual([]);
		const onDrive = live(w).find((f: any) => w.drive.shown(f) === 'Inbox/b.md');
		expect(dec((await w.drive.contentOf(onDrive))!)).toBe('precious edit on phone');
	});

	it('a note deleted and re-created at the same path ends up with the new content on the other device', async () => {
		const { desktop, mobile } = await setup();
		const v = desktop.vault;
		await v.delete(v.getAbstractFileByPath('Archive/old.md')!);
		await sleep(20);
		await desktop.push();
		await v.create('Archive/old.md', 'brand new');
		await sleep(20);
		await desktop.push();
		await mobile.pull();
		expect(failures()).toEqual([]);
		expect(dec(mobile.vault.disk.get('Archive/old.md')!.data as Uint8Array)).toBe('brand new');
		expect(same(desktop.tree(), mobile.tree())).toBe('IDENTICAL');
	});

	it('a local-only note inside a folder trashed on Drive survives and reaches Drive', async () => {
		const { w, desktop, mobile } = await setup();
		await mobile.vault.create('Projects/Beta/mine.md', 'written on phone');
		await mobile.save();
		const v = desktop.vault;
		await v.delete(v.getAbstractFileByPath('Projects/Beta')!);
		await sleep(20);
		await desktop.push();
		await mobile.pull();
		expect(mobile.tree()).toContain('Projects/Beta/mine.md');
		expect(mobile.tree()).not.toContain('Projects/Beta/readme.md');
		await mobile.push();
		expect(failures()).toEqual([]);
		expect(w.drive.snapshotNonConfig()).toContain('Projects/Beta/mine.md');
		expect(same(mobile.tree(), w.drive.snapshotNonConfig())).toBe('IDENTICAL');
	});
});
