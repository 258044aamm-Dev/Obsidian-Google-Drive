/**
 * 3.14.0: "Compare the whole vault with Google Drive". Read-only. Runs in both modes: without encryption the
 * quick stage decides by MD5; with encryption (SIM_E2EE=1) same-size files stay undecided until the exact check.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
vi.stubGlobal('window', globalThis);
vi.mock('obsidian', async () => await import('./obsidian-mock'));
import { sleep, netLog, notices } from './world';
import { modalEls, modalTexts } from './obsidian-mock';
import { setup, simDefaults, simE2ee, ROOT } from './scenario-helpers';

const enc = new TextEncoder();
const mod = () => import(ROOT + '/helpers/compare-vault.ts');
const cmd = () => import(ROOT + '/helpers/compare-vault-command.ts');
const edit = async (d: any, path: string, text: string) => {
	await d.vault.modify(d.vault.getFileByPath(path), text);
	await sleep(20);
};
const find = (w: any, path: string) => [...w.drive.files.values()].find((f: any) => w.drive.shown(f) === path);

/** Stage 1, then (when something is undecided) the exact check: what a user ends up with. */
const full = async (device: any) => {
	const { collectVaultComparison, exactCompare } = await mod();
	const quick = await collectVaultComparison(device.plugin);
	expect('error' in quick).toBe(false);
	const rows = quick.rows;
	const quickRows = rows.map((r: any) => ({ ...r })); // what stage 1 alone said (the exact stage changes `rows`)
	await exactCompare(rows, {
		readLocal: (p: string) => device.plugin.app.vault.readBinary(device.plugin.app.vault.getFileByPath(p)),
		download: (r: any) => device.plugin.drive.getFile(r.id, r.path).arrayBuffer(),
	});
	return { rows, quick: { rows: quickRows } };
};
const verdicts = (rows: any[]) => Object.fromEntries(rows.map((r) => [r.path, r.verdict]));
const ALL = ['Archive/old.md', 'Inbox/a.md', 'Inbox/b.md', 'Journal/2026/09-01.md', 'Projects/Alpha/notes/n1.md', 'Projects/Alpha/plan.md', 'Projects/Beta/readme.md', 'root.md'];

beforeEach(() => {
	simDefaults.deleteToTrash = true;
});

describe('the quick stage, on its own data', () => {
	const local = (path: string, size: number, mtime = 1000) => ({ path, size, mtime });
	const read = (text: string) => async () => enc.encode(text).buffer;
	const md5 = async (t: string) => (await import('../../helpers/md5')).md5Hex(enc.encode(t));

	it('size and MD5 decide without encryption', async () => {
		const { quickCompare } = await mod();
		const rows = await quickCompare({
			local: [local('a.md', 3), local('b.md', 3), local('c.md', 3)],
			drive: [
				{ path: 'a.md', id: '1', size: 3, md5: await md5('abc') },
				{ path: 'b.md', id: '2', size: 3, md5: await md5('xyz') },
				{ path: 'c.md', id: '3', size: 9, md5: 'x' },
			],
			encrypted: false,
			readLocal: read('abc'),
		});
		expect(verdicts(rows)).toEqual({ 'a.md': 'same', 'b.md': 'differs', 'c.md': 'differs' });
	});

	it('an MD5 in capital letters still matches', async () => {
		const { quickCompare } = await mod();
		const rows = await quickCompare({
			local: [local('a.md', 3)],
			drive: [{ path: 'a.md', id: '1', size: 3, md5: (await md5('abc')).toUpperCase() }],
			encrypted: false,
			readLocal: read('abc'),
		});
		expect(rows[0].verdict).toBe('same');
	});

	it('with encryption an equal size is undecided, a different size is a difference', async () => {
		const { quickCompare } = await mod();
		const { OVERHEAD_BYTES } = await import('../../helpers/crypto');
		const rows = await quickCompare({
			local: [local('a.md', 10), local('b.md', 10)],
			drive: [
				{ path: 'a.md', id: '1', size: 10 + OVERHEAD_BYTES },
				{ path: 'b.md', id: '2', size: 10 + OVERHEAD_BYTES + 5 },
			],
			encrypted: true,
			readLocal: read('x'),
		});
		expect(verdicts(rows)).toEqual({ 'a.md': 'unknown', 'b.md': 'differs' });
		expect(rows[0].reason).toMatch(/encrypted/);
	});

	it('files on one side only, sorted by path, with the pending operation', async () => {
		const { quickCompare } = await mod();
		const rows = await quickCompare({
			local: [local('z.md', 1), local('m.md', 1)],
			drive: [{ path: 'a.md', id: '1', size: 1 }],
			encrypted: false,
			readLocal: read('x'),
			pending: { 'z.md': 'create' },
		});
		expect(rows.map((r: any) => [r.path, r.verdict, r.pending])).toEqual([
			['a.md', 'only-drive', undefined],
			['m.md', 'only-here', undefined],
			['z.md', 'only-here', 'create'],
		]);
	});

	it('undecided, not wrong: two files with one path, no size, no checksum, unreadable file', async () => {
		const { quickCompare } = await mod();
		const rows = await quickCompare({
			local: [local('two.md', 1), local('nosize.md', 1), local('nosum.md', 1), local('bad.md', 1)],
			drive: [
				{ path: 'two.md', id: '1', size: 1, md5: 'x' },
				{ path: 'two.md', id: '2', size: 1, md5: 'x' },
				{ path: 'nosize.md', id: '3' },
				{ path: 'nosum.md', id: '4', size: 1 },
				{ path: 'bad.md', id: '5', size: 1, md5: 'x' },
			],
			encrypted: false,
			readLocal: async (p: string) => {
				if (p === 'bad.md') throw new Error('gone');
				return enc.encode('x').buffer;
			},
		});
		const by = Object.fromEntries(rows.map((r: any) => [r.path, r]));
		expect(Object.values(by).every((r: any) => r.verdict === 'unknown')).toBe(true);
		expect(by['two.md'].reason).toMatch(/two files/);
		expect(by['nosize.md'].reason).toMatch(/size/);
		expect(by['nosum.md'].reason).toMatch(/checksum/);
		expect(by['bad.md'].reason).toMatch(/read/);
	});
});

describe('the exact stage, on its own data', () => {
	const rowsOf = () => ['a', 'b', 'c', 'd'].map((n) => ({ path: n + '.md', verdict: 'unknown', id: n, localSize: 1, driveSize: 1 }));
	const bytes = (s: string) => enc.encode(s).buffer;

	it('decides by content, marks failures, and reports progress', async () => {
		const { exactCompare } = await mod();
		const rows: any[] = rowsOf();
		const progress: number[] = [];
		await exactCompare(rows, {
			readLocal: async () => bytes('same'),
			download: async (r: any) => (r.id === 'a' ? bytes('same') : r.id === 'b' ? bytes('other') : r.id === 'c' ? undefined : Promise.reject(new Error('boom'))),
			onProgress: (done: number) => progress.push(done),
		});
		expect(rows.map((r) => r.verdict)).toEqual(['same', 'differs', 'failed', 'failed']);
		expect(rows[3].reason).toBe('boom');
		expect(progress.sort()).toEqual([1, 2, 3, 4]);
	});

	it('stops when told to, and the rest stay undecided', async () => {
		const { exactCompare } = await mod();
		const rows: any[] = rowsOf();
		let stop = false;
		await exactCompare(rows, {
			concurrency: 1,
			readLocal: async () => bytes('x'),
			download: async () => ((stop = true), bytes('x')),
			stopped: () => stop,
		});
		expect(rows.map((r) => r.verdict)).toEqual(['same', 'unknown', 'unknown', 'unknown']);
	});

	it('leaves decided rows alone and never downloads them', async () => {
		const { exactCompare } = await mod();
		const rows: any[] = [{ path: 'a.md', verdict: 'same', id: 'a', localSize: 1 }, { path: 'b.md', verdict: 'only-drive', id: 'b' }];
		let downloads = 0;
		await exactCompare(rows, { readLocal: async () => bytes('x'), download: async () => (downloads++, bytes('x')) });
		expect(downloads).toBe(0);
	});
});

describe('the whole vault, two devices and a simulated Drive', () => {
	it('an identical vault: every file is the same', async () => {
		const { mobile } = await setup();
		netLog.length = 0;
		const { rows, quick } = await full(mobile);
		expect(verdicts(rows)).toEqual(Object.fromEntries(ALL.map((p) => [p, 'same'])));
		const { renderVaultReport } = await mod();
		expect(renderVaultReport(rows)).toContain('Result: IDENTICAL. All 8 files');
		if (!simE2ee.on) {
			// the quick stage alone decided everything: no file was downloaded
			expect(netLog.filter((l) => l.includes('alt=media'))).toEqual([]);
			expect(quick.rows.every((r: any) => r.verdict === 'same')).toBe(true);
		} else {
			expect(quick.rows.every((r: any) => r.verdict === 'unknown')).toBe(true);
			expect(netLog.filter((l) => l.includes('alt=media')).length).toBe(8);
		}
	});

	it('an edit that changes the size, an edit that keeps the size, a new file and a deleted file', async () => {
		const { desktop, mobile } = await setup();
		await edit(desktop, 'Inbox/a.md', 'a much longer text');
		await edit(desktop, 'Inbox/b.md', 'z'); // same size as 'b'
		await desktop.vault.create('New.md', 'new');
		await mobile.vault.delete(mobile.vault.getFileByPath('Archive/old.md')!);
		await sleep(20);
		const d = await full(desktop);
		expect(verdicts(d.rows)).toEqual({
			...Object.fromEntries(ALL.map((p) => [p, 'same'])),
			'Inbox/a.md': 'differs',
			'Inbox/b.md': 'differs',
			'New.md': 'only-here',
		});
		const a = d.rows.find((r: any) => r.path === 'Inbox/a.md');
		expect(a.pending).toBe('modify');
		expect(d.rows.find((r: any) => r.path === 'New.md').pending).toBe('create');
		const m = await full(mobile);
		const old = m.rows.find((r: any) => r.path === 'Archive/old.md');
		expect(old.verdict).toBe('only-drive');
		expect(old.pending).toBe('delete');
		const { renderVaultReport } = await mod();
		const text = renderVaultReport(d.rows);
		expect(text).toContain('Different: 2');
		expect(text).toContain('Only on this device: 1');
		expect(text).toMatch(/Inbox\/a\.md: here 18 B[^\n]*newer by time: this device; waiting in the pending list/);
		expect(text).toMatch(/New\.md: 3 B[^\n]*waiting in the pending list \(Push uploads it\)/);
		expect(renderVaultReport(m.rows)).toMatch(/Archive\/old\.md[^\n]*its deletion is waiting in the pending list/);
	});

	it('a file pushed by another device and not pulled yet is only on Drive, with no pending entry', async () => {
		const { desktop, mobile } = await setup();
		await desktop.vault.create('FromDesktop.md', 'hello');
		await sleep(20);
		await desktop.push();
		const m = await full(mobile);
		const row = m.rows.find((r: any) => r.path === 'FromDesktop.md');
		expect(row).toMatchObject({ verdict: 'only-drive', pending: undefined });
		const { renderVaultReport } = await mod();
		expect(renderVaultReport(m.rows)).toMatch(/FromDesktop\.md[^\n]*Pull will download it/);
	});

	it.skipIf(simE2ee.on)('an edit in the Drive web page that keeps the size is found by the checksum', async () => {
		const { w, mobile } = await setup();
		const f = find(w, 'Inbox/a.md');
		f.content = enc.encode('Z');
		f.revisions.push({ id: 'web' + w.drive.seq++, content: f.content.slice() }); // as "Upload new version" does
		f.modifiedTime = new Date().toISOString();
		const { quick } = await full(mobile);
		expect(verdicts(quick.rows)['Inbox/a.md']).toBe('differs');
	});

	it('ignored files and the plugin\'s own folder are left out on both sides', async () => {
		const { desktop } = await setup();
		desktop.plugin.settings.ignorePatterns = '*.tmp';
		await desktop.vault.create('scratch.tmp', 'x');
		await sleep(20);
		const { rows } = await full(desktop);
		expect(rows.map((r: any) => r.path)).not.toContain('scratch.tmp');
		expect(rows.map((r: any) => r.path).sort()).toEqual(ALL);
	});

	it('changes nothing: only GET requests, same notes, same saved state', async () => {
		const { desktop, mobile } = await setup();
		await edit(desktop, 'Inbox/a.md', 'changed here');
		const before = JSON.stringify(desktop.plugin.settings);
		const files = JSON.stringify([...desktop.vault.getAllLoadedFiles()].map((f: any) => [f.path, f.stat?.mtime, f.stat?.size]));
		const driveBefore = JSON.stringify([...desktop.world.drive.files.values()].map((f: any) => [f.id, f.name, f.modifiedTime, f.content?.length]));
		netLog.length = 0;
		await full(desktop);
		await full(mobile);
		expect(netLog.filter((l) => !l.startsWith('GET ') && !/oauth|\/api\/access/.test(l))).toEqual([]);
		expect(JSON.stringify(desktop.plugin.settings)).toBe(before);
		expect(JSON.stringify([...desktop.vault.getAllLoadedFiles()].map((f: any) => [f.path, f.stat?.mtime, f.stat?.size]))).toBe(files);
		expect(JSON.stringify([...desktop.world.drive.files.values()].map((f: any) => [f.id, f.name, f.modifiedTime, f.content?.length]))).toBe(driveBefore);
	});

	it('says why it cannot start instead of guessing', async () => {
		const { mobile } = await setup();
		const { runCompareVault } = await cmd();
		for (let i = 0; i < 5; i++) mobile.world.drive.failNext.push({ match: /^GET \/drive\/v3\/files$/, status: 400 });
		notices.length = 0;
		modalEls.length = 0;
		await runCompareVault(mobile.plugin);
		mobile.world.drive.failNext.length = 0;
		expect(notices.join('\n')).toMatch(/Compare failed/);
		expect(modalEls.filter((e) => e.tag === 'pre')).toEqual([]); // no half result is shown
	});

	it.skipIf(!simE2ee.on)('a locked vault is refused', async () => {
		const { mobile } = await setup();
		const { collectVaultComparison } = await mod();
		mobile.plugin.e2ee = undefined;
		const result = await collectVaultComparison(mobile.plugin);
		expect(result).toEqual({ error: expect.stringMatching(/locked/) });
	});
});

describe('the window', () => {
	const last = (tag: string) => modalEls.filter((e) => e.tag === tag).at(-1)!;
	const button = (start: string) => modalEls.filter((e) => e.tag === 'button' && e.text.startsWith(start)).at(-1);
	const settle = async () => {
		for (let i = 0; i < 100; i++) {
			await sleep(10);
			if (!button('Checking')) return;
		}
	};

	it('shows the result; with encryption the Exact check button decides the rest', async () => {
		const { desktop, mobile } = await setup();
		await edit(desktop, 'Inbox/a.md', 'a much longer text');
		const { runCompareVault } = await cmd();
		modalEls.length = 0;
		modalTexts.length = 0;
		await runCompareVault(desktop.plugin);
		expect(modalTexts.join('\n')).toContain('Nothing was changed on this device or on Google Drive.');
		const report = last('pre');
		expect(report.text).toContain('Different: 1');
		expect(report.text).toContain('Inbox/a.md');
		if (!simE2ee.on) {
			expect(button('Exact check')).toBeUndefined();
			expect(report.text).toContain('Identical: 7');
		} else {
			// size differs for a.md (decided); the other 7 need a download
			expect(report.text).toContain('Not decided yet: 7');
			const exact = button('Exact check')!;
			expect(exact.text).toMatch(/downloads 7 files/);
			exact.click();
			await settle();
			expect(last('pre').text).toContain('Identical: 7');
			expect(last('pre').text).toContain('Not decided yet: 0');
			expect(button('Exact check finished')).toBeDefined();
		}
		void mobile;
	});

	it('has a Copy report button with the full text', async () => {
		const { mobile } = await setup();
		const { runCompareVault } = await cmd();
		modalEls.length = 0;
		let copied = '';
		vi.stubGlobal('navigator', { clipboard: { writeText: async (t: string) => void (copied = t) } });
		await runCompareVault(mobile.plugin);
		button('Copy report')!.click();
		await sleep(10);
		vi.unstubAllGlobals();
		vi.stubGlobal('window', globalThis);
		expect(copied).toContain('Identical:');
		expect(copied).toContain('Nothing was changed');
	});

	it('refuses to start during a sync, and says so', async () => {
		const { mobile } = await setup();
		const { runCompareVault } = await cmd();
		mobile.plugin.syncing = true;
		notices.length = 0;
		modalEls.length = 0;
		await runCompareVault(mobile.plugin);
		mobile.plugin.syncing = false;
		expect(notices.join('\n')).toMatch(/A sync is running/);
		expect(modalEls.filter((e) => e.tag === 'pre')).toEqual([]);
	});
});
