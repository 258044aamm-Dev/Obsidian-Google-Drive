/**
 * 3.6.2: the device remembers its own uploads and the state of each synced note.
 *  - a Push without pulling twice in a row is not a conflict with itself;
 *  - a real change made on another device in between still is;
 *  - a bulk of untracked notes is not re-uploaded by every Push;
 *  - an edit older than the last sync marker is found through the remembered state;
 *  - the Push result says what Drive holds.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.stubGlobal('window', globalThis);
vi.mock('obsidian', async () => await import('./obsidian-mock'));
import { sleep, dec, notices } from './world';
import { setup, simDefaults, simE2ee } from './scenario-helpers';
import { TFile } from './obsidian-mock';

const driveText = async (w: any, path: string) => {
	const f = [...w.drive.files.values()].find((x: any) => w.drive.shown(x) === path && !x.trashed);
	return f ? dec(await w.drive.contentOf(f)) : undefined;
};
const revisions = (w: any) => [...w.drive.files.values()].reduce((n: number, f: any) => n + f.revisions.length, 0);
const stopped = () => notices.some((n) => n.includes('Push stopped'));

async function edit(d: any, path: string, text: string) {
	await d.vault.modify(d.vault.getFileByPath(path) as TFile, text);
	await sleep(20);
}

describe.each([true, false])('sync memory (deleteToTrash=%s)', (trash) => {
	beforeEach(() => {
		simDefaults.deleteToTrash = trash;
	});

	it('two "Push without pulling" in a row on the same note are not a conflict with itself', async () => {
		const { w, desktop, mobile } = await setup();
		await edit(desktop, 'Inbox/b.md', 'desktop b');
		await desktop.push(); // Drive is now ahead of the phone, so the phone cannot move its marker

		await edit(mobile, 'Inbox/a.md', 'phone a 1');
		await mobile.pushWithoutPull();
		expect(stopped()).toBe(false);
		expect(await driveText(w, 'Inbox/a.md')).toBe('phone a 1');

		await edit(mobile, 'Inbox/a.md', 'phone a 2');
		await mobile.pushWithoutPull();
		expect(stopped()).toBe(false);
		expect(await driveText(w, 'Inbox/a.md')).toBe('phone a 2');
		expect(mobile.ops()).toEqual({});
	});

	it('a change made on another device in between is still a real conflict', async () => {
		const { w, desktop, mobile } = await setup();
		await edit(desktop, 'Inbox/b.md', 'desktop b');
		await desktop.push();
		await edit(mobile, 'Inbox/a.md', 'phone a 1');
		await mobile.pushWithoutPull();
		expect(stopped()).toBe(false);

		await desktop.pull(); // the desktop receives the phone's a, then edits it
		await edit(desktop, 'Inbox/a.md', 'desktop a');
		await desktop.push();
		expect(await driveText(w, 'Inbox/a.md')).toBe('desktop a');

		await edit(mobile, 'Inbox/a.md', 'phone a 2');
		const before = revisions(w);
		await mobile.pushWithoutPull();
		expect(stopped()).toBe(true);
		expect(notices.some((n) => n.includes('another device'))).toBe(true);
		expect(revisions(w)).toBe(before);
		expect(await driveText(w, 'Inbox/a.md')).toBe('desktop a');
		expect(mobile.ops()).toEqual({ 'Inbox/a.md': 'modify' });
	});

	it('untracked notes (a copied vault) are not re-uploaded by every Push', async () => {
		const { w, desktop, mobile } = await setup();
		const names = Array.from({ length: 60 }, (_, i) => `Inbox/bulk${String(i).padStart(2, '0')}.md`);
		for (const p of names) await desktop.vault.create(p, 'x ' + p);
		await sleep(20);
		await desktop.push();
		await mobile.pull();
		await edit(desktop, 'Inbox/b.md', 'desktop b');
		await desktop.push(); // Drive is ahead: the phone's Pushes below do not move its marker

		// as after copying a vault to a phone: same content, newer times, nothing remembered
		delete mobile.plugin.settings.syncedFiles;
		await sleep(20);
		for (const p of names) {
			await mobile.vault.modify(mobile.vault.getFileByPath(p) as TFile, 'x ' + p);
			delete mobile.plugin.settings.operations[p];
		}
		await sleep(20);

		await mobile.pushWithoutPull();
		const afterFirst = revisions(w);
		await mobile.pushWithoutPull();
		expect(notices.some((n) => n.includes('Nothing to push'))).toBe(true);
		expect(revisions(w)).toBe(afterFirst);
		expect(mobile.ops()).toEqual({});
	});

	it('an edit whose event was lost is found even when it is older than the last sync', async () => {
		const { w, mobile } = await setup();
		await mobile.vault.modify(mobile.vault.getFileByPath('Inbox/a.md') as TFile, 'edited, event lost');
		delete mobile.plugin.settings.operations['Inbox/a.md'];
		await sleep(20);
		await mobile.pull(); // moves the marker past the edit
		expect(mobile.plugin.settings.lastSyncedAt).toBeGreaterThan(
			mobile.vault.disk.get('Inbox/a.md')!.mtime,
		);
		await mobile.push();
		expect(await driveText(w, 'Inbox/a.md')).toBe('edited, event lost');
		expect(notices.some((n) => n.includes('1 file synced'))).toBe(true);
	});

	it('the Push result says the uploaded files were checked on Drive', async () => {
		const { mobile } = await setup();
		await edit(mobile, 'Inbox/a.md', 'phone a');
		await mobile.push();
		const done = notices.find((n) => n.includes('Push complete')) ?? '';
		expect(done).toContain('Checked 1 uploaded file(s) on Google Drive: all present.');
		expect(done.includes('random names')).toBe(simE2ee.on);
	});

	it('remembers the state of a note after the first successful Push and Pull', async () => {
		const { mobile } = await setup();
		expect(mobile.plugin.settings.syncedFiles['Inbox/a.md']).toBeTruthy();
		await edit(mobile, 'Inbox/a.md', 'phone a');
		const before = { ...mobile.plugin.settings.syncedFiles['Inbox/a.md'] };
		await mobile.push();
		expect(mobile.plugin.settings.syncedFiles['Inbox/a.md']).not.toEqual(before);
		const file = mobile.vault.getFileByPath('Inbox/a.md') as any;
		const now = mobile.plugin.settings.syncedFiles['Inbox/a.md'];
		expect({ m: now.m, s: now.s }).toEqual({ m: file.stat.mtime, s: file.stat.size });
		expect(now.h).toMatch(/^[0-9a-f]{32}$/);
	});
});
