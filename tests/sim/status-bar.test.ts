/** The status bar button: pending count, click menu, desktop only. */
import { describe, expect, it, vi } from 'vitest';
vi.stubGlobal('window', globalThis);
vi.mock('obsidian', async () => await import('./obsidian-mock'));
import { sleep } from './world';
import { setup } from './scenario-helpers';
import { TFile, Platform, lastMenu } from './obsidian-mock';
import { statusBarText, statusBarTooltip, installStatusBar } from '../../helpers/status-bar';

const bar = (d: any) => d.plugin.statusBarEls.at(-1);
const label = (d: any) => bar(d).children[1];
const click = (d: any) => bar(d).listeners.click({});
const titles = () => lastMenu.current!.items.map((i) => i.title ?? '---');

describe('status bar button', () => {
	it('is added once, shows "Drive" when nothing is pending', async () => {
		const { mobile } = await setup();
		expect(mobile.plugin.statusBarEls).toHaveLength(1);
		expect(bar(mobile).cls.has('mod-clickable')).toBe(true);
		expect(label(mobile).text).toBe('Drive');
		expect(bar(mobile).attrs['aria-label']).toContain('no pending changes');
	});

	it('shows the number of pending changes as you edit, and clears after Push', async () => {
		const { mobile } = await setup();
		await mobile.vault.modify(mobile.vault.getFileByPath('Inbox/a.md') as TFile, 'x');
		expect(label(mobile).text).toBe('Drive 1');
		await mobile.vault.create('new.md', 'n');
		expect(label(mobile).text).toBe('Drive 2');
		expect(bar(mobile).attrs['aria-label']).toContain('2 pending changes');
		await mobile.vault.delete(mobile.vault.getAbstractFileByPath('Inbox/b.md')!);
		expect(label(mobile).text).toBe('Drive 3');
		await sleep(20);
		await mobile.pull(); // something newer? no; just make sure Pull does not break the label
		await mobile.push();
		expect(label(mobile).text).toBe('Drive');
	});

	it('shows "Drive …" and a spinning icon while syncing', async () => {
		const { mobile } = await setup();
		mobile.plugin.setSpinning(true);
		expect(label(mobile).text).toBe('Drive …');
		expect(bar(mobile).children[0].cls.has('spin')).toBe(true);
		mobile.plugin.setSpinning(false);
		expect(label(mobile).text).toBe('Drive');
		expect(bar(mobile).children[0].cls.has('spin')).toBe(false);
	});

	it('a click opens the menu with every action', async () => {
		const { mobile } = await setup();
		await mobile.vault.modify(mobile.vault.getFileByPath('Inbox/a.md') as TFile, 'x');
		click(mobile);
		expect(titles()).toEqual([
			'1 pending change on this device',
			'---',
			'Pull from Google Drive',
			'Push to Google Drive',
			'---',
			'Sync doctor (read-only check)',
			'Restore the whole vault from history',
			'Create a restore point now',
		]);
		expect(lastMenu.current!.items[0]!.disabled).toBe(true);
	});

	it('the Pull menu entry pulls', async () => {
		const { desktop, mobile } = await setup();
		await desktop.vault.modify(desktop.vault.getFileByPath('Inbox/b.md') as TFile, 'desktop b');
		await sleep(20);
		await desktop.push();
		click(mobile);
		lastMenu.current!.items.find((i) => i.title === 'Pull from Google Drive')!.click!();
		await sleep(300);
		expect(new TextDecoder().decode(mobile.vault.disk.get('Inbox/b.md')!.data as Uint8Array)).toBe('desktop b');
	});

	it('nothing is added on the phone app (no status bar there)', async () => {
		const { mobile } = await setup();
		Platform.isMobile = true;
		try {
			expect(installStatusBar(mobile.plugin)).toBeUndefined();
			expect(mobile.plugin.statusBarEls).toHaveLength(1); // only the one from setup
		} finally {
			Platform.isMobile = false;
		}
	});

	it('a repeated onload (token entered in settings) replaces the button instead of adding a second', async () => {
		const { mobile } = await setup();
		const first = bar(mobile);
		await mobile.plugin.onload();
		expect(first.removed).toBe(true);
		expect(mobile.plugin.statusBarEls.filter((e: any) => !e.removed)).toHaveLength(1);
	});
});

describe('status bar text', () => {
	it('formats the label and tooltip', () => {
		expect(statusBarText(0, false)).toBe('Drive');
		expect(statusBarText(7, false)).toBe('Drive 7');
		expect(statusBarText(7, true)).toBe('Drive …');
		expect(statusBarTooltip(1, false)).toContain('1 pending change on');
		expect(statusBarTooltip(3, true)).toContain('running');
	});
});
