/**
 * The Drive check behind the Pull icon (3.9.0) must sign in first. Pull and Push do; the check did not, so on a
 * device with no access token yet (Obsidian just started, "Pull when Obsidian starts" off) every request went
 * out unsigned and Google answered "HTTP 403 - Insufficient Google Drive permissions".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.stubGlobal('window', globalThis);
vi.mock('obsidian', async () => await import('./obsidian-mock'));
import { sleep, netLog, notices } from './world';
import { setup, simDefaults, ROOT } from './scenario-helpers';

const edit = async (d: any, path: string, text: string) => {
	await d.vault.modify(d.vault.getFileByPath(path), text);
	await sleep(20);
};
const badgeModule = () => import(ROOT + '/helpers/badge.ts');

beforeEach(() => {
	simDefaults.deleteToTrash = true;
});

describe('the Drive check with no access token yet', () => {
	it('signs in first and counts, with no 403', async () => {
		const { desktop, mobile } = await setup();
		const { refreshWaitingBadge } = await badgeModule();
		mobile.plugin.settings.pullBadge = true;
		await edit(desktop, 'Inbox/a.md', 'a2');
		await desktop.push();
		mobile.plugin.accessToken = { token: '', expiresAt: 0 }; // a fresh start: nothing has signed in yet
		notices.length = 0;
		netLog.length = 0;
		await refreshWaitingBadge(mobile.plugin);
		expect(netLog.some((l) => l.includes('/api/access'))).toBe(true);
		expect(mobile.plugin.waitingOnDrive).toBe(1);
		expect(notices.filter((n) => /403|permission/i.test(n))).toEqual([]);
	});

	it('does nothing and says nothing when the device is offline', async () => {
		const { mobile } = await setup();
		const { refreshWaitingBadge } = await badgeModule();
		mobile.plugin.settings.pullBadge = true;
		mobile.plugin.accessToken = { token: '', expiresAt: 0 };
		vi.stubGlobal('navigator', { onLine: false });
		notices.length = 0;
		netLog.length = 0;
		await refreshWaitingBadge(mobile.plugin);
		vi.unstubAllGlobals();
		vi.stubGlobal('window', globalThis);
		expect(netLog).toEqual([]);
		expect(notices).toEqual([]);
	});

	it('the fake Drive refuses an unsigned request like Google (so this kind of mistake is caught)', async () => {
		const { mobile } = await setup();
		mobile.plugin.accessToken = { token: '', expiresAt: 0 };
		await expect(mobile.plugin.drive.getChangesStartToken()).rejects.toThrow(/403/);
	});
});
