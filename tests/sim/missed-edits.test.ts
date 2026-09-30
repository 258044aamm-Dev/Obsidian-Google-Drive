/**
 * Safety net: a note that was edited but whose event never reached the pending list must not be
 * skipped by Push. Only notes whose content really differs from Drive are added.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.stubGlobal('window', globalThis);
vi.mock('obsidian', async () => await import('./obsidian-mock'));
import { sleep, dec, notices, netLog } from './world';
import { setup, same, simDefaults } from './scenario-helpers';
import { TFile } from './obsidian-mock';
import { buildDoctorReport, renderReport } from '../../helpers/doctor';
import { editedSinceLastSync } from '../../helpers/missed-edits';

const driveText = (w: any, path: string) => {
	const f = [...w.drive.files.values()].find((x: any) => x.properties.path === path && !x.trashed);
	return f ? dec(f.content) : undefined;
};
const downloads = () => netLog.filter((l: string) => l.includes('alt=media')).length;

describe.each([true, false])('missed edits (deleteToTrash=%s)', (trash) => {
	beforeEach(() => {
		simDefaults.deleteToTrash = trash;
	});

	async function editWithoutEvent(d: any, path: string, text: string) {
		await d.vault.modify(d.vault.getFileByPath(path) as TFile, text);
		await sleep(20);
		delete d.plugin.settings.operations[path]; // the event was "missed"
	}

	it('a missed edit is found, shown as Modify and uploaded', async () => {
		const { w, mobile } = await setup();
		await editWithoutEvent(mobile, 'Inbox/a.md', 'edited, event lost');
		expect(mobile.ops()).toEqual({});
		await mobile.push();
		expect(driveText(w, 'Inbox/a.md')).toBe('edited, event lost');
		expect(notices.some((n) => n.includes('1 file synced'))).toBe(true);
		expect(mobile.ops()).toEqual({});
		expect(same(mobile.tree(), w.drive.snapshotNonConfig())).toBe('IDENTICAL');
	});

	it('several missed edits, including a binary file, all reach Drive', async () => {
		const { w, mobile } = await setup();
		await editWithoutEvent(mobile, 'Inbox/a.md', 'A2');
		await editWithoutEvent(mobile, 'Projects/Alpha/plan.md', 'PLAN2');
		await mobile.push();
		expect(driveText(w, 'Inbox/a.md')).toBe('A2');
		expect(driveText(w, 'Projects/Alpha/plan.md')).toBe('PLAN2');
		expect(notices.some((n) => n.includes('2 files synced'))).toBe(true);
	});

	it('touched but unchanged content is not pushed', async () => {
		const { w, mobile } = await setup();
		await editWithoutEvent(mobile, 'Inbox/a.md', 'a'); // same bytes as on Drive
		const before = w.drive.snapshotNonConfig();
		await mobile.push();
		expect(mobile.ops()).toEqual({});
		expect(notices.some((n) => n.includes('Nothing to push'))).toBe(true);
		expect(w.drive.snapshotNonConfig()).toEqual(before);
	});

	it('with nothing edited Push downloads nothing and says so', async () => {
		const { mobile } = await setup();
		netLog.length = 0;
		await mobile.push();
		expect(downloads()).toBe(0);
		expect(notices.some((n) => n.includes('Nothing to push'))).toBe(true);
		expect(notices.some((n) => n.includes('0 files synced'))).toBe(false);
	});

	it('an edit that is already pending is left alone (no comparison needed)', async () => {
		const { w, mobile } = await setup();
		await mobile.vault.modify(mobile.vault.getFileByPath('Inbox/a.md') as TFile, 'normal edit');
		await sleep(20);
		netLog.length = 0;
		await mobile.push();
		expect(driveText(w, 'Inbox/a.md')).toBe('normal edit');
		expect(downloads()).toBe(0);
	});

	it('files that were pulled are not mistaken for local edits', async () => {
		const { w, desktop, mobile } = await setup();
		await desktop.vault.modify(desktop.vault.getFileByPath('Inbox/b.md') as TFile, 'desktop b');
		await sleep(20);
		await desktop.push();
		await mobile.pull();
		await sleep(20);
		netLog.length = 0;
		const driveBefore = w.drive.snapshotNonConfig();
		await mobile.push();
		expect(downloads()).toBe(0);
		expect(w.drive.snapshotNonConfig()).toEqual(driveBefore);
		expect(notices.some((n) => n.includes('Nothing to push'))).toBe(true);
	});

	it('a bulk change beyond the comparison limit is added without comparing each file', async () => {
		const { w, mobile } = await setup();
		await mobile.vault.createFolder('Bulk');
		for (let i = 0; i < 60; i++) await mobile.vault.create(`Bulk/n${i}.md`, `v1 ${i}`);
		await sleep(20);
		await mobile.push();
		await sleep(20);
		for (let i = 0; i < 60; i++) {
			await mobile.vault.modify(mobile.vault.getFileByPath(`Bulk/n${i}.md`) as TFile, `v2 ${i}`);
			delete mobile.plugin.settings.operations[`Bulk/n${i}.md`];
		}
		await sleep(20);
		netLog.length = 0;
		await mobile.push();
		for (let i = 0; i < 60; i++) expect(driveText(w, `Bulk/n${i}.md`)).toBe(`v2 ${i}`);
		expect(downloads()).toBe(50); // the first 50 are compared, the rest are added as they are
	});

	it('a missed edit does not bypass the newer-on-Drive check', async () => {
		const { w, desktop, mobile } = await setup();
		await desktop.vault.modify(desktop.vault.getFileByPath('Inbox/b.md') as TFile, 'desktop b');
		await sleep(20);
		await desktop.push();
		await editWithoutEvent(mobile, 'Inbox/a.md', 'phone a');
		const before = w.drive.snapshotNonConfig();
		await mobile.push();
		expect(notices.some((n) => n.includes('Push stopped'))).toBe(true);
		expect(w.drive.snapshotNonConfig()).toEqual(before);
		// the edit is now pending, not lost
		expect(mobile.ops()).toEqual({ 'Inbox/a.md': 'modify' });
	});

	it('counts vault events for the Sync doctor', async () => {
		const { mobile } = await setup();
		const n = mobile.plugin.vaultEventCount;
		await mobile.vault.modify(mobile.vault.getFileByPath('Inbox/a.md') as TFile, 'x');
		expect(mobile.plugin.vaultEventCount).toBe(n + 1);
	});
});

describe('editedSinceLastSync', () => {
	const files = [
		{ path: 'a.md', mtime: 200 },
		{ path: 'b.md', mtime: 50 },
		{ path: 'c.md', mtime: 300 },
		{ path: 'd.md', mtime: 300 },
	];
	const ids = { 'a.md': '1', 'b.md': '2', 'c.md': '3' };
	it('keeps only tracked, unpending files written after the last sync', () => {
		expect(editedSinceLastSync(files, ids, { 'c.md': 'modify' }, 100)).toEqual(['a.md']);
	});
	it('never flags anything on a device that has not synced yet', () => {
		expect(editedSinceLastSync(files, ids, {}, 0)).toEqual([]);
	});
});

describe('Sync doctor lines', () => {
	const base = {
		pluginVersion: 't',
		settings: { operations: {}, driveIdToPath: {}, lastSyncedAt: 0, hasRefreshToken: true, hasChangesToken: true, startupPull: false, autoPush: false },
		localPaths: [],
		drive: [],
	};
	it('reports zero events and edits that are not pending', () => {
		const text = renderReport(buildDoctorReport({ ...base, environment: { vaultEvents: 0, unrecordedEdits: ['x.md', 'y.md'] } }));
		expect(text).toContain('Change tracking: 0 vault events seen');
		expect(text).toContain('tracking is not working');
		expect(text).toContain('not in the pending list: 2 (x.md, y.md)');
	});
	it('is silent about both when all is well, and unchanged without the new facts', () => {
		const ok = renderReport(buildDoctorReport({ ...base, environment: { vaultEvents: 4, unrecordedEdits: [] } }));
		expect(ok).toContain('Change tracking: 4 vault events seen');
		expect(ok).not.toContain('not in the pending list');
		expect(renderReport(buildDoctorReport(base))).not.toContain('Change tracking');
	});
});
