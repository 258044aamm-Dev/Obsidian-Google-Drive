/**
 * Upstream issue #55: config and plugin files that one device pulled were marked as "changed on
 * this device" and uploaded again by its next Push, which made two devices re-upload the same
 * files to each other forever. A file a sync downloaded is not a local change.
 */
import { describe, expect, it, vi } from 'vitest';
vi.stubGlobal('window', globalThis);
vi.mock('obsidian', async () => await import('./obsidian-mock'));
import { sleep } from './world';
import { setup } from './scenario-helpers';
import type { TFile } from './obsidian-mock';

const enc = (s: string) => new TextEncoder().encode(s).buffer;

const driveConfigRevisions = (w: any) =>
	Object.fromEntries(
		[...w.drive.files.values()]
			.filter((f: any) => !f.trashed && f.revisions.length && /^\.obsidian\/(app\.json|plugins\/foo\/)/.test(w.drive.shown(f) ?? ''))
			.map((f: any) => [w.drive.shown(f), f.revisions.length]),
	);

const newSetup = async () => {
	const s = await setup();
	// A real disk needs a few ms to read a file: the rewrite in endSync lands after its timestamp.
	for (const d of [s.desktop, s.mobile]) {
		const a: any = d.vault.adapter;
		const read = a.readBinary;
		a.readBinary = async (p: string) => {
			await sleep(4);
			return read(p);
		};
	}
	const put = async (d: any, path: string, text: string) => {
		await d.vault.adapter.mkdir(path.split('/').slice(0, -1).join('/'));
		await d.vault.adapter.writeBinary(path, enc(text), { mtime: Date.now() });
	};
	const edit = async (d: any, path: string, text: string) => {
		await d.vault.modify(d.vault.getFileByPath(path) as TFile, text);
		await sleep(20);
	};
	await put(s.desktop, '.obsidian/app.json', '{"a":1}');
	await put(s.desktop, '.obsidian/plugins/foo/main.js', 'console.log(1)');
	await put(s.desktop, '.obsidian/plugins/foo/manifest.json', '{"id":"foo"}');
	await sleep(20);
	await s.desktop.push();
	return { ...s, put, edit };
};

describe('config files that were pulled are not uploaded again (#55)', () => {
	it('keeps every config file at one Drive revision while two devices pull and push notes', async () => {
		const { w, desktop, mobile, edit } = await newSetup();
		const first = driveConfigRevisions(w);
		expect(Object.keys(first).length).toBe(3);
		expect(Object.values(first)).toEqual([1, 1, 1]);

		await mobile.pull();
		await sleep(20);
		await edit(mobile, 'Inbox/a.md', 'note edit on mobile');
		await mobile.push();
		await desktop.pull();
		await sleep(20);
		await edit(desktop, 'Inbox/b.md', 'note edit on desktop');
		await desktop.push();
		await mobile.pull();
		await sleep(20);
		await edit(mobile, 'Inbox/a.md', 'again');
		await mobile.push();

		expect(driveConfigRevisions(w)).toEqual(first);
	});

	it('the device that pulled them has no config files waiting to be pushed', async () => {
		const { mobile } = await newSetup();
		await mobile.pull();
		await sleep(20);
		expect(await mobile.plugin.drive.getConfigFilesToSync()).toEqual([]);
	});

	it('still pushes a config file that was changed on this device and not pushed yet', async () => {
		const { w, desktop, mobile, put, edit } = await newSetup();
		await mobile.pull();
		await sleep(20);
		await put(mobile, '.obsidian/app.json', '{"a":2}'); // own change on the phone
		await sleep(20);
		await edit(desktop, 'Inbox/b.md', 'note edit on desktop');
		await desktop.push();
		await mobile.pull(); // a Pull must not make the phone forget its own change
		await sleep(20);
		expect(await mobile.plugin.drive.getConfigFilesToSync()).toEqual(['.obsidian/app.json']);
		await edit(mobile, 'Inbox/a.md', 'x');
		await mobile.push();
		const revs = driveConfigRevisions(w);
		expect(revs['.obsidian/app.json']).toBe(2);
		expect(revs['.obsidian/plugins/foo/main.js']).toBe(1);
		expect(revs['.obsidian/plugins/foo/manifest.json']).toBe(1);
	});
});
