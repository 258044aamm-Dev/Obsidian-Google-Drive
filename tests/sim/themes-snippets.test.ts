/**
 * 3.7.0: themes and CSS snippets are synced (switchable, on by default) and a device that never
 * had a settings file can no longer delete it from Google Drive.
 */
import { describe, expect, it, vi } from 'vitest';
vi.stubGlobal('window', globalThis);
vi.mock('obsidian', async () => await import('./obsidian-mock'));
import { sleep } from './world';
import { setup } from './scenario-helpers';
import type { TFile } from './obsidian-mock';
import { listRestorePoints } from '../../helpers/history';
import { buildRestorePlan } from '../../helpers/history-restore';

const enc = (s: string) => new TextEncoder().encode(s).buffer;
const dec = (b: ArrayBuffer) => new TextDecoder().decode(b);

const put = async (d: any, path: string, text: string, mtime = Date.now()) => {
	await d.vault.adapter.mkdir(path.split('/').slice(0, -1).join('/'));
	await d.vault.adapter.writeBinary(path, enc(text), { mtime });
};
const read = async (d: any, path: string) =>
	(await d.vault.adapter.exists(path)) ? dec(await d.vault.adapter.readBinary(path)) : undefined;
const onDrive = (w: any) =>
	[...w.drive.files.values()]
		.filter((f: any) => !f.trashed && /^\.obsidian\/(themes|snippets|app\.json)/.test(w.drive.shown(f) ?? '') && f.mimeType !== 'application/vnd.google-apps.folder')
		.map((f: any) => w.drive.shown(f))
		.sort();
const edit = async (d: any, path: string, text: string) => {
	await d.vault.modify(d.vault.getFileByPath(path) as TFile, text);
	await sleep(20);
};

const THEME = '.obsidian/themes/Minimal/theme.css';
const THEME_MANIFEST = '.obsidian/themes/Minimal/manifest.json';
const SNIPPET = '.obsidian/snippets/wide.css';

const withFiles = async (settings: Record<string, unknown> = {}) => {
	const s = await setup();
	for (const d of [s.desktop, s.mobile]) Object.assign(d.plugin.settings, settings);
	await put(s.desktop, '.obsidian/app.json', '{"a":1}');
	await put(s.desktop, THEME, 'body{color:red}');
	await put(s.desktop, THEME_MANIFEST, '{"name":"Minimal"}');
	await put(s.desktop, '.obsidian/themes/Minimal/notes.txt', 'not synced');
	await put(s.desktop, SNIPPET, '.x{width:100%}');
	await put(s.desktop, '.obsidian/snippets/readme.txt', 'not css');
	await sleep(20);
	return s;
};

describe('themes and snippets are synced', () => {
	it('desktop to phone: theme files and snippets arrive, other files do not', async () => {
		const { w, desktop, mobile } = await withFiles();
		await desktop.push();
		expect(onDrive(w)).toEqual(['.obsidian/app.json', THEME_MANIFEST, THEME, SNIPPET].sort());
		await mobile.pull();
		expect(await read(mobile, THEME)).toBe('body{color:red}');
		expect(await read(mobile, THEME_MANIFEST)).toBe('{"name":"Minimal"}');
		expect(await read(mobile, SNIPPET)).toBe('.x{width:100%}');
		expect(await read(mobile, '.obsidian/themes/Minimal/notes.txt')).toBeUndefined();
		expect(await read(mobile, '.obsidian/snippets/readme.txt')).toBeUndefined();
	});

	it('old files (older than the last sync) are uploaded the first time', async () => {
		const { w, desktop } = await withFiles();
		const old = Date.now() - 10 * 24 * 3600 * 1000;
		await put(desktop, THEME, 'body{color:red}', old);
		await put(desktop, SNIPPET, '.x{width:100%}', old);
		await desktop.push();
		expect(onDrive(w)).toContain(THEME);
		expect(onDrive(w)).toContain(SNIPPET);
	});

	it('an unchanged theme is not uploaded again, a changed one is', async () => {
		const { w, desktop } = await withFiles();
		await desktop.push();
		const revisions = () => [...w.drive.files.values()].filter((f: any) => w.drive.shown(f) === SNIPPET).map((f: any) => f.revisions.length);
		const first = revisions();
		await edit(desktop, 'Inbox/a.md', 'note edit');
		await desktop.push();
		expect(revisions()).toEqual(first);
		await sleep(20);
		await put(desktop, SNIPPET, '.x{width:50%}');
		await edit(desktop, 'Inbox/a.md', 'note edit 2');
		await desktop.push();
		expect(revisions()[0]).toBeGreaterThan(first[0] as number);
	});

	it('a changed snippet reaches the phone', async () => {
		const { desktop, mobile } = await withFiles();
		await desktop.push();
		await mobile.pull();
		await sleep(20);
		await put(desktop, SNIPPET, '.x{width:50%}');
		await edit(desktop, 'Inbox/a.md', 'note edit');
		await desktop.push();
		await mobile.pull();
		expect(await read(mobile, SNIPPET)).toBe('.x{width:50%}');
	});

	it('a snippet deleted on the desktop is deleted on the phone', async () => {
		const { w, desktop, mobile } = await withFiles();
		await desktop.push();
		await mobile.pull();
		await sleep(20);
		await desktop.vault.adapter.remove(SNIPPET);
		await edit(desktop, 'Inbox/a.md', 'note edit');
		await desktop.push();
		expect(onDrive(w)).not.toContain(SNIPPET);
		await mobile.pull();
		expect(await read(mobile, SNIPPET)).toBeUndefined();
	});
});

describe('a device that never had a settings file does not delete it from Drive', () => {
	it('a file the phone never had stays on Drive after a Push from the phone', async () => {
		const { w, desktop, mobile } = await setup();
		await put(desktop, THEME, 'body{color:red}');
		await put(desktop, SNIPPET, '.x{}');
		await sleep(20);
		await desktop.push();
		expect(onDrive(w)).toContain(THEME);
		// the phone joined earlier and has never pulled these two files
		await edit(mobile, 'Inbox/b.md', 'phone note edit');
		await mobile.pushWithoutPull();
		expect(onDrive(w)).toContain(THEME);
		expect(onDrive(w)).toContain(SNIPPET);
	});

	it('a phone that knows the Drive files but never had them (ids known, no baseline) does not delete them when the switch is turned on', async () => {
		const { w, desktop, mobile } = await withFiles();
		Object.assign(mobile.plugin.settings, { syncThemes: false, syncSnippets: false });
		await desktop.push();
		await mobile.pull(); // learns the Drive files, downloads none of them
		expect(await read(mobile, THEME)).toBeUndefined();
		// the phone knows the Drive ids of the files (as after a sync done by another version) but has no copy
		for (const [id, path] of Object.entries(desktop.plugin.settings.driveIdToPath as Record<string, string>))
			if (path.startsWith('.obsidian/themes') || path.startsWith('.obsidian/snippets')) mobile.plugin.settings.driveIdToPath[id] = path;
		expect(Object.values(mobile.plugin.settings.driveIdToPath)).toContain(THEME);
		Object.assign(mobile.plugin.settings, { syncThemes: true, syncSnippets: true });
		await edit(mobile, 'Inbox/b.md', 'phone note edit');
		await mobile.pushWithoutPull();
		expect(onDrive(w)).toContain(THEME);
		expect(onDrive(w)).toContain(THEME_MANIFEST);
		expect(onDrive(w)).toContain(SNIPPET);
	});

	it('an upgraded device (files known on Drive, no remembered state) gets deletions passed on after its first sync', async () => {
		const { w, desktop, mobile } = await withFiles();
		await desktop.push();
		await mobile.pull();
		await sleep(20);
		mobile.plugin.settings.syncedFiles = {}; // as if the device had been updated from an older version
		await edit(mobile, 'Inbox/b.md', 'phone note edit');
		await mobile.pull(); // a successful sync seeds the remembered state
		expect(Object.keys(mobile.plugin.settings.syncedFiles)).toContain(SNIPPET);
		await mobile.vault.adapter.remove(SNIPPET);
		await edit(mobile, 'Inbox/b.md', 'phone note edit 2');
		await mobile.push();
		expect(onDrive(w)).not.toContain(SNIPPET);
	});

	it('a file the phone had and deleted is removed from Drive', async () => {
		const { w, desktop, mobile } = await withFiles();
		await desktop.push();
		await mobile.pull();
		await sleep(20);
		await mobile.vault.adapter.remove(SNIPPET);
		await edit(mobile, 'Inbox/b.md', 'phone note edit');
		await mobile.push();
		expect(onDrive(w)).not.toContain(SNIPPET);
		expect(onDrive(w)).toContain(THEME);
	});
});

describe('the switches', () => {
	it('themes off: not uploaded and not pulled; snippets still are', async () => {
		const { w, desktop, mobile } = await withFiles({ syncThemes: false });
		await desktop.push();
		expect(onDrive(w)).not.toContain(THEME);
		expect(onDrive(w)).toContain(SNIPPET);
		await mobile.pull();
		expect(await read(mobile, THEME)).toBeUndefined();
		expect(await read(mobile, SNIPPET)).toBe('.x{width:100%}');
	});

	it('snippets off: not uploaded and not pulled; themes still are', async () => {
		const { w, desktop, mobile } = await withFiles({ syncSnippets: false });
		await desktop.push();
		expect(onDrive(w)).not.toContain(SNIPPET);
		expect(onDrive(w)).toContain(THEME);
		await mobile.pull();
		expect(await read(mobile, SNIPPET)).toBeUndefined();
		expect(await read(mobile, THEME)).toBe('body{color:red}');
	});

	it('settings files off: app.json is neither uploaded nor pulled; themes still sync', async () => {
		const { w, desktop, mobile } = await withFiles({ syncConfigFiles: false });
		await desktop.push();
		expect(onDrive(w)).not.toContain('.obsidian/app.json');
		expect(onDrive(w)).toContain(THEME);
		await mobile.pull();
		expect(await read(mobile, '.obsidian/app.json')).toBeUndefined();
		expect(await read(mobile, THEME)).toBe('body{color:red}');
	});

	it('off on the phone only: the desktop keeps syncing them, the phone does not pull them', async () => {
		const { w, desktop, mobile } = await withFiles();
		Object.assign(mobile.plugin.settings, { syncThemes: false, syncSnippets: false, syncConfigFiles: false });
		await desktop.push();
		expect(onDrive(w)).toContain(THEME);
		await mobile.pull();
		expect(await read(mobile, THEME)).toBeUndefined();
		expect(await read(mobile, SNIPPET)).toBeUndefined();
		expect(await read(mobile, '.obsidian/app.json')).toBeUndefined();
		// and the phone's own Push does not touch them on Drive
		await edit(mobile, 'Inbox/b.md', 'phone note edit');
		await mobile.pushWithoutPull();
		expect(onDrive(w)).toEqual(['.obsidian/app.json', THEME_MANIFEST, THEME, SNIPPET].sort());
	});

	it('everything off: nothing from the configuration folder travels', async () => {
		const { w, desktop, mobile } = await withFiles({ syncConfigFiles: false, syncThemes: false, syncSnippets: false });
		await desktop.push();
		expect(onDrive(w)).toEqual([]);
		await mobile.pull();
		expect(await read(mobile, THEME)).toBeUndefined();
	});

	it('switching a category off later deletes nothing on Drive, nor on the other device', async () => {
		const { w, desktop, mobile } = await withFiles();
		await desktop.push();
		await mobile.pull();
		await sleep(20);
		const before = onDrive(w);
		for (const d of [desktop, mobile]) Object.assign(d.plugin.settings, { syncThemes: false, syncSnippets: false });
		await desktop.vault.adapter.remove(THEME); // while off, a local deletion is not passed on
		await edit(desktop, 'Inbox/a.md', 'note edit');
		await desktop.push();
		expect(onDrive(w)).toEqual(before);
		await mobile.pull();
		expect(await read(mobile, THEME)).toBe('body{color:red}');
	});

	it('a Drive deletion of a switched-off category is not applied locally', async () => {
		const { w, desktop, mobile } = await withFiles();
		await desktop.push();
		await mobile.pull();
		await sleep(20);
		await desktop.vault.adapter.remove(SNIPPET);
		await edit(desktop, 'Inbox/a.md', 'note edit');
		await desktop.push();
		expect(onDrive(w)).not.toContain(SNIPPET);
		Object.assign(mobile.plugin.settings, { syncSnippets: false });
		await mobile.pull();
		expect(await read(mobile, SNIPPET)).toBe('.x{width:100%}');
	});

	it('the switches default to on when the settings do not mention them', async () => {
		const { mobile } = await setup();
		expect(mobile.plugin.settings.syncThemes).toBeUndefined();
		const { isConfigPathSynced } = await import('../../helpers/config-scope');
		expect(isConfigPathSynced(mobile.plugin, THEME)).toBe(true);
		expect(isConfigPathSynced(mobile.plugin, SNIPPET)).toBe(true);
		expect(isConfigPathSynced(mobile.plugin, '.obsidian/app.json')).toBe(true);
		expect(isConfigPathSynced(mobile.plugin, 'Inbox/a.md')).toBe(true);
	});
});

describe('version history and the switches', () => {
	it('a restore plan includes themes and snippets only while their switches are on', async () => {
		const { desktop } = await withFiles({ historyEnabled: true });
		await desktop.push();
		await sleep(20);
		await put(desktop, THEME, 'body{color:blue}');
		await put(desktop, SNIPPET, '.x{width:1%}');
		await edit(desktop, 'Inbox/a.md', 'note edit');
		await desktop.push();
		const points = [...(await listRestorePoints(desktop.plugin))].sort((a, b) => a.createdAt - b.createdAt);
		const paths = async () => {
			const { plan } = await buildRestorePlan(desktop.plugin, points[1]!, true);
			return [...plan.revert, ...plan.recreate].map((i) => i.path);
		};
		expect(await paths()).toEqual(expect.arrayContaining([THEME, SNIPPET]));
		Object.assign(desktop.plugin.settings, { syncThemes: false });
		const without = await paths();
		expect(without).toContain(SNIPPET);
		expect(without).not.toContain(THEME);
	});
});
