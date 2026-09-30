/**
 * End-to-end regression tests: the REAL plugin code (main/pull/push/drive) running on two
 * simulated devices against an in-memory Google Drive. See investigation/SYNC-INVESTIGATION.md.
 *
 * `it.fails` = known limitation that the current design cannot fix; it is fixed by the
 * state-based engine (plan P2-P6). They flip to hard failures if they start passing,
 * which tells us to promote them to normal tests.
 */
import { describe, expect, it, vi } from 'vitest';
vi.stubGlobal('window', globalThis);
vi.mock('obsidian', async () => await import('./obsidian-mock'));
import { sleep, dec, netLog } from './world';
import { setup, desktopCleanup, same } from './scenario-helpers';
import { TFile, modalTexts } from './obsidian-mock';
import { runSyncDoctor } from '../../helpers/doctor-command';

describe('sync regression (two devices, fake Drive)', () => {
	it('S0 clean bootstrap: phone == desktop == Drive, no pending ops', async () => {
		const { w, desktop, mobile } = await setup();
		expect(same(desktop.tree(), w.drive.snapshotNonConfig())).toBe('IDENTICAL');
		expect(same(desktop.tree(), mobile.tree())).toBe('IDENTICAL');
		expect(Object.keys(mobile.ops())).toHaveLength(0);
	});

	it('S7 files-only cleanup reaches the phone', async () => {
		const { desktop, mobile } = await setup();
		const v = desktop.vault;
		await v.delete(v.getAbstractFileByPath('Inbox/a.md')!);
		await v.delete(v.getAbstractFileByPath('Archive/old.md')!);
		await v.rename(v.getAbstractFileByPath('root.md')!, 'Inbox/root.md');
		await sleep(20);
		await desktop.push();
		await mobile.pull();
		expect(same(desktop.tree(), mobile.tree())).toBe('IDENTICAL');
		expect(mobile.ops()).toEqual({});
	});

	it('S6 a 404 on a child delete inside a parent-folder batch does not wedge push', async () => {
		const { w, desktop } = await setup();
		w.drive.strictBatch = true;
		await desktopCleanup(desktop);
		await desktop.push(); // retry
		expect(same(desktop.tree(), w.drive.snapshotNonConfig())).toBe('IDENTICAL');
		expect(Object.keys(desktop.ops())).toHaveLength(0);
	});

	for (const children of [true, false]) {
		describe(`folder deletes/moves (events for descendants: ${children})`, () => {
			it('S1/S2 manual Pull makes the phone match the desktop (no folder shells left)', async () => {
				const { desktop, mobile } = await setup({ eventsForChildren: children });
				await desktopCleanup(desktop);
				await mobile.pull();
				expect(same(desktop.tree(), mobile.tree())).toBe('IDENTICAL');
				expect(mobile.ops()).toEqual({});
			});

			it('S1c a later phone push does not resurrect anything on Drive or desktop', async () => {
				const { w, desktop, mobile } = await setup({ eventsForChildren: children });
				await desktopCleanup(desktop);
				await mobile.pull();
				await mobile.vault.modify(mobile.vault.getFileByPath('Inbox/b.md') as TFile, 'edited on phone');
				await sleep(20);
				await mobile.push();
				expect(same(desktop.tree(), w.drive.snapshotNonConfig())).toBe('IDENTICAL');
				await desktop.pull();
				expect(desktop.tree()).toContain('Journal/Alpha/plan.md');
				expect(desktop.tree()).not.toContain('Archive/');
				expect(desktop.tree()).not.toContain('Projects/Beta/');
				expect(desktop.tree()).not.toContain('Projects/Alpha/');
			});
		});
	}

	it('S1-first fork first launch (legacy map present, lastInstalledVersion empty) deletes nothing it should keep and keeps nothing it should delete', async () => {
		const { desktop, mobile } = await setup();
		await desktopCleanup(desktop);
		mobile.plugin.settings.lastInstalledVersion = '';
		await mobile.save();
		await mobile.start({ startupPull: true, settings: { startupPull: true } });
		await mobile.pull();
		expect(same(desktop.tree(), mobile.tree())).toBe('IDENTICAL');
	});

	it('S3b a pull that dies before local deletes run converges on retry and never resurrects', async () => {
		const { w, desktop, mobile } = await setup();
		await desktopCleanup(desktop);
		const orig = mobile.vault.fileManager.trashFile;
		let armed = true;
		mobile.vault.fileManager.trashFile = async (f: any) => {
			if (armed) {
				armed = false;
				throw new Error('EPERM simulated');
			}
			return orig(f);
		};
		expect(await mobile.pull()).toBe(false);
		await mobile.save();
		mobile.vault.fileManager.trashFile = orig;
		await mobile.start({ startupPull: false });
		await mobile.pull();
		expect(same(desktop.tree(), mobile.tree())).toBe('IDENTICAL');
		await mobile.vault.modify(mobile.vault.getFileByPath('Inbox/b.md') as TFile, 'edit');
		await sleep(20);
		await mobile.push();
		expect(same(desktop.tree(), w.drive.snapshotNonConfig())).toBe('IDENTICAL');
	});

	it('startup is manual by default: opening Obsidian never contacts Drive or changes the vault', async () => {
		const { desktop, mobile } = await setup();
		await desktopCleanup(desktop);
		const before = mobile.tree();
		const calls = netLog.length;
		await mobile.start(); // harness default = "layout ready, online"; plugin default startupPull = false
		await sleep(50);
		expect(netLog.length).toBe(calls);
		expect(mobile.tree()).toEqual(before);
	});

	it('startupPull opt-in pulls on startup and converges', async () => {
		const { desktop, mobile } = await setup();
		await desktopCleanup(desktop);
		await mobile.start({ startupPull: true, settings: { startupPull: true } });
		expect(same(desktop.tree(), mobile.tree())).toBe('IDENTICAL');
		expect(mobile.ops()).toEqual({});
	});

	it('a folder deleted on Drive keeps a local-only note inside it (no data loss), and the note reaches Drive on push', async () => {
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
		expect(w.drive.snapshotNonConfig()).toContain('Projects/Beta/mine.md');
		expect(same(mobile.tree(), w.drive.snapshotNonConfig())).toBe('IDENTICAL');
	});

	describe("the plugin's own folder is never synced", () => {
		const own = '.obsidian/plugins/google-drive-sync';
		const driveConfigPaths = (w: any) =>
			[...w.drive.files.values()]
				.filter((f: any) => f.properties.config === 'true')
				.map((f: any) => f.properties.path as string);

		it('push does not upload main.js/manifest.json/data.json, but still syncs other plugins and config files', async () => {
			const { w, desktop } = await setup();
			const disk = desktop.vault.disk as Map<string, any>;
			disk.set('.obsidian/plugins/other', { type: 'folder', mtime: Date.now() });
			disk.set('.obsidian/plugins/other/main.js', { type: 'file', data: new Uint8Array([1, 2, 3]), mtime: Date.now() + 1000 });
			disk.set(`${own}/data.json`, { type: 'file', data: new Uint8Array([123, 125]), mtime: Date.now() + 1000 });
			disk.set(`${own}/main.js`, { type: 'file', data: new Uint8Array([9]), mtime: Date.now() + 1000 });
			await desktop.vault.create('Inbox/trigger.md', 't');
			await sleep(20);
			await desktop.push();
			const cfg = driveConfigPaths(w);
			expect(cfg.filter((p) => p.startsWith(own))).toEqual([]);
			expect(cfg).toContain('.obsidian/plugins/other/main.js');
		});

		it('pull neither overwrites nor deletes it when another device (e.g. upstream) put it on Drive', async () => {
			const { w, mobile } = await setup();
			const root = w.drive.rootId;
			const folderIds: Record<string, string> = {};
			let parent = root;
			let acc = '';
			for (const seg of ['.obsidian', 'plugins', 'google-drive-sync']) {
				acc = acc ? `${acc}/${seg}` : seg;
				parent = folderIds[acc] = w.drive.add({
					name: seg,
					mimeType: 'application/vnd.google-apps.folder',
					parents: [parent],
					properties: { path: acc, config: 'true', vault: 'V' },
				});
			}
			const fileId = w.drive.add({
				name: 'main.js',
				parents: [parent],
				properties: { path: `${own}/main.js`, config: 'true', vault: 'V' },
				content: new Uint8Array([70, 79, 82, 69, 73, 71, 78]),
				modifiedTime: new Date(Date.now() + 5000).toISOString(),
			});
			await mobile.pull();
			const local = () => (mobile.vault.disk as Map<string, any>).get(`${own}/main.js`)?.data;
			expect(dec(local())).toBe('//plugin');
			w.drive.remove(fileId);
			await mobile.pull();
			expect(dec(local())).toBe('//plugin');
		});
	});

	describe('sync doctor', () => {
		it('reports what a Pull would do, and changes nothing (GET requests only)', async () => {
			const { desktop, mobile } = await setup();
			await desktopCleanup(desktop);
			const stateBefore = JSON.stringify(mobile.plugin.settings);
			const treeBefore = mobile.tree();
			const calls = netLog.length;
			modalTexts.length = 0;
			await runSyncDoctor(mobile.plugin);
			const writes = netLog.slice(calls).filter((l) => !l.startsWith('GET '));
			expect(writes).toEqual([]);
			expect(JSON.stringify(mobile.plugin.settings)).toBe(stateBefore);
			expect(mobile.tree()).toEqual(treeBefore);
			const report = modalTexts.join('\n');
			expect(report).toContain('Deleted on Drive, still here (Pull removes)');
			expect(report).toContain('Archive/old.md');
			expect(report).toContain('Run Pull to remove them here');
			expect(report).not.toContain('refreshToken');
		});
	});

	// ---- known limitations of the legacy design, fixed by the state-based engine (P2-P6) ----
	it.fails('S4 phone clock ahead by 60s still receives a file pushed by the desktop', async () => {
		const { desktop, mobile } = await setup();
		mobile.plugin.settings.lastSyncedAt = Date.now() + 60_000;
		await mobile.save();
		await desktop.vault.create('Inbox/new-from-desktop.md', 'hello');
		await sleep(20);
		await desktop.push();
		await mobile.pull();
		expect(same(desktop.tree(), mobile.tree())).toBe('IDENTICAL');
	});

	it.fails('S5b a phone that inherited stale pending ops never overwrites a newer desktop edit', async () => {
		const { w, desktop, mobile } = await setup();
		// emulate README-style bootstrap: phone's data.json carries desktop's stale pending ops
		for (const p of ['Inbox/b.md', 'Inbox/a.md']) mobile.plugin.settings.operations[p] = 'modify';
		await mobile.save();
		await desktop.vault.modify(desktop.vault.getFileByPath('Inbox/b.md') as TFile, 'NEW TEXT FROM DESKTOP');
		await sleep(20);
		await desktop.push();
		await mobile.start({ startupPull: false });
		await mobile.pull();
		await mobile.vault.modify(mobile.vault.getFileByPath('Inbox/c-none.md') as TFile, 'x').catch(() => {});
		await mobile.push();
		const drive = [...w.drive.files.values()].find((f) => f.properties.path === 'Inbox/b.md')!;
		expect(dec(drive.content!)).toBe('NEW TEXT FROM DESKTOP');
	});
});
