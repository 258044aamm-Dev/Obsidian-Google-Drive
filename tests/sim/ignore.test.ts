/**
 * 3.10.0: the ignore list. An ignored path is invisible to sync: never uploaded, never deleted on
 * Drive, never pulled, never counted, never a conflict.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.stubGlobal('window', globalThis);
vi.mock('obsidian', async () => await import('./obsidian-mock'));
import { sleep } from './world';
import { setup, simDefaults, simE2ee, ROOT } from './scenario-helpers';

const edit = async (d: any, path: string, text: string) => {
	await d.vault.modify(d.vault.getFileByPath(path), text);
	await sleep(20);
};
const text = async (d: any, path: string) => {
	const file = d.vault.getFileByPath(path);
	return file ? await d.vault.read(file) : undefined;
};
/** What Drive holds for a path (decrypted in the end-to-end suite), or undefined. */
const onDrive = async (w: any, path: string) => {
	const f = [...w.drive.files.values()].find((x: any) => !x.trashed && w.drive.shown(x) === path && x.content);
	return f ? new TextDecoder().decode(await w.drive.contentOf(f)) : undefined;
};
const ignore = (d: any, list: string) => {
	d.plugin.settings.ignorePatterns = list;
};
const copies = (d: any) => d.vault.tree().filter((p: string) => p.includes('(Drive'));

beforeEach(() => {
	simDefaults.deleteToTrash = true;
});

describe('Push', () => {
	it('does not record or upload an ignored file, and still uploads the others', async () => {
		const { w, desktop } = await setup();
		ignore(desktop, 'Inbox/a.md');
		await edit(desktop, 'Inbox/a.md', 'a2');
		await edit(desktop, 'Inbox/b.md', 'b2');
		expect(Object.keys(desktop.ops())).toEqual(['Inbox/b.md']);
		await desktop.push();
		expect(await onDrive(w, 'Inbox/a.md')).toBe('a');
		expect(await onDrive(w, 'Inbox/b.md')).toBe('b2');
	});

	it('drops a mark that was recorded before the pattern was added', async () => {
		const { w, desktop } = await setup();
		await edit(desktop, 'Inbox/a.md', 'a2');
		expect(desktop.ops()['Inbox/a.md']).toBe('modify');
		ignore(desktop, 'a.md'); // no sweep: Push has to notice by itself
		await desktop.push();
		expect(await onDrive(w, 'Inbox/a.md')).toBe('a');
		expect(desktop.ops()).toEqual({});
	});

	it('the sweep for a new list leaves the files alone and reports how many marks it dropped', async () => {
		const { desktop } = await setup();
		const { dropIgnoredMarks } = await import(ROOT + '/helpers/ignore.ts');
		await edit(desktop, 'Inbox/a.md', 'a2');
		await edit(desktop, 'root.md', 'r2');
		ignore(desktop, 'Inbox/');
		expect(dropIgnoredMarks(desktop.plugin)).toBe(1);
		expect(desktop.ops()).toEqual({ 'root.md': 'modify' });
		expect(await text(desktop, 'Inbox/a.md')).toBe('a2');
	});

	it('a file created in an ignored folder is not uploaded', async () => {
		const { w, desktop } = await setup();
		ignore(desktop, 'Archive/');
		await desktop.vault.create('Archive/new.md', 'new');
		await desktop.vault.create('Inbox/c.md', 'c');
		await sleep(20);
		expect(Object.keys(desktop.ops())).toEqual(['Inbox/c.md']); // nothing recorded for the ignored folder
		await desktop.push();
		expect(await onDrive(w, 'Archive/new.md')).toBeUndefined();
		expect(await onDrive(w, 'Inbox/c.md')).toBe('c');
		expect(await text(desktop, 'Archive/new.md')).toBe('new');
	});

	it('a missed edit of an ignored file is neither found nor uploaded (the doctor does not list it either)', async () => {
		const { w, desktop } = await setup();
		const { unrecordedEditCandidates } = await import(ROOT + '/helpers/missed-edits.ts');
		await desktop.vault.modify(desktop.vault.getFileByPath('Inbox/a.md')!, 'lost');
		await desktop.vault.modify(desktop.vault.getFileByPath('Inbox/b.md')!, 'lost too');
		await sleep(20);
		delete desktop.plugin.settings.operations['Inbox/a.md']; // the events were "missed"
		delete desktop.plugin.settings.operations['Inbox/b.md'];
		ignore(desktop, 'a.md');
		expect(unrecordedEditCandidates(desktop.plugin)).toEqual(['Inbox/b.md']);
		await desktop.push();
		expect(await onDrive(w, 'Inbox/a.md')).toBe('a');
		expect(await onDrive(w, 'Inbox/b.md')).toBe('lost too');
	});

	it('deleting an ignored file here leaves its copy on Drive', async () => {
		const { w, desktop, mobile } = await setup();
		ignore(mobile, 'b.md');
		await mobile.vault.delete(mobile.vault.getFileByPath('Inbox/b.md')!);
		await sleep(20);
		expect(mobile.ops()).toEqual({});
		await mobile.push();
		expect(await onDrive(w, 'Inbox/b.md')).toBe('b');
		await desktop.pull();
		expect(await text(desktop, 'Inbox/b.md')).toBe('b');
	});

	it('is not stopped by a Drive change to an ignored file (no collision)', async () => {
		const { w, desktop, mobile } = await setup();
		ignore(mobile, 'plan.md');
		await edit(mobile, 'Projects/Alpha/plan.md', 'mine');
		await edit(desktop, 'Projects/Alpha/plan.md', 'theirs');
		await desktop.push();
		await edit(mobile, 'root.md', 'r2');
		await mobile.push();
		expect(await onDrive(w, 'Projects/Alpha/plan.md')).toBe('theirs');
		expect(await onDrive(w, 'root.md')).toBe('r2');
		expect(copies(mobile)).toEqual([]);
		expect(await text(mobile, 'Projects/Alpha/plan.md')).toBe('mine');
	});

	it('the same Push IS stopped for a file that is not ignored (the guard is unchanged)', async () => {
		const { desktop, mobile } = await setup();
		await edit(mobile, 'Projects/Alpha/plan.md', 'mine');
		await edit(desktop, 'Projects/Alpha/plan.md', 'theirs');
		await desktop.push();
		await edit(mobile, 'root.md', 'r2');
		await mobile.push();
		expect(mobile.ops()['root.md']).toBe('modify'); // not uploaded: the push was blocked
	});
});

describe('Pull', () => {
	it('does not pull an ignored file, makes no copy, and still pulls the others', async () => {
		const { desktop, mobile } = await setup();
		ignore(mobile, 'a.md');
		await edit(mobile, 'Inbox/a.md', 'mine');
		await edit(desktop, 'Inbox/a.md', 'theirs');
		await edit(desktop, 'Inbox/b.md', 'b2');
		await desktop.push();
		await mobile.pull();
		expect(await text(mobile, 'Inbox/a.md')).toBe('mine');
		expect(await text(mobile, 'Inbox/b.md')).toBe('b2');
		expect(copies(mobile)).toEqual([]);
		expect(mobile.ops()).toEqual({});
	});

	it('does not apply a Drive deletion to an ignored file', async () => {
		const { desktop, mobile } = await setup();
		ignore(mobile, 'b.md');
		await desktop.vault.delete(desktop.vault.getFileByPath('Inbox/b.md')!);
		await desktop.vault.delete(desktop.vault.getFileByPath('Inbox/a.md')!);
		await sleep(20);
		await desktop.push();
		await mobile.pull();
		expect(await text(mobile, 'Inbox/b.md')).toBe('b');
		expect(await text(mobile, 'Inbox/a.md')).toBeUndefined();
		expect(mobile.ops()).toEqual({});
	});

	it('does not delete an ignored file inside a folder that Drive removed, and keeps its folder', async () => {
		const { desktop, mobile } = await setup();
		ignore(mobile, 'readme.md');
		await desktop.vault.delete(desktop.vault.getFolderByPath('Projects/Beta')!);
		await sleep(20);
		await desktop.push();
		await mobile.pull();
		expect(await text(mobile, 'Projects/Beta/readme.md')).toBe('beta');
	});

	it('a Drive file that is ignored here is not created here', async () => {
		const { desktop, mobile } = await setup();
		ignore(mobile, '*.tmp');
		await desktop.vault.create('Inbox/x.tmp', 'x');
		await desktop.vault.create('Inbox/y.md', 'y');
		await sleep(20);
		await desktop.push();
		await mobile.pull();
		expect(await text(mobile, 'Inbox/x.tmp')).toBeUndefined();
		expect(await text(mobile, 'Inbox/y.md')).toBe('y');
		expect(mobile.ops()).toEqual({});
	});
});

describe('the Pull badge', () => {
	it('does not count Drive changes to ignored files', async () => {
		const { desktop, mobile } = await setup();
		const { countWaitingOnDrive } = await import(ROOT + '/helpers/badge.ts');
		ignore(mobile, 'Inbox/');
		await edit(desktop, 'Inbox/a.md', 'a2');
		await edit(desktop, 'Inbox/b.md', 'b2');
		await edit(desktop, 'root.md', 'r2');
		await desktop.push();
		expect(await countWaitingOnDrive(mobile.plugin)).toBe(1);
	});
});

describe('changing the list', () => {
	it('removing a pattern uploads what was edited while it was ignored', async () => {
		const { w, desktop } = await setup();
		ignore(desktop, 'a.md');
		await edit(desktop, 'Inbox/a.md', 'a2');
		await desktop.push();
		expect(await onDrive(w, 'Inbox/a.md')).toBe('a');
		ignore(desktop, '');
		await desktop.push();
		expect(await onDrive(w, 'Inbox/a.md')).toBe('a2');
	});

	it('renaming a file out of the ignored set uploads it', async () => {
		const { w, desktop } = await setup();
		ignore(desktop, '*.tmp');
		await desktop.vault.create('Inbox/x.tmp', 'x');
		await sleep(20);
		await desktop.vault.rename(desktop.vault.getFileByPath('Inbox/x.tmp')!, 'Inbox/x.md');
		await sleep(20);
		await desktop.push();
		expect(await onDrive(w, 'Inbox/x.md')).toBe('x');
		expect(await onDrive(w, 'Inbox/x.tmp')).toBeUndefined();
	});

	it('renaming a synced file into the ignored set removes the old name from Drive and keeps the file here', async () => {
		const { w, desktop } = await setup();
		ignore(desktop, '*.tmp');
		await desktop.vault.rename(desktop.vault.getFileByPath('Inbox/a.md')!, 'Inbox/a.tmp');
		await sleep(20);
		await desktop.push();
		expect(await onDrive(w, 'Inbox/a.md')).toBeUndefined();
		expect(await onDrive(w, 'Inbox/a.tmp')).toBeUndefined();
		expect(await text(desktop, 'Inbox/a.tmp')).toBe('a');
	});
});

describe('no list', () => {
	it('behaves exactly as before', async () => {
		const { w, desktop, mobile } = await setup();
		await edit(desktop, 'Inbox/a.md', 'a2');
		await desktop.push();
		await mobile.pull();
		expect(await text(mobile, 'Inbox/a.md')).toBe('a2');
		expect(await onDrive(w, 'Inbox/a.md')).toBe('a2');
	});
});

describe('switching on encryption', () => {
	it.skipIf(simE2ee.on)('does not queue ignored files for upload to the new encrypted vault', async () => {
		const { desktop } = await setup();
		(await import(ROOT + '/helpers/crypto.ts')).kdf.iterations = 1000;
		const { enableEncryption } = await import(ROOT + '/helpers/e2ee.ts');
		ignore(desktop, 'Archive/');
		expect(await enableEncryption(desktop.plugin, 'a long enough passphrase', 'a long enough passphrase')).toBe('created');
		const queued = Object.keys(desktop.ops());
		expect(queued).toContain('Inbox/a.md');
		expect(queued.filter((p) => p.startsWith('Archive'))).toEqual([]);
	});
});
