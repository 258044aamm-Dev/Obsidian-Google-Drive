/**
 * 3.8.0: a slow, flaky or lost connection.
 *  - a request that never answers times out instead of freezing the sync;
 *  - reading / updating / deleting is retried a few times; a refused request (400, 403 ...) is not;
 *  - a create whose answer was lost is never repeated blindly: the file that may have been made is
 *    looked for and adopted, so nothing is duplicated and the content is right;
 *  - the notices say when the cause was the connection;
 *  - a blocked Google host is reported before a sync starts; a phone keeps its screen on while syncing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.stubGlobal('window', globalThis);
vi.mock('obsidian', async () => await import('./obsidian-mock'));
import { sleep, notices, netLog } from './world';
import { setup, simDefaults } from './scenario-helpers';
import { net as mock, Platform } from './obsidian-mock';
import { net as cfg } from '../../helpers/net-retry';
import { onVisibilityChange, BACKGROUND_NOTICE } from '../../helpers/mobile-sync';

const FOLDER = 'application/vnd.google-apps.folder';
const defaults = { ...cfg, delays: [...cfg.delays] };
const text = () => notices.join('\n');
const count = (re: RegExp) => netLog.filter((l) => re.test(l)).length;
const LOST = 'net::ERR_INTERNET_DISCONNECTED';

const retriesOn = () => {
	cfg.delays = [5, 5, 5];
	cfg.settleMs = 5;
	cfg.timeoutMs = 80;
	cfg.transferTimeoutMs = 80;
	cfg.perMbMs = 0;
	cfg.downloadTimeoutMs = 80;
};

/** Wraps the Drive handler; `fn` may answer instead (return undefined to pass the request on). */
const intercept = (fn: (key: string, req: any, original: (r: any) => Promise<any>) => Promise<any> | undefined) => {
	const original = mock.handler;
	mock.handler = async (req: any) => {
		const key = (req.method ?? 'GET') + ' ' + new URL(req.url).pathname;
		return (await fn(key, req, original)) ?? original(req);
	};
	return () => void (mock.handler = original);
};
const never = () => new Promise<any>(() => undefined);
const live = (w: any) => [...w.drive.files.values()].filter((f: any) => !f.trashed && !f.properties?.history && f.id !== w.drive.rootId);
const named = (w: any, name: string) => live(w).filter((f: any) => w.drive.shown(f) === name && f.mimeType !== FOLDER);

beforeEach(() => {
	simDefaults.deleteToTrash = false;
	retriesOn();
});
afterEach(() => {
	Object.assign(cfg, defaults, { delays: [] as number[], settleMs: 0 });
	Platform.isMobile = false;
});

describe('retrying requests that are safe to repeat', () => {
	it('a 503 from Google is retried and the Pull completes without an error', async () => {
		const { w, desktop, mobile } = await setup();
		await desktop.vault.create('fresh.md', 'fresh');
		await sleep(20);
		await desktop.push();
		w.drive.failNext.push({ match: /^GET \/drive\/v3\/changes$/, status: 503 });
		netLog.length = 0;
		await mobile.pull();
		expect(text()).not.toMatch(/Pull failed/);
		expect(count(/GET .*\/drive\/v3\/changes\?/)).toBeGreaterThanOrEqual(2);
		expect(mobile.tree()).toContain('fresh.md');
	});

	it('control: with retries off the same 503 fails the Pull as before', async () => {
		const { w, desktop, mobile } = await setup();
		await desktop.vault.create('fresh.md', 'fresh');
		await sleep(20);
		await desktop.push();
		cfg.delays = [];
		w.drive.failNext.push({ match: /^GET \/drive\/v3\/changes$/, status: 503 });
		await mobile.pull();
		expect(text()).toMatch(/Pull failed during/);
	});

	it.each([400, 403])('a %s answer is a real refusal: it is not retried', async (status) => {
		const { w, mobile } = await setup();
		w.drive.failNext.push({ match: /^GET \/drive\/v3\/changes$/, status });
		netLog.length = 0;
		await mobile.pull();
		expect(text()).toMatch(/Pull failed during/);
		expect(text()).not.toMatch(/connection to Google Drive was lost/);
		expect(count(/GET .*\/drive\/v3\/changes\?/)).toBe(1);
	});

	it('a request that never answers times out and is retried', async () => {
		const { w, desktop, mobile } = await setup();
		await desktop.vault.create('fresh.md', 'fresh');
		await sleep(20);
		await desktop.push();
		let hung = 0;
		const back = intercept((key) => (key === 'GET /drive/v3/changes' && hung++ === 0 ? never() : undefined));
		await mobile.pull();
		back();
		expect(hung).toBeGreaterThanOrEqual(2);
		expect(text()).not.toMatch(/Pull failed/);
		expect(mobile.tree()).toContain('fresh.md');
		expect(w.drive.files.size).toBeGreaterThan(0);
	});

	it('a connection that stays down: the Pull stops after a few tries, says why, and nothing is lost', async () => {
		const { mobile } = await setup();
		const back = intercept((key) => (key === 'GET /drive/v3/changes' ? never() : undefined));
		netLog.length = 0;
		await mobile.pull();
		expect(count(/GET .*\/drive\/v3\/changes\?/)).toBe(4); // first try + 3 retries
		expect(text()).toMatch(/Pull failed during/);
		expect(text()).toMatch(/connection to Google Drive was lost or too slow/);
		expect(mobile.plugin.syncing).toBe(false);
		back();
		await mobile.pull();
		expect(text()).not.toMatch(/Pull failed/);
	});

	it('the waiting is capped by the time budget of one sync', async () => {
		const { w, mobile } = await setup();
		cfg.delays = [30, 30, 30];
		cfg.budgetMs = 40;
		const back = intercept((key) => (key === 'GET /drive/v3/changes' ? Promise.resolve({ status: 503, text: 'busy', json: {} }) : undefined));
		netLog.length = 0;
		await mobile.pull();
		back();
		expect(count(/GET .*\/drive\/v3\/changes\?/)).toBe(2);
		expect(text()).toMatch(/Pull failed during/);
		expect(w.drive.files.size).toBeGreaterThan(0);
	});
});

describe('a create whose answer was lost is never repeated blindly', () => {
	for (const where of ['after Drive made the file', 'before the request reached Drive'] as const) {
		it(`upload lost ${where}: one file, right content`, async () => {
			const { w, desktop, mobile } = await setup();
			await desktop.vault.create('big.md', 'the real content');
			await sleep(20);
			let lost = false;
			const back = intercept(async (key, req, original) => {
				if (key !== 'POST /upload/drive/v3/files' || lost) return undefined;
				lost = true;
				if (where === 'after Drive made the file') await original(req);
				throw new Error(LOST);
			});
			await desktop.push();
			back();
			expect(lost).toBe(true);
			expect(text()).toMatch(/Push complete/);
			expect(named(w, 'big.md')).toHaveLength(1);
			expect(await w.drive.contentOf(named(w, 'big.md')[0])).toBeDefined();
			expect(desktop.ops()).toEqual({});
			await mobile.pull();
			expect(await mobile.vault.read(mobile.vault.getFileByPath('big.md')!)).toBe('the real content');
		});
	}

	it('a folder create whose answer was lost is adopted: one folder', async () => {
		const { w, desktop } = await setup();
		await desktop.vault.createFolder('Z');
		await desktop.vault.create('Z/z1.md', 'z');
		await sleep(20);
		let lost = false;
		const back = intercept(async (key, req, original) => {
			if (key !== 'POST /drive/v3/files' || lost) return undefined;
			lost = true;
			await original(req);
			throw new Error(LOST);
		});
		await desktop.push();
		back();
		expect(lost).toBe(true);
		expect(text()).toMatch(/Push complete/);
		expect(live(w).filter((f: any) => f.mimeType === FOLDER && f.name === 'Z' || w.drive.shown(f) === 'Z')).toHaveLength(1);
		expect(named(w, 'Z/z1.md').length).toBe(1);
	});

	it('control: a plain 403 on a create is not retried and not adopted', async () => {
		const { w, desktop } = await setup();
		await desktop.vault.create('one.md', 'one');
		await sleep(20);
		w.drive.failNext.push({ match: /^POST \/upload\/drive\/v3\/files$/, status: 403 });
		netLog.length = 0;
		await desktop.push();
		expect(count(/POST .*upload\/drive\/v3\/files/)).toBe(1);
		expect(text()).toMatch(/Push failed during/);
		expect(named(w, 'one.md')).toHaveLength(0);
	});
});

describe('a delete whose answer was lost', () => {
	it('Push (batch delete): the answer is lost, the retry finds it already gone: the Push completes', async () => {
		const { w, desktop } = await setup();
		await desktop.vault.delete(desktop.vault.getAbstractFileByPath('Inbox/b.md')!);
		await sleep(20);
		let lost = false;
		const back = intercept(async (key, req, original) => {
			if (key !== 'POST /batch/drive/v3' || lost) return undefined;
			lost = true;
			await original(req);
			throw new Error(LOST);
		});
		await desktop.push();
		back();
		expect(lost).toBe(true);
		expect(text()).not.toMatch(/Push failed/);
		expect(desktop.ops()).toEqual({});
		expect(named(w, 'Inbox/b.md')).toHaveLength(0);
	});

	it('a single delete: the retry gets "not found" and that counts as deleted', async () => {
		const { w, desktop } = await setup();
		const file = named(w, 'Inbox/b.md')[0];
		const { getDriveClient } = await import('../../helpers/drive');
		const client = getDriveClient(desktop.plugin);
		let lost = false;
		const back = intercept(async (key, req, original) => {
			if (!/^DELETE \/drive\/v3\/files\//.test(key) || lost) return undefined;
			lost = true;
			await original(req);
			throw new Error(LOST);
		});
		await expect(client.deleteFile(file.id)).resolves.toBe(true);
		back();
		expect(lost).toBe(true);
		expect(named(w, 'Inbox/b.md')).toHaveLength(0);
	});

	it('control: a 404 on the very first try is not turned into a success', async () => {
		const { w, desktop } = await setup();
		const file = named(w, 'Inbox/b.md')[0];
		const { getDriveClient } = await import('../../helpers/drive');
		const client = getDriveClient(desktop.plugin);
		w.drive.failNext.push({ match: /^DELETE \/drive\/v3\/files\//, status: 404 });
		await expect(client.deleteFile(file.id)).rejects.toThrow(/status 404/);
		expect(count(/DELETE /)).toBeGreaterThan(0);
	});
});

describe('messages', () => {
	it('Push: a lost connection adds the connection hint and keeps the old text', async () => {
		const { desktop } = await setup();
		await desktop.vault.create('n1.md', 'x');
		await sleep(20);
		const back = intercept((key) => (key === 'POST /upload/drive/v3/files' ? Promise.reject(new Error(LOST)) : undefined));
		await desktop.push();
		back();
		expect(text()).toMatch(/Push failed during upload\. 0 files were uploaded before it stopped and 1 change is still pending|Push failed during upload\./);
		expect(text()).toMatch(/connection to Google Drive was lost or too slow/);
		expect(text()).toMatch(/Press Push again when the connection is back/);
	});

	it('Push: a refusal from Google does NOT say the connection was lost', async () => {
		const { w, desktop } = await setup();
		await desktop.vault.create('n1.md', 'x');
		await sleep(20);
		w.drive.failNext.push({ match: /^POST \/upload\/drive\/v3\/files$/, status: 403 });
		await desktop.push();
		expect(text()).toMatch(/Push failed during/);
		expect(text()).not.toMatch(/connection to Google Drive was lost/);
	});
});

describe('Google Drive blocked while the internet works', () => {
	for (const op of ['pull', 'push'] as const) {
		it(`${op}: says so before doing anything`, async () => {
			const { desktop, mobile } = await setup();
			const d = op === 'pull' ? mobile : desktop;
			await desktop.vault.create('q.md', 'q');
			await sleep(20);
			const back = intercept((_key, req) => (new URL(req.url).hostname === 'www.googleapis.com' && /generate_204/.test(req.url) ? Promise.reject(new Error(LOST)) : undefined));
			netLog.length = 0;
			// like "No internet connection" this stops the command after showing the notice
			await d[op]().catch(() => undefined);
			back();
			expect(text()).toMatch(/online, but Google Drive could not be reached/);
			expect(count(/\/drive\/v3\//)).toBe(0);
			expect(d.plugin.syncing).toBe(false);
			expect(text()).not.toMatch(/Pulling|Pushing/);
		});
	}

	it('control: any answer from the host (even an error page) counts as reachable', async () => {
		const { mobile } = await setup();
		const back = intercept((_k, req) => (/generate_204/.test(req.url) && new URL(req.url).hostname === 'www.googleapis.com' ? Promise.resolve({ status: 404, text: '', json: {} }) : undefined));
		await mobile.pull();
		back();
		expect(text()).not.toMatch(/could not be reached/);
	});
});

describe('phones: screen kept on, background notice', () => {
	const stubWakeLock = () => {
		const log: string[] = [];
		vi.stubGlobal('navigator', {
			wakeLock: {
				request: async () => {
					log.push('request');
					return { release: async () => void log.push('release') };
				},
			},
		});
		return log;
	};

	it('on a phone the screen lock is requested for the sync and released after it', async () => {
		const log = stubWakeLock();
		Platform.isMobile = true;
		const { mobile } = await setup();
		log.length = 0;
		await mobile.pull();
		await sleep(10);
		expect(log).toEqual(['request', 'release']);
		expect(mobile.plugin.syncing).toBe(false);
		vi.unstubAllGlobals();
		vi.stubGlobal('window', globalThis);
	});

	it('the screen lock is released even when the sync fails', async () => {
		const log = stubWakeLock();
		Platform.isMobile = true;
		const { w, mobile } = await setup();
		log.length = 0;
		w.drive.failNext.push({ match: /^GET \/drive\/v3\/changes$/, status: 403 });
		await mobile.pull();
		await sleep(10);
		expect(log).toEqual(['request', 'release']);
		vi.unstubAllGlobals();
		vi.stubGlobal('window', globalThis);
	});

	it('on a computer nothing is requested and no "keep open" notice is shown', async () => {
		const log = stubWakeLock();
		const { mobile } = await setup();
		await mobile.pull();
		expect(log).toEqual([]);
		expect(text()).not.toMatch(/Keep this screen open/);
		vi.unstubAllGlobals();
		vi.stubGlobal('window', globalThis);
	});

	it('a phone shows the "keep this screen open" notice at the start of a sync', async () => {
		stubWakeLock();
		Platform.isMobile = true;
		const { mobile } = await setup();
		await mobile.pull();
		expect(text()).toMatch(/Keep this screen open until the sync has finished/);
		vi.unstubAllGlobals();
		vi.stubGlobal('window', globalThis);
	});

	it('a device without screen-lock support syncs normally', async () => {
		vi.stubGlobal('navigator', {});
		Platform.isMobile = true;
		const { mobile } = await setup();
		await mobile.pull();
		expect(text()).not.toMatch(/failed/);
		vi.unstubAllGlobals();
		vi.stubGlobal('window', globalThis);
	});

	it('coming back after more than 5 s during a sync gives the notice; a short look away or no sync does not', () => {
		const t = {};
		expect(onVisibilityChange(t, false, true, 1000)).toBeUndefined();
		expect(onVisibilityChange(t, true, true, 9000)).toBe(BACKGROUND_NOTICE);
		expect(onVisibilityChange(t, false, true, 20000)).toBeUndefined();
		expect(onVisibilityChange(t, true, true, 22000)).toBeUndefined();
		expect(onVisibilityChange(t, false, false, 30000)).toBeUndefined();
		expect(onVisibilityChange(t, true, false, 90000)).toBeUndefined();
		expect(onVisibilityChange(t, false, true, 100000)).toBeUndefined();
		expect(onVisibilityChange(t, true, false, 190000)).toBeUndefined(); // the sync ended meanwhile
	});
});
