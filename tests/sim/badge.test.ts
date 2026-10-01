/**
 * 3.9.0: counts on the ribbon icons. The Push count is the pending list. The Pull count (opt-in)
 * is what Google Drive changed since the last sync, minus this device's own uploads.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.stubGlobal('window', globalThis);
vi.mock('obsidian', async () => await import('./obsidian-mock'));
import { sleep, netLog } from './world';
import { setup, simDefaults, ROOT } from './scenario-helpers';

const edit = async (d: any, path: string, text: string) => {
	await d.vault.modify(d.vault.getFileByPath(path), text);
	await sleep(20);
};

/** A stand-in for a ribbon icon element. */
const icon = () => {
	const el: any = {
		classes: new Set<string>(),
		attrs: {} as Record<string, string>,
		kids: [] as any[],
		addClass: (c: string) => el.classes.add(c),
		removeClass: (c: string) => el.classes.delete(c),
		setAttribute: (k: string, v: string) => (el.attrs[k] = v),
		createSpan: (o: { cls: string }) => {
			const kid: any = {
				classes: new Set([o.cls]),
				text: '',
				setText: (t: string) => (kid.text = t),
				addClass: (c: string) => kid.classes.add(c),
				removeClass: (c: string) => kid.classes.delete(c),
			};
			el.kids.push(kid);
			return kid;
		},
		querySelector: () => el.kids[0] ?? null,
	};
	return el;
};
const shown = (el: any) => (el.kids[0] && !el.kids[0].classes.has('ogd-badge-hidden') ? el.kids[0].text : '');

const badgeModule = () => import(ROOT + '/helpers/badge.ts');

beforeEach(() => {
	simDefaults.deleteToTrash = true;
});

describe('waiting on Drive', () => {
	it('counts what another device pushed, and nothing for a device\'s own uploads', async () => {
		const { desktop, mobile } = await setup();
		const { countWaitingOnDrive } = await badgeModule();
		expect(await countWaitingOnDrive(mobile.plugin)).toBe(0);
		await edit(desktop, 'Inbox/a.md', 'a2');
		await edit(desktop, 'Inbox/b.md', 'b2');
		await edit(desktop, 'root.md', 'r2');
		await desktop.push();
		expect(await countWaitingOnDrive(mobile.plugin)).toBe(3);
		expect(await countWaitingOnDrive(desktop.plugin)).toBe(0); // its own uploads
	});

	it('does not count a file whose Drive time is exactly what this device\'s own upload produced', async () => {
		const { desktop } = await setup();
		const { countWaitingOnDrive } = await badgeModule();
		const before = desktop.plugin.settings.lastSyncedAt;
		await edit(desktop, 'Inbox/a.md', 'a2');
		await desktop.push();
		desktop.plugin.settings.lastSyncedAt = before; // pretend the sync point is older than the upload
		expect(await countWaitingOnDrive(desktop.plugin)).toBe(1);
		const listed = await desktop.plugin.drive.searchFiles({
			include: ['id', 'modifiedTime', 'properties'],
			matches: [{ modifiedTime: { gt: new Date(before).toISOString() } }],
		});
		for (const f of listed) desktop.plugin.settings.ownUploads[f.id] = f.modifiedTime;
		expect(await countWaitingOnDrive(desktop.plugin)).toBe(0);
	});

	it('is 0 again after a Pull', async () => {
		const { desktop, mobile } = await setup();
		const { countWaitingOnDrive } = await badgeModule();
		await edit(desktop, 'Inbox/a.md', 'a2');
		await desktop.push();
		expect(await countWaitingOnDrive(mobile.plugin)).toBe(1);
		await mobile.pull();
		await sleep(30);
		expect(await countWaitingOnDrive(mobile.plugin)).toBe(0);
	});

	it('counts a file deleted on Drive that still exists here', async () => {
		const { desktop, mobile } = await setup();
		const { countWaitingOnDrive } = await badgeModule();
		await desktop.vault.delete(desktop.vault.getAbstractFileByPath('Inbox/a.md')!);
		await sleep(20);
		await desktop.push();
		expect(await countWaitingOnDrive(mobile.plugin)).toBe(1);
	});

	it('says "unknown" when the device never synced, and changes nothing while counting', async () => {
		const { desktop, mobile } = await setup();
		const { countWaitingOnDrive } = await badgeModule();
		await edit(desktop, 'Inbox/a.md', 'a2');
		await desktop.push();
		const before = JSON.stringify(mobile.plugin.settings);
		expect(await countWaitingOnDrive(mobile.plugin)).toBe(1);
		expect(JSON.stringify(mobile.plugin.settings)).toBe(before);
		mobile.plugin.settings.lastSyncedAt = 0;
		expect(await countWaitingOnDrive(mobile.plugin)).toBeUndefined();
	});
});

describe('the Pull check is opt-in and polite', () => {
	it('makes no request at all while the setting is off (the default)', async () => {
		const { desktop, mobile } = await setup();
		const { refreshWaitingBadge } = await badgeModule();
		await edit(desktop, 'Inbox/a.md', 'a2');
		await desktop.push();
		const before = netLog.length;
		await refreshWaitingBadge(mobile.plugin);
		expect(netLog.length).toBe(before);
		expect(mobile.plugin.waitingOnDrive).toBeUndefined();
	});

	it('shows the count on the Pull icon when it is on, and keeps the last number when the check fails', async () => {
		const { desktop, mobile } = await setup();
		const { refreshWaitingBadge } = await badgeModule();
		const push = icon();
		const pull = icon();
		mobile.plugin.ribbonIcon = push;
		mobile.plugin.pullRibbonIcon = pull;
		mobile.plugin.settings.pullBadge = true;
		await edit(desktop, 'Inbox/a.md', 'a2');
		await edit(desktop, 'Inbox/b.md', 'b2');
		await desktop.push();
		await refreshWaitingBadge(mobile.plugin);
		expect(mobile.plugin.waitingOnDrive).toBe(2);
		expect(shown(pull)).toBe('2');
		expect(pull.attrs['aria-label']).toBe('Pull from Google Drive (2 changes waiting on Google Drive)');

		mobile.plugin.settings.changesToken = '';
		await refreshWaitingBadge(mobile.plugin); // unknown: nothing is overwritten
		expect(shown(pull)).toBe('2');
	});

	it('does not run during a sync', async () => {
		const { mobile } = await setup();
		const { refreshWaitingBadge } = await badgeModule();
		mobile.plugin.settings.pullBadge = true;
		mobile.plugin.syncing = true;
		const before = netLog.length;
		await refreshWaitingBadge(mobile.plugin);
		expect(netLog.length).toBe(before);
		mobile.plugin.syncing = false;
	});

	it('a Pull sets the number back to 0', async () => {
		const { desktop, mobile } = await setup();
		const { refreshWaitingBadge } = await badgeModule();
		const pull = icon();
		mobile.plugin.pullRibbonIcon = pull;
		mobile.plugin.settings.pullBadge = true;
		await edit(desktop, 'Inbox/a.md', 'a2');
		await desktop.push();
		await refreshWaitingBadge(mobile.plugin);
		expect(shown(pull)).toBe('1');
		await mobile.pull();
		await sleep(30);
		expect(mobile.plugin.waitingOnDrive).toBe(0);
		expect(shown(pull)).toBe('');
	});
});

describe('the Push count on the icon', () => {
	it('follows the pending list, and the switch hides both counts', async () => {
		const { mobile } = await setup();
		const push = icon();
		const pull = icon();
		mobile.plugin.ribbonIcon = push;
		mobile.plugin.pullRibbonIcon = pull;
		mobile.plugin.settings.operations = { 'a.md': 'modify', 'b.md': 'create' };
		mobile.plugin.updateStatusBar();
		expect(shown(push)).toBe('2');
		expect(push.attrs['aria-label']).toBe('Push to Google Drive (2 changes waiting on this device)');
		mobile.plugin.settings.operations = {};
		mobile.plugin.updateStatusBar();
		expect(shown(push)).toBe('');
		expect(push.attrs['aria-label']).toBe('Push to Google Drive');

		mobile.plugin.settings.operations = { 'a.md': 'modify' };
		mobile.plugin.settings.ribbonBadges = false;
		mobile.plugin.updateStatusBar();
		expect(shown(push)).toBe('');
		mobile.plugin.settings.ribbonBadges = true;
		mobile.plugin.updateStatusBar();
		expect(shown(push)).toBe('1');
	});

	it('works with an ordinary ribbon element that cannot hold a badge (no crash)', async () => {
		const { mobile } = await setup();
		mobile.plugin.settings.operations = { 'a.md': 'modify' };
		expect(() => mobile.plugin.updateStatusBar()).not.toThrow();
	});
});
