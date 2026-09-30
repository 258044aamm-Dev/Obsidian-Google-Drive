/**
 * Whole-vault version history: restore points are saved after every Push, pruned by age, hidden from
 * normal sync, and a restore is local first, reversible, and never uploads by itself.
 * Runs against the real plugin code and the in-memory Drive (which keeps old file revisions).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.stubGlobal('window', globalThis);
vi.mock('obsidian', async () => await import('./obsidian-mock'));
import { sleep, dec, enc, notices, netLog } from './world';
import { setup, same, simDefaults } from './scenario-helpers';
import { TFile } from './obsidian-mock';
import { decodePoint, historyRetentionDays, listRestorePoints, recordRestorePoint, type RestorePointData } from '../../helpers/history';
import { applyRestorePlan, buildRestorePlan, prepareRestore, restoreBlocker } from '../../helpers/history-restore';
import { createRestorePointNow } from '../../helpers/history-ui';

type Setup = Awaited<ReturnType<typeof setup>>;

const pointFiles = (s: Setup) =>
	[...s.w.drive.files.values()]
		.filter((f) => f.properties.history && f.properties.kind === 'point' && !f.trashed)
		.sort((a, b) => Number(a.properties.createdAt) - Number(b.properties.createdAt));
const manifest = async (f: { content: Uint8Array | null }): Promise<RestorePointData> => decodePoint((f.content as Uint8Array).slice().buffer);
const infos = (s: Setup) => listRestorePoints(s.desktop.plugin);
const read = (d: { vault: { disk: Map<string, any> } }, p: string) => {
	const f = d.vault.disk.get(p);
	return f ? dec(f.data as Uint8Array) : undefined;
};
const edit = async (s: Setup, path: string, text: string) => {
	await s.desktop.vault.modify(s.desktop.vault.getFileByPath(path) as TFile, text);
	await sleep(20);
};
const failures = () => notices.filter((n) => /fail/i.test(n));

describe.each([true, false])('version history (deleteToTrash=%s)', (trash) => {
	beforeEach(() => {
		simDefaults.deleteToTrash = trash;
		simDefaults.historyEnabled = true;
	});
	afterEach(() => {
		delete simDefaults.historyEnabled;
	});

	describe('recording', () => {
		it('saves a restore point with every file, its Drive id and head revision after a Push; nothing when nothing changed', async () => {
			const s = await setup();
			expect(pointFiles(s)).toHaveLength(1);
			const first = await manifest(pointFiles(s)[0]!);
			const a = first.e.find((e) => e.p === 'Inbox/a.md')!;
			expect(a.r).toBeTruthy();
			expect(a.m).toMatch(/^[0-9a-f]{32}$/);
			expect(a.s).toBe(1);
			expect(first.e.find((e) => e.p === 'Projects/Alpha')?.f).toBe(1);
			expect(first.e.map((e) => e.p)).not.toContain('V'); // not the root folder
			expect(first.e.filter((e) => !e.f)).toHaveLength(8);

			await s.desktop.push(); // nothing pending
			await sleep(20);
			expect(pointFiles(s)).toHaveLength(1);

			await edit(s, 'Inbox/a.md', 'a2');
			await s.desktop.push();
			expect(pointFiles(s)).toHaveLength(2);
			const second = await manifest(pointFiles(s)[1]!);
			const a2 = second.e.find((e) => e.p === 'Inbox/a.md')!;
			expect(a2.r).not.toBe(a.r);
			expect(a2.m).not.toBe(a.m);
			expect(second.e.find((e) => e.p === 'Inbox/b.md')?.r).toBe(first.e.find((e) => e.p === 'Inbox/b.md')?.r);
			expect(failures()).toEqual([]);
		});

		it('keeps the history out of normal sync: own folder, no vault/obsidian tags, invisible to Pull and to the Drive listing of the vault', async () => {
			const s = await setup();
			const point = pointFiles(s)[0]!;
			expect(point.properties.vault).toBeUndefined();
			expect(point.properties.obsidian).toBeUndefined();
			const folder = s.w.drive.files.get(point.parents[0]!)!;
			expect(folder.properties.history).toBe('V');
			expect(folder.properties.vault).toBeUndefined();
			expect(folder.parents).toEqual(['root']); // beside the vault folder, never inside it (README: new devices download that folder)
			expect(s.w.drive.snapshot().some((p) => p.includes('restore-point') || p === '?')).toBe(false);

			await edit(s, 'Inbox/a.md', 'a2');
			await s.desktop.push();
			await s.mobile.pull();
			expect(failures()).toEqual([]);
			expect(same(s.desktop.tree(), s.mobile.tree())).toBe('IDENTICAL');
			expect(s.mobile.ops()).toEqual({});
			expect(same(s.desktop.tree(), s.w.drive.snapshotNonConfig())).toBe('IDENTICAL');
		});

		it('records settings files with a flag and never this plugin\'s own folder', async () => {
			const s = await setup();
			await sleep(20);
			await s.desktop.vault.adapter.writeBinary('.obsidian/app.json', enc('{"a":1}'), { mtime: Date.now() });
			await edit(s, 'Inbox/a.md', 'a2');
			await s.desktop.push();
			const newest = await manifest(pointFiles(s).at(-1)!);
			const cfg = newest.e.find((e) => e.p === '.obsidian/app.json');
			expect(cfg?.c).toBe(1);
			expect(cfg?.r).toBeTruthy();
			expect(newest.e.some((e) => e.p.startsWith('.obsidian/plugins/google-drive-sync'))).toBe(false);
		});

		it('is switched off by the setting: no restore point, no history folder', async () => {
			simDefaults.historyEnabled = false;
			const s = await setup();
			await edit(s, 'Inbox/a.md', 'a2');
			await s.desktop.push();
			expect(pointFiles(s)).toHaveLength(0);
			expect([...s.w.drive.files.values()].some((f) => f.properties.history)).toBe(false);
			expect(same(s.desktop.tree(), s.w.drive.snapshotNonConfig())).toBe('IDENTICAL');
		});

		it('a failure while saving the restore point never fails the Push', async () => {
			const s = await setup();
			await edit(s, 'Inbox/a.md', 'a2');
			s.w.drive.failNext.push({ match: /^POST \/upload\/drive\/v3\/files$/, status: 500 });
			await s.desktop.push();
			expect(s.desktop.ops()).toEqual({});
			expect(pointFiles(s)).toHaveLength(1); // only the one from setup
			const a = [...s.w.drive.files.values()].find((f) => f.properties.path === 'Inbox/a.md' && !f.trashed)!;
			expect(dec(a.content as Uint8Array)).toBe('a2');
			expect(notices.join('\n')).toMatch(/restore point failed/i);
			// the next Push saves one again
			await edit(s, 'Inbox/b.md', 'b2');
			await s.desktop.push();
			expect(pointFiles(s)).toHaveLength(2);
		});

		it('deletes restore points older than the retention period, but always keeps the newest', async () => {
			const s = await setup();
			for (const [i, text] of ['x1', 'x2', 'x3'].entries()) {
				await edit(s, 'Inbox/a.md', text + i);
				await s.desktop.push();
			}
			expect(pointFiles(s)).toHaveLength(4);
			const day = 86_400_000;
			const [p0, p1, p2] = pointFiles(s);
			p0!.properties.createdAt = String(Date.now() - 12 * day);
			p1!.properties.createdAt = String(Date.now() - 11 * day);
			p2!.properties.createdAt = String(Date.now() - 5 * day);
			await edit(s, 'Inbox/a.md', 'x9');
			await s.desktop.push();
			const left = pointFiles(s);
			expect(left).toHaveLength(3); // 12d and 11d gone; 5d, previous newest and the new one stay
			expect(left.map((f) => f.id)).toContain(p2!.id);
			expect(left.map((f) => f.id)).not.toContain(p0!.id);

			// retention 1 day, and a newest point that is itself old
			s.desktop.plugin.settings.historyRetentionDays = 1;
			const ordered = pointFiles(s);
			ordered.forEach((f, i) => (f.properties.createdAt = String(Date.now() - (20 + ordered.length - i) * day)));
			const newestId = ordered.at(-1)!.id;
			expect(ordered.length).toBeGreaterThan(1);
			const result = await recordRestorePoint(s.desktop.plugin); // state unchanged: prunes only
			expect(result.status).toBe('unchanged');
			expect(pointFiles(s).map((f) => f.id)).toEqual([newestId]);
		});

		it('clamps the retention setting to 1..30 days and falls back to 10', () => {
			const t = (v: unknown) => historyRetentionDays({ settings: { historyRetentionDays: v } } as never);
			expect([t(10), t(1), t(30), t(0), t(-5), t(500), t(2.6), t(undefined), t('x')]).toEqual([10, 1, 30, 1, 1, 30, 3, 10, 10]);
		});

		it('"Create restore point now" reports a new point, then that nothing changed', async () => {
			simDefaults.historyEnabled = false;
			const s = await setup();
			notices.length = 0;
			await createRestorePointNow(s.desktop.plugin);
			expect(notices.at(-1)).toMatch(/Restore point saved/);
			expect(pointFiles(s)).toHaveLength(1);
			await createRestorePointNow(s.desktop.plugin);
			expect(notices.at(-1)).toMatch(/Nothing has changed/);
			expect(pointFiles(s)).toHaveLength(1);
			expect(s.desktop.plugin.syncing).toBe(false);
		});
	});

	describe('restoring', () => {
		let originalTree: string[] = [];
		/** desktop: edit a.md, delete Archive/old.md, delete folder Projects/Beta, create new.md + NewDir/n.md, push */
		async function changed() {
			const s = await setup();
			const v = s.desktop.vault;
			originalTree = s.desktop.tree();
			await edit(s, 'Inbox/a.md', 'changed');
			await v.delete(v.getAbstractFileByPath('Archive/old.md')!);
			await v.delete(v.getAbstractFileByPath('Projects/Beta')!);
			await v.create('new.md', 'brand new');
			await v.createFolder('NewDir');
			await v.create('NewDir/n.md', 'n');
			await sleep(20);
			await s.desktop.push();
			return s;
		}
		const restoreTo = async (s: Setup, index: number, includeConfig = true) => {
			const t = s.desktop.plugin;
			expect(await prepareRestore(t)).toBeUndefined();
			const infosNow = await infos(s);
			const target = [...infosNow].sort((a, b) => a.createdAt - b.createdAt)[index]!;
			const built = await buildRestorePlan(t, target, includeConfig);
			return { built, target };
		};

		it('builds the plan from the point and from Drive as it is now', async () => {
			const s = await changed();
			const { built } = await restoreTo(s, 0);
			const { plan } = built;
			expect(plan.revert.map((i) => i.path)).toEqual(['Inbox/a.md']);
			expect(plan.remove.map((r) => r.path)).toEqual(['NewDir', 'NewDir/n.md', 'new.md']);
			if (trash) {
				expect(plan.recreate.map((i) => i.path)).toEqual(['Archive/old.md', 'Projects/Beta/readme.md']);
				expect(plan.folders).toEqual(['Projects/Beta']);
				expect(plan.skipped).toEqual([]);
			} else {
				// permanent deletes left nothing to restore from: reported, not attempted
				expect(plan.recreate).toEqual([]);
				expect(plan.skipped.map((x) => x.path)).toEqual(['Archive/old.md', 'Projects/Beta/readme.md']);
				expect(plan.skipped[0]!.reason).toMatch(/no longer has/);
			}
			expect(plan.unchanged).toBeGreaterThan(3);
		});

		it('applies locally only (nothing is uploaded), through normal pending operations', async () => {
			const s = await changed();
			const { built } = await restoreTo(s, 0);
			const before = JSON.stringify(s.w.drive.snapshot());
			const calls = netLog.length;
			const result = await applyRestorePlan(s.desktop.plugin, built.plan);
			expect(result.failed).toEqual([]);
			expect(result.reverted).toBe(1);
			expect(result.removed).toBe(2);
			expect(result.foldersRemoved).toBe(1);
			expect(read(s.desktop, 'Inbox/a.md')).toBe('a');
			expect(s.desktop.vault.disk.has('new.md')).toBe(false);
			expect(s.desktop.vault.disk.has('NewDir')).toBe(false);
			if (trash) {
				expect(read(s.desktop, 'Archive/old.md')).toBe('old');
				expect(read(s.desktop, 'Projects/Beta/readme.md')).toBe('beta');
				expect(result.recreated).toBe(2);
			} else {
				expect(s.desktop.vault.disk.has('Archive/old.md')).toBe(false);
			}
			// no upload, update or delete was sent to Drive while restoring
			expect(netLog.slice(calls).filter((l) => /^(POST|PATCH|DELETE|PUT) /.test(l) && !/google\.com/.test(l))).toEqual([]);
			expect(JSON.stringify(s.w.drive.snapshot())).toBe(before);
			expect(s.desktop.plugin.syncing).toBe(false);
			const ops = s.desktop.ops();
			expect(ops['Inbox/a.md']).toBe('modify');
			expect(ops['new.md']).toBe('delete');
			expect(ops['NewDir/n.md']).toBe('delete');
			if (trash) expect(ops['Archive/old.md']).toBe('create');
		});

		it('after the normal Push, Drive and the other device equal the restored moment', async () => {
			const s = await changed();
			const { built } = await restoreTo(s, 0);
			await applyRestorePlan(s.desktop.plugin, built.plan);
			await s.desktop.push();
			expect(failures()).toEqual([]);
			expect(s.desktop.ops()).toEqual({});
			expect(same(s.desktop.tree(), s.w.drive.snapshotNonConfig())).toBe('IDENTICAL');
			await s.mobile.pull();
			expect(same(s.desktop.tree(), s.mobile.tree())).toBe('IDENTICAL');
			expect(read(s.mobile, 'Inbox/a.md')).toBe('a');
			expect(s.desktop.tree().includes('new.md')).toBe(false);
			if (trash) expect(s.desktop.tree()).toEqual(originalTree);
			// the restore itself is now part of the history
			expect((await infos(s)).length).toBeGreaterThanOrEqual(3);
		});

		it('saves a safety restore point first when the newest point is older than the current state, so the restore can be undone', async () => {
			const s = await setup();
			s.desktop.plugin.settings.historyEnabled = false; // this Push is not recorded
			await edit(s, 'Inbox/a.md', 'unrecorded');
			await s.desktop.push();
			s.desktop.plugin.settings.historyEnabled = true;
			expect(pointFiles(s)).toHaveLength(1);
			const { built } = await restoreTo(s, 0);
			const result = await applyRestorePlan(s.desktop.plugin, built.plan);
			expect(result.safetyPoint).toBeTruthy();
			expect(pointFiles(s)).toHaveLength(2);
			expect(read(s.desktop, 'Inbox/a.md')).toBe('a');
			await s.desktop.push();
			// undo: restore the safety point
			const t = s.desktop.plugin;
			expect(await prepareRestore(t)).toBeUndefined();
			const undo = await buildRestorePlan(t, result.safetyPoint!, true);
			await applyRestorePlan(t, undo.plan);
			expect(read(s.desktop, 'Inbox/a.md')).toBe('unrecorded');
		});

		it('refuses to start while there are unpushed changes, a sync is running, or auto-push is on', async () => {
			const s = await setup();
			const t = s.desktop.plugin;
			expect(restoreBlocker(t)).toBeUndefined();
			await s.desktop.vault.create('unpushed.md', 'x');
			expect(restoreBlocker(t)).toMatch(/not pushed yet/);
			expect(await prepareRestore(t)).toMatch(/not pushed yet/);
			await s.desktop.push();
			t.settings.autoPush = true;
			expect(restoreBlocker(t)).toMatch(/Automatically push/);
			t.settings.autoPush = false;
			t.syncing = true;
			expect(restoreBlocker(t)).toMatch(/sync is running/);
			await expect(applyRestorePlan(t, { revert: [], recreate: [], remove: [], folders: [], skipped: [], unchanged: 0, includeConfig: true })).rejects.toThrow(/sync is running/);
			t.syncing = false;
			expect(restoreBlocker(t)).toBeUndefined();
		});

		it('runs a Pull first and stops when that leaves something to push (nothing is changed)', async () => {
			const s = await setup();
			// both devices edit the same note: the phone has an unpushed edit, the desktop pushes another
			await s.mobile.vault.modify(s.mobile.vault.getFileByPath('Inbox/b.md') as TFile, 'phone');
			await s.mobile.save();
			await edit(s, 'Inbox/b.md', 'desktop');
			await s.desktop.push();
			expect(await prepareRestore(s.mobile.plugin)).toMatch(/not pushed yet/);
			expect(read(s.mobile, 'Inbox/b.md')).toBe('phone');
		});

		it('leaves a file alone whose old version Drive no longer has, and restores everything else', async () => {
			const s = await changed();
			await edit(s, 'Inbox/b.md', 'b-changed');
			await s.desktop.push();
			const { built, target } = await restoreTo(s, 0);
			expect(built.plan.revert.map((i) => i.path)).toEqual(['Inbox/a.md', 'Inbox/b.md']);
			// Drive forgets the old version of b.md
			const first = await manifest(pointFiles(s)[0]!);
			const b = first.e.find((e) => e.p === 'Inbox/b.md')!;
			expect(s.w.drive.expireRevision(b.i, b.r!)).toBe(true);
			const again = await buildRestorePlan(s.desktop.plugin, target, true);
			expect(again.plan.revert.map((i) => i.path)).toEqual(['Inbox/a.md']);
			expect(again.plan.skipped.find((x) => x.path === 'Inbox/b.md')?.reason).toMatch(/no longer has/);
			const result = await applyRestorePlan(s.desktop.plugin, again.plan);
			expect(result.failed).toEqual([]);
			expect(read(s.desktop, 'Inbox/a.md')).toBe('a');
			expect(read(s.desktop, 'Inbox/b.md')).toBe('b-changed'); // untouched
		});

		it('one file that cannot be downloaded is reported; the others are restored and the failed one is untouched', async () => {
			const s = await changed();
			await edit(s, 'Inbox/b.md', 'b-changed');
			await s.desktop.push();
			const { built } = await restoreTo(s, 0);
			s.w.drive.failNext.push({ match: /revisions\/[^/]+$/, status: 500 });
			// the first matching GET is the plan's own check for... none: checks already ran, so this hits a download
			const result = await applyRestorePlan(s.desktop.plugin, built.plan);
			expect(result.failed).toHaveLength(1);
			const failedPath = result.failed[0]!.path;
			expect(read(s.desktop, failedPath)).toBe(failedPath === 'Inbox/a.md' ? 'changed' : 'b-changed');
			expect(result.reverted).toBe(1);
			expect(s.desktop.ops()[failedPath]).toBeUndefined();
			// Push what was done, run the restore again, and it completes
			await s.desktop.push();
			const again = await restoreTo(s, 0);
			expect(again.built.plan.revert.map((i) => i.path)).toEqual([failedPath]);
			await applyRestorePlan(s.desktop.plugin, again.built.plan);
			expect(read(s.desktop, 'Inbox/a.md')).toBe('a');
			expect(read(s.desktop, 'Inbox/b.md')).toBe('b');
		});

		it('refuses to write a download whose size differs from the restore point', async () => {
			const s = await changed();
			const { built } = await restoreTo(s, 0);
			built.plan.revert[0]!.size = 999;
			const result = await applyRestorePlan(s.desktop.plugin, built.plan);
			expect(result.failed[0]?.error).toMatch(/bytes, expected 999/);
			expect(read(s.desktop, 'Inbox/a.md')).toBe('changed');
		});

		it('settings and plugin files: restored only when asked, written with a current time so the next Push sends them; never the plugin\'s own folder', async () => {
			const s = await setup();
			const adapter = s.desktop.vault.adapter;
			await sleep(20);
			await adapter.writeBinary('.obsidian/app.json', enc('{"v":1}'), { mtime: Date.now() });
			await edit(s, 'Inbox/a.md', 'a2');
			await s.desktop.push(); // point with app.json v1
			await sleep(20);
			await adapter.writeBinary('.obsidian/app.json', enc('{"v":2}'), { mtime: Date.now() });
			await adapter.writeBinary('.obsidian/newplugin.json', enc('{"later":1}'), { mtime: Date.now() });
			await edit(s, 'Inbox/a.md', 'a3');
			await s.desktop.push();
			// Drive holds a file of this plugin's own folder: it must not be touched either way
			s.w.drive.add({ name: 'data.json', parents: [s.w.drive.rootId], properties: { vault: 'V', config: 'true', path: '.obsidian/plugins/google-drive-sync/data.json' }, content: new Uint8Array(enc('{"token":1}')) });

			const pts = (await infos(s)).sort((a, b) => a.createdAt - b.createdAt);
			const target = pts[pts.length - 2]!; // the point with app.json v1
			const t = s.desktop.plugin;
			expect(await prepareRestore(t)).toBeUndefined();

			const without = await buildRestorePlan(t, target, false);
			expect([...without.plan.revert, ...without.plan.recreate].some((i) => i.config)).toBe(false);

			const withCfg = await buildRestorePlan(t, target, true);
			expect(withCfg.plan.revert.map((i) => i.path)).toEqual(['.obsidian/app.json', 'Inbox/a.md']);
			expect(withCfg.plan.remove.map((r) => r.path)).not.toContain('.obsidian/newplugin.json');
			expect([...withCfg.plan.revert, ...withCfg.plan.recreate, ...withCfg.plan.remove].some((i) => i.path.includes('google-drive-sync'))).toBe(false);

			const lastSynced = t.settings.lastSyncedAt;
			const result = await applyRestorePlan(t, withCfg.plan);
			expect(result.failed).toEqual([]);
			expect(read(s.desktop, '.obsidian/app.json')).toBe('{"v":1}');
			expect(read(s.desktop, '.obsidian/newplugin.json')).toBe('{"later":1}'); // not in the point: left alone
			expect(s.desktop.vault.disk.get('.obsidian/app.json')!.mtime).toBeGreaterThan(lastSynced);
			await s.desktop.push();
			const driveCfg = [...s.w.drive.files.values()].find((f) => f.properties.path === '.obsidian/app.json' && !f.trashed)!;
			expect(dec(driveCfg.content as Uint8Array)).toBe('{"v":1}');
		});

		it('a file or folder standing where the other kind used to be is skipped, not overwritten', async () => {
			const s = await setup();
			const v = s.desktop.vault;
			// "Journal" was a folder; it is deleted, the Push is done, then a FILE named Journal is created
			await v.delete(v.getAbstractFileByPath('Journal')!);
			await sleep(20);
			await s.desktop.push();
			await v.create('Journal', 'now a file');
			await sleep(20);
			await s.desktop.push();
			const { built } = await restoreTo(s, 0);
			const skipped = built.plan.skipped;
			expect(skipped.find((x) => x.path === 'Journal')?.reason).toMatch(/was a folder/);
			expect(skipped.find((x) => x.path === 'Journal/2026')?.reason).toMatch(/file is in the way at Journal/);
			expect(skipped.find((x) => x.path === 'Journal/2026/09-01.md')?.reason).toMatch(/in the way|no longer has/);
			const result = await applyRestorePlan(s.desktop.plugin, built.plan);
			expect(result.failed).toEqual([]);
			expect(read(s.desktop, 'Journal')).toBe('now a file');
		});
	});
});
