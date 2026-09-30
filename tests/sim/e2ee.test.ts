/**
 * End-to-end encryption, two devices against the fake Drive. What the server stores, what happens when it
 * misbehaves (changed, swapped, stale), a wrong or missing key, and switching encryption on and off.
 * (The whole regression suite also runs with encryption on: see tests/sim/regression.test.ts.)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.stubGlobal('window', globalThis);
vi.mock('obsidian', async () => await import('./obsidian-mock'));
import { sleep, notices, netLog, enc, dec } from './world';
import { setup, simDefaults, simE2ee, same, ROOT } from './scenario-helpers';

const FOLDER = 'application/vnd.google-apps.folder';
const PASS = simE2ee.passphrase;
const e2eeModule = () => import(ROOT + '/helpers/e2ee.ts');
const cryptoModule = () => import(ROOT + '/helpers/crypto.ts');

const driveFiles = (w: any) => [...w.drive.files.values()].filter((f: any) => !f.trashed && f.id !== w.drive.rootId && f.properties.obsidian !== 'vault');
const byPath = (w: any, path: string) => driveFiles(w).find((f: any) => w.drive.shown(f) === path && f.mimeType !== FOLDER) as any;
const flip = (bytes: Uint8Array, at: number) => {
	const copy = bytes.slice();
	copy[at] = copy[at]! ^ 1;
	return copy;
};

beforeEach(() => {
	simE2ee.on = true;
	Object.assign(simDefaults, { deleteToTrash: true, historyEnabled: true });
});

describe('what Drive stores', () => {
	it('has no readable file names, folder names, paths or contents', async () => {
		const { w, desktop } = await setup();
		await desktop.vault.create('Inbox/secret-plan.md', 'TOP SECRET CONTENT 12345');
		await desktop.vault.createFolder('日本語');
		await desktop.vault.create('日本語/ノート ✨.md', 'TOP SECRET CONTENT 67890');
		await sleep(20);
		await desktop.push();
		expect(byPath(w, 'Inbox/secret-plan.md')).toBeTruthy();

		const words = ['Inbox', 'Projects', 'Alpha', 'Beta', 'Archive', 'Journal', 'secret-plan', 'readme', 'old.md', 'root.md', '日本語', 'ノート', 'TOP SECRET'];
		const latin = (b: Uint8Array) => Buffer.from(b).toString('latin1');
		let checked = 0;
		for (const f of driveFiles(w) as any[]) {
			const seen = JSON.stringify([f.name, f.properties, f.description]) + (f.content ? latin(f.content) : '');
			for (const word of words) expect(seen, `${f.name} / ${word}`).not.toContain(Buffer.from(word).toString('latin1'));
			for (const word of words) expect(seen).not.toContain(word);
			if (f.mimeType !== FOLDER) expect(f.mimeType).toBe('application/octet-stream');
			for (const rev of f.revisions ?? []) for (const word of words) expect(latin(rev.content ?? new Uint8Array())).not.toContain(word);
			if (!f.properties.history) expect(f.name).toBe(f.properties.path); // the name IS the path id
			checked++;
		}
		expect(checked).toBeGreaterThan(15); // files, folders and restore points
		// the plain Drive vault next to it was left alone
		expect([...w.drive.files.values()].filter((f: any) => f.parents.includes(w.drive.rootId))).toHaveLength(0);
	});

	it('writes the same file with a different ciphertext every time and stores the vault header on the root', async () => {
		const { w, desktop } = await setup();
		const before = byPath(w, 'Inbox/a.md').content as Uint8Array;
		await desktop.vault.modify(desktop.vault.getAbstractFileByPath('Inbox/a.md')!, 'a');
		await sleep(20);
		await desktop.push();
		const after = byPath(w, 'Inbox/a.md').content as Uint8Array;
		expect(Buffer.from(after).equals(Buffer.from(before))).toBe(false);
		const root = [...w.drive.files.values()].find((f: any) => f.properties.e2ee === '1') as any;
		expect(root.name).toBe('Encrypted Obsidian vault');
		expect(root.properties.hw).toBeTruthy();
		expect(JSON.stringify(root.properties)).not.toContain(PASS);
	});
});

describe('sync works and converges', () => {
	it('edits, renames, deletes, Unicode and very long paths reach the other device', async () => {
		const { w, desktop, mobile } = await setup();
		const v = desktop.vault;
		const longName = 'folder with a long name/'.repeat(12) + 'note ✨ ノート.md';
		await v.createFolder('日本語');
		await v.create('日本語/ノート ✨.md', 'こんにちは');
		await v.createFolder(longName.split('/').slice(0, -1).join('/')).catch(() => undefined);
		await v.create(longName, 'deep');
		await v.modify(v.getAbstractFileByPath('Inbox/a.md')!, 'edited a');
		await v.delete(v.getAbstractFileByPath('Archive/old.md')!);
		await sleep(20);
		await desktop.push();
		await mobile.pull();
		expect(same(desktop.tree(), mobile.tree())).toBe('IDENTICAL');
		expect(dec(mobile.vault.disk.get('Inbox/a.md')!.data as any)).toBe('edited a');
		expect(dec(mobile.vault.disk.get('日本語/ノート ✨.md')!.data as any)).toBe('こんにちは');
		expect(dec(mobile.vault.disk.get(longName)!.data as any)).toBe('deep');
		expect(same(mobile.tree(), w.drive.snapshotNonConfig())).toBe('IDENTICAL');
		expect(mobile.ops()).toEqual({});
	});

	it('the phone can push too, and a restart keeps the key', async () => {
		const { desktop, mobile } = await setup();
		await mobile.vault.create('Inbox/from-phone.md', 'hi from the phone');
		await sleep(20);
		await mobile.push();
		await desktop.start({ startupPull: false });
		expect(desktop.plugin.e2ee).toBeTruthy();
		await desktop.pull();
		expect(dec(desktop.vault.disk.get('Inbox/from-phone.md')!.data as any)).toBe('hi from the phone');
	});
});

describe('a server (or anyone with the Drive account) that changes things', () => {
	const edited = async () => {
		const s = await setup();
		const v = s.desktop.vault;
		await v.modify(v.getAbstractFileByPath('Inbox/a.md')!, 'NEW a');
		await v.modify(v.getAbstractFileByPath('Inbox/b.md')!, 'NEW b');
		await sleep(20);
		await s.desktop.push();
		return s;
	};

	it('a changed byte: that file is not written, the rest of the pull still completes', async () => {
		const { w, mobile } = await edited();
		const a = byPath(w, 'Inbox/a.md');
		a.content = flip(a.content, a.content.length - 3);
		await mobile.pull();
		expect(dec(mobile.vault.disk.get('Inbox/a.md')!.data as any)).toBe('a'); // untouched
		expect(dec(mobile.vault.disk.get('Inbox/b.md')!.data as any)).toBe('NEW b');
		expect(notices.join('\n')).toMatch(/integrity check/i);
	});

	it('the refused file arrives on the next Pull once Drive holds a good copy again', async () => {
		const { w, desktop, mobile } = await edited();
		const a = byPath(w, 'Inbox/a.md');
		const good = a.content as Uint8Array;
		a.content = flip(good, good.length - 3);
		await mobile.pull();
		expect(dec(mobile.vault.disk.get('Inbox/a.md')!.data as any)).toBe('a');
		a.content = good; // e.g. the owner restored it from Drive's version history
		await mobile.pull();
		expect(dec(mobile.vault.disk.get('Inbox/a.md')!.data as any)).toBe('NEW a');
		expect(same(mobile.tree(), desktop.tree())).toBe('IDENTICAL');
	});

	it('two files swapped on Drive: neither is written with the other one\'s content', async () => {
		const { w, mobile } = await edited();
		const a = byPath(w, 'Inbox/a.md');
		const b = byPath(w, 'Inbox/b.md');
		[a.content, b.content] = [b.content, a.content];
		await mobile.pull();
		expect(dec(mobile.vault.disk.get('Inbox/a.md')!.data as any)).toBe('a');
		expect(dec(mobile.vault.disk.get('Inbox/b.md')!.data as any)).toBe('b');
	});

	it('names/paths swapped on Drive (content stays): refused too', async () => {
		const { w, mobile } = await edited();
		const a = byPath(w, 'Inbox/a.md');
		const b = byPath(w, 'Inbox/b.md');
		[a.properties, b.properties] = [b.properties, a.properties];
		[a.name, b.name] = [b.name, a.name];
		await mobile.pull();
		expect(dec(mobile.vault.disk.get('Inbox/a.md')!.data as any)).toBe('a');
		expect(dec(mobile.vault.disk.get('Inbox/b.md')!.data as any)).toBe('b');
	});

	it('an unencrypted file put into the encrypted vault is never pulled', async () => {
		const { w, mobile } = await setup();
		const folder = [...w.drive.files.values()].find((f: any) => f.mimeType === FOLDER && w.drive.shown(f) === 'Inbox') as any;
		const tag = byPath(w, 'Inbox/a.md').properties.vault;
		w.drive.add({
			name: 'planted',
			parents: [folder.id],
			content: new Uint8Array(enc('i am plain text')),
			properties: { vault: tag, path: 'Inbox/planted.md' },
		});
		await mobile.pull();
		expect(mobile.vault.disk.has('Inbox/planted.md')).toBe(false);
	});

	it('a damaged listing entry stops the whole listing instead of guessing', async () => {
		const { w, desktop, mobile } = await setup();
		await desktop.vault.create('Inbox/new.md', 'new');
		await sleep(20);
		await desktop.push();
		const f = byPath(w, 'Inbox/new.md');
		f.properties = { ...f.properties, e1: f.properties.e1.slice(0, -3) + 'AAA' };
		await mobile.pull();
		expect(mobile.vault.disk.has('Inbox/new.md')).toBe(false);
		expect(notices.join('\n')).toMatch(/encrypt|damaged|foreign/i);
	});
});

describe('passphrase and key handling', () => {
	it('a wrong passphrase cannot join and changes nothing on the device or on Drive', async () => {
		const { w } = await setup();
		const { enableEncryption } = await e2eeModule();
		const third = w.device('third');
		await third.start({ startupPull: false });
		const driveBefore = w.drive.files.size;
		await expect(enableEncryption(third.plugin, 'not the right passphrase')).rejects.toThrow(/wrong passphrase/i);
		expect(third.plugin.settings.e2eeEnabled).toBe(false);
		expect(third.plugin.settings.rootFolderId).toBe('');
		expect(third.plugin.e2ee).toBeUndefined();
		expect(w.drive.files.size).toBe(driveBefore);
		expect(await enableEncryption(third.plugin, PASS)).toBe('joined');
		await third.pull();
		expect(third.tree()).toContain('Inbox/a.md');
	});

	it('a weak passphrase is refused before anything is created', async () => {
		const { World } = await import('./world');
		const w = new World(ROOT, '3.6.0');
		const d = w.device('d');
		await d.start({ startupPull: false });
		const { enableEncryption } = await e2eeModule();
		const before = w.drive.files.size;
		await expect(enableEncryption(d.plugin, 'short')).rejects.toThrow(/12/);
		expect(w.drive.files.size).toBe(before);
		expect(d.plugin.settings.e2eeEnabled).toBe(false);
	});

	it('a device that lost its key syncs nothing until the passphrase is entered', async () => {
		const { w, desktop, mobile } = await setup();
		await desktop.vault.create('Inbox/later.md', 'later');
		await sleep(20);
		await desktop.push();

		const fresh = { get: async () => undefined, put: async () => undefined, delete: async () => undefined };
		mobile.keyStore = fresh as any;
		await mobile.start({ startupPull: false });
		expect(mobile.plugin.e2ee).toBeUndefined();
		expect(mobile.plugin.settings.e2eeEnabled).toBe(true);
		netLog.length = 0;
		await mobile.pull().catch(() => undefined);
		expect(mobile.vault.disk.has('Inbox/later.md')).toBe(false);
		expect(netLog.filter((l: any) => /drive\/v3\/files\?/.test(String(l.url ?? l)) && !/tokeninfo/.test(String(l.url ?? l)))).toHaveLength(0);
		expect(notices.join('\n')).toMatch(/key|passphrase/i);

		const { unlockEncryption } = await e2eeModule();
		await expect(unlockEncryption(mobile.plugin, 'wrong wrong wrong wrong')).rejects.toThrow(/wrong passphrase/i);
		expect(mobile.plugin.e2ee).toBeUndefined();
		await unlockEncryption(mobile.plugin, PASS);
		await mobile.pull();
		expect(dec(mobile.vault.disk.get('Inbox/later.md')!.data as any)).toBe('later');
		void w;
	});

	it('changing the passphrase: new devices need the new one, existing devices keep working, nothing is re-uploaded', async () => {
		const { w, desktop, mobile } = await setup();
		const { changePassphrase, enableEncryption } = await e2eeModule();
		const uploads = () => netLog.filter((l: any) => /upload\/drive/.test(String(l.url ?? l))).length;
		const NEW = 'a completely different passphrase';
		await expect(changePassphrase(desktop.plugin, 'wrong wrong wrong', NEW)).rejects.toThrow(/wrong passphrase/i);
		await expect(changePassphrase(desktop.plugin, PASS, 'short')).rejects.toThrow(/12/);
		const before = uploads();
		await changePassphrase(desktop.plugin, PASS, NEW);
		expect(uploads()).toBe(before);

		const third = w.device('third');
		await third.start({ startupPull: false });
		await expect(enableEncryption(third.plugin, PASS)).rejects.toThrow(/wrong passphrase/i);
		expect(await enableEncryption(third.plugin, NEW)).toBe('joined');
		await third.pull();
		expect(same(third.tree(), desktop.tree())).toBe('IDENTICAL');

		await desktop.vault.create('Inbox/after.md', 'after');
		await sleep(20);
		await desktop.push();
		await mobile.pull(); // joined with the old passphrase earlier; its stored key still works
		expect(dec(mobile.vault.disk.get('Inbox/after.md')!.data as any)).toBe('after');
	});
});

describe('switching encryption on and off on a device that already syncs a plain vault', () => {
	it('enable uploads everything encrypted into a NEW Drive vault, leaves the plain one alone, and disable goes back', async () => {
		simE2ee.on = false;
		const { w, desktop } = await setup();
		const { enableEncryption, disableEncryption } = await e2eeModule();
		(await cryptoModule()).kdf.iterations = 1000;
		const plain = desktop.plugin.settings;
		const plainRoot = plain.rootFolderId;
		const children = () => [...w.drive.files.values()].filter((f: any) => f.parents.includes(plainRoot) && !f.trashed).length;
		const plainBefore = [...w.drive.files.values()].filter((f: any) => f.properties.vault === w.drive.vaultName).map((f: any) => f.id + f.modifiedTime).sort();
		expect(plainRoot).toBeTruthy();

		expect(await enableEncryption(desktop.plugin, PASS)).toBe('created');
		expect(desktop.plugin.settings.rootFolderId).not.toBe(plainRoot);
		expect(desktop.plugin.settings.e2eePlainLink.rootFolderId).toBe(plainRoot);
		expect(Object.values(desktop.ops()).every((o) => o === 'create')).toBe(true);
		expect(Object.keys(desktop.ops())).toContain('Inbox/a.md');
		expect(Object.keys(desktop.ops()).filter((p) => p.includes('google-drive-sync'))).toEqual([]);
		await desktop.push();
		expect(desktop.ops()).toEqual({});
		const encryptedRoot = desktop.plugin.settings.rootFolderId;
		const under = [...w.drive.files.values()].filter((f: any) => f.properties.e2ee !== '1' && f.properties.vault && f.properties.vault !== w.drive.vaultName && !f.trashed);
		expect(under.length).toBeGreaterThan(10);
		expect([...w.drive.files.values()].filter((f: any) => f.properties.vault === w.drive.vaultName).map((f: any) => f.id + f.modifiedTime).sort()).toEqual(plainBefore);

		await disableEncryption(desktop.plugin);
		expect(desktop.plugin.settings.e2eeEnabled).toBe(false);
		expect(desktop.plugin.settings.rootFolderId).toBe(plainRoot);
		expect(desktop.plugin.e2ee).toBeUndefined();
		await desktop.vault.modify(desktop.vault.getAbstractFileByPath('Inbox/a.md')!, 'plain again');
		await sleep(20);
		await desktop.push();
		expect(dec(w.drive.snapshotNonConfig().length ? [...w.drive.files.values()].find((f: any) => f.properties.path === 'Inbox/a.md' && f.parents.length && !f.trashed)!.content! : new Uint8Array())).toBe('plain again');
		expect(children()).toBeGreaterThan(0);
		void encryptedRoot;
	});

	it('a device that is not switched keeps using the plain vault and never sees the encrypted one', async () => {
		simE2ee.on = false;
		const { w, desktop, mobile } = await setup();
		const { enableEncryption } = await e2eeModule();
		(await cryptoModule()).kdf.iterations = 1000;
		await enableEncryption(desktop.plugin, PASS);
		await desktop.push();
		await mobile.vault.create('Inbox/plain-phone.md', 'plain');
		await sleep(20);
		await mobile.push();
		await mobile.pull();
		expect(mobile.plugin.settings.e2eeEnabled).toBe(false);
		expect([...w.drive.files.values()].some((f: any) => f.properties.path === 'Inbox/plain-phone.md' && f.properties.vault === w.drive.vaultName)).toBe(true);
		expect(desktop.tree()).not.toContain('Inbox/plain-phone.md');
	});
});

describe('version history and the doctor with encryption on', () => {
	it('restore points are encrypted, and a restore brings the old content back decrypted', async () => {
		const { w, desktop } = await setup();
		const { listRestorePoints } = await import('../../helpers/history');
		const { prepareRestore, buildRestorePlan, applyRestorePlan } = await import('../../helpers/history-restore');
		const t = desktop.plugin;
		const v = desktop.vault;
		await v.modify(v.getAbstractFileByPath('Inbox/a.md')!, 'second version of a');
		await sleep(20);
		await desktop.push();

		const points = [...w.drive.files.values()].filter((f: any) => f.properties.history && f.properties.kind === 'point');
		expect(points.length).toBeGreaterThanOrEqual(2);
		for (const p of points as any[]) {
			const text = Buffer.from(p.content).toString('latin1');
			expect(text).not.toContain('Inbox');
			expect(text).not.toContain('a.md');
			expect(p.mimeType).toBe('application/octet-stream');
		}
		expect(await prepareRestore(t)).toBeUndefined();
		const infos = (await listRestorePoints(t)).sort((a, b) => a.createdAt - b.createdAt);
		expect(infos.length).toBeGreaterThanOrEqual(2);
		const built = await buildRestorePlan(t, infos[0]!, false);
		expect(built.plan.revert.map((i: any) => i.path)).toContain('Inbox/a.md');
		await applyRestorePlan(t, built.plan);
		expect(dec(desktop.vault.disk.get('Inbox/a.md')!.data as any)).toBe('a');
	});

	it('a restore point that someone changed on Drive is refused', async () => {
		const { w, desktop } = await setup();
		const { listRestorePoints } = await import('../../helpers/history');
		const { prepareRestore, buildRestorePlan } = await import('../../helpers/history-restore');
		const point = [...w.drive.files.values()].find((f: any) => f.properties.history && f.properties.kind === 'point') as any;
		point.content = flip(point.content, point.content.length - 2);
		await prepareRestore(desktop.plugin);
		const infos = await listRestorePoints(desktop.plugin);
		await expect(buildRestorePlan(desktop.plugin, infos[0]!, false)).rejects.toThrow();
	});

	it('the sync doctor reads real paths through the key and says encryption is on; it never prints the passphrase or the key', async () => {
		const { desktop } = await setup();
		const { modalTexts } = await import('./obsidian-mock');
		const { runSyncDoctor } = await import('../../helpers/doctor-command');
		modalTexts.length = 0;
		await runSyncDoctor(desktop.plugin);
		const report = modalTexts.join('\n');
		expect(report).toMatch(/End-to-end encryption: on, and this device has the key/);
		expect(report).not.toContain(PASS);
		expect(report).not.toMatch(/hw|wrapped|salt/i);
	});
});
