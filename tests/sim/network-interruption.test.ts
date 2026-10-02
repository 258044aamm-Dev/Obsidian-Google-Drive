/**
 * 3.6.4: a Push or Pull that is interrupted (connection lost half way) can simply be repeated.
 *  - uploaded notes are not uploaded again (no duplicate files or folders on Drive);
 *  - a delete that already happened on Drive does not block the next Push;
 *  - an interrupted Pull leaves no false "deleted here" entries behind;
 *  - the message says how far the Push got.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.stubGlobal('window', globalThis);
vi.mock('obsidian', async () => await import('./obsidian-mock'));
import { sleep, notices } from './world';
import { setup, simDefaults, simE2ee } from './scenario-helpers';
import { net } from './obsidian-mock';

const FOLDER = 'application/vnd.google-apps.folder';

/** From the n-th matching request on, every request fails like a lost connection. Returns the "connection is back" function. */
function dropAfter(n: number, pattern = /^POST \/upload\/drive\/v3\/files$/) {
	const original = net.handler;
	let seen = 0;
	let dead = false;
	net.handler = async (req: any) => {
		const key = (req.method ?? 'GET') + ' ' + new URL(req.url).pathname;
		if (dead) throw new Error('net::ERR_INTERNET_DISCONNECTED');
		if (pattern.test(key)) {
			if (seen >= n) {
				dead = true;
				throw new Error('net::ERR_INTERNET_DISCONNECTED');
			}
			seen++;
		}
		return original(req);
	};
	return () => {
		net.handler = original;
	};
}

const live = (w: any) =>
	[...w.drive.files.values()].filter((f: any) => !f.trashed && !f.properties?.history && f.id !== w.drive.rootId);
const noteCounts = (w: any) => {
	const m = new Map<string, number>();
	for (const f of live(w)) {
		if (f.mimeType === FOLDER) continue;
		const p = w.drive.shown(f);
		if (p && !/^Encrypted/.test(p)) m.set(p, (m.get(p) ?? 0) + 1);
	}
	return m;
};
const duplicates = (w: any) => [...noteCounts(w)].filter(([, n]) => n > 1).map(([p]) => p);
const text = () => notices.join('\n');

describe.each([true, false])('interrupted sync can be repeated (deleteToTrash=%s)', (trash) => {
	beforeEach(() => {
		simDefaults.deleteToTrash = trash;
	});

	it('Push interrupted after some uploads: the retry uploads only the rest, no duplicates', async () => {
		const { w, desktop } = await setup();
		for (let i = 1; i <= 6; i++) await desktop.vault.create(`n${i}.md`, 'new ' + i);
		await sleep(20);
		const back = dropAfter(3);
		await desktop.push();
		expect(text(), text()).toMatch(/Push failed during upload\. 3 files were uploaded before it stopped and 3 changes are still pending/);
		// which three get through depends on timing (encryption is asynchronous): only the count is fixed
		expect(Object.values(desktop.ops())).toEqual(['create', 'create', 'create']);
		back();

		await desktop.push();
		expect(text(), text()).toMatch(/Push complete — 3 files synced/);
		expect(duplicates(w)).toEqual([]);
		expect(desktop.ops()).toEqual({});
		for (let i = 1; i <= 6; i++) expect(noteCounts(w).get(`n${i}.md`)).toBe(1);
	});

	it('the same with "Push without pulling"', async () => {
		const { w, desktop } = await setup();
		for (let i = 1; i <= 6; i++) await desktop.vault.create(`n${i}.md`, 'new ' + i);
		await sleep(20);
		const back = dropAfter(3);
		await desktop.pushWithoutPull();
		back();
		await desktop.pushWithoutPull();
		expect(duplicates(w)).toEqual([]);
		expect(desktop.ops()).toEqual({});
	});

	it('a new folder with notes in it is not created twice, and the phone ends up with a clean state', async () => {
		const { w, desktop, mobile } = await setup();
		await desktop.vault.createFolder('Z');
		for (let i = 1; i <= 3; i++) await desktop.vault.create(`Z/z${i}.md`, 'z ' + i);
		await sleep(20);
		const back = dropAfter(1);
		await desktop.push();
		back();
		await desktop.push();
		expect(duplicates(w)).toEqual([]);
		if (!simE2ee.on) {
			expect(live(w).filter((f) => f.mimeType === FOLDER && f.name === 'Z')).toHaveLength(1);
		}
		await mobile.pull();
		expect(mobile.tree().filter((p: string) => p.startsWith('Z')).sort()).toEqual(['Z/', 'Z/z1.md', 'Z/z2.md', 'Z/z3.md']);
		expect(mobile.ops()).toEqual({});
	});

	it('deletes done on Drive, uploads interrupted: the retry is not blocked and finishes', async () => {
		const { w, desktop } = await setup();
		await desktop.vault.delete(desktop.vault.getAbstractFileByPath('Inbox/a.md')!);
		await desktop.vault.delete(desktop.vault.getAbstractFileByPath('Inbox/b.md')!);
		for (let i = 1; i <= 4; i++) await desktop.vault.create(`n${i}.md`, 'new ' + i);
		await sleep(20);
		const back = dropAfter(1);
		await desktop.push();
		// the deletes happened, so they are no longer pending
		expect(Object.values(desktop.ops()).filter((o) => o === 'delete')).toEqual([]);
		back();

		await desktop.push();
		expect(text(), text()).not.toMatch(/could not identify/i);
		expect(text(), text()).toMatch(/Push complete/);
		expect(desktop.ops()).toEqual({});
		expect(noteCounts(w).has('Inbox/a.md')).toBe(false);
		expect(noteCounts(w).has('Inbox/b.md')).toBe(false);
		expect(duplicates(w)).toEqual([]);
	});

	it('a pending delete whose file is not known on Drive is dropped and Drive is left alone', async () => {
		const { w, desktop } = await setup();
		const before = JSON.stringify([...noteCounts(w)].sort());
		desktop.plugin.settings.operations['ghost.md'] = 'delete';
		await desktop.vault.create('real.md', 'real');
		await sleep(20);
		await desktop.push();
		expect(text(), text()).not.toMatch(/could not identify/i);
		expect(desktop.ops()).toEqual({});
		const after = new Map(noteCounts(w));
		after.delete('real.md');
		expect(JSON.stringify([...after].sort())).toBe(before);
	});

	it('Push interrupted while updating edited notes: the retry finishes, no duplicates', async () => {
		const { w, desktop } = await setup();
		for (const p of ['Inbox/a.md', 'Inbox/b.md', 'root.md', 'Archive/old.md']) {
			await desktop.vault.modify(desktop.vault.getFileByPath(p)!, 'edited ' + p);
		}
		await sleep(20);
		const back = dropAfter(2, /^(PATCH|POST) \/upload\/drive\/v3\/files\/[^/]+$/);
		await desktop.push();
		expect(Object.keys(desktop.ops()).length).toBe(2);
		back();
		await desktop.push();
		expect(desktop.ops()).toEqual({});
		expect(duplicates(w)).toEqual([]);
	});

	it('the connection drops only at the last step: the message says everything was uploaded, and a retry has nothing to do', async () => {
		const { w, desktop, mobile } = await setup();
		for (let i = 1; i <= 3; i++) await desktop.vault.create(`n${i}.md`, 'new ' + i);
		await sleep(20);
		const back = dropAfter(0, /^GET \/drive\/v3\/changes\/startPageToken$/);
		await desktop.push();
		expect(text(), text()).toMatch(/after everything was uploaded/);
		back();
		await desktop.push();
		expect(text(), text()).toMatch(/Nothing to push/);
		expect(duplicates(w)).toEqual([]);
		await mobile.pull();
		expect(mobile.tree()).toContain('n1.md');
	});

	it('Pull interrupted: the retry completes and leaves no false "deleted here" entries', async () => {
		const { w, desktop, mobile } = await setup();
		for (let i = 1; i <= 6; i++) await desktop.vault.create(`n${i}.md`, 'new ' + i);
		await sleep(20);
		await desktop.push();
		const back = dropAfter(3, /^GET \/drive\/v3\/files\/[^/]+$/);
		await mobile.pull();
		const partial = mobile.tree().filter((p: string) => /^n\d\.md$/.test(p)).length;
		expect(partial).toBeLessThan(6);
		back();

		await mobile.pull();
		expect(mobile.tree().filter((p: string) => /^n\d\.md$/.test(p))).toHaveLength(6);
		expect(mobile.ops()).toEqual({});
		await mobile.push();
		expect(text(), text()).toMatch(/Nothing to push/);
		for (let i = 1; i <= 6; i++) expect(noteCounts(w).get(`n${i}.md`)).toBe(1);
	});

	it('Push right after an interrupted Pull is still stopped and deletes nothing on Drive', async () => {
		const { w, desktop, mobile } = await setup();
		for (let i = 1; i <= 6; i++) await desktop.vault.create(`n${i}.md`, 'new ' + i);
		await sleep(20);
		await desktop.push();
		const back = dropAfter(3, /^GET \/drive\/v3\/files\/[^/]+$/);
		await mobile.pull();
		back();
		await mobile.push();
		expect(text(), text()).toMatch(/Push stopped/);
		// nothing of this device is pending, so "Push without pulling" has nothing to upload or delete
		await mobile.pushWithoutPull();
		expect(text(), text()).toMatch(/Nothing to push/);
		expect(mobile.ops()).toEqual({});
		for (let i = 1; i <= 6; i++) expect(noteCounts(w).get(`n${i}.md`)).toBe(1);
	});
});
