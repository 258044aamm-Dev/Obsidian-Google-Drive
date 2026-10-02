/**
 * 3.13.3: the Drive check is on from the start for a NEW install only, and runs every 3 minutes unless the
 * user picks 1, 2, 5, 10 or 15 (it was fixed at 15 and off by default).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.stubGlobal('window', globalThis);
vi.mock('obsidian', async () => await import('./obsidian-mock'));
import { sleep } from './world';
import { setup, simDefaults, ROOT } from './scenario-helpers';

beforeEach(() => {
	simDefaults.deleteToTrash = true;
});
afterEach(() => vi.restoreAllMocks());

const badgeModule = () => import(ROOT + '/helpers/badge.ts');

/** The delay the plugin asks for when it starts its repeating check. */
const delayAfter = (plugin: any) => {
	const spy = vi.spyOn(globalThis, 'setInterval');
	plugin.restartWaitingTimer();
	const call = spy.mock.calls.at(-1)!;
	if (plugin.waitingTimer !== undefined) clearInterval(plugin.waitingTimer);
	return call[1];
};

describe('the Drive check on a new install and an existing one', () => {
	it('a new install (no saved data) starts with the check on, and saves it', async () => {
		const { mobile } = await setup();
		const p = mobile.plugin;
		let stored: any = null;
		p.loadData = async () => null;
		p.saveData = async (d: any) => {
			stored = JSON.parse(JSON.stringify(d));
		};
		await p.loadSettings();
		await sleep(10);
		expect(p.settings.pullBadge).toBe(true);
		expect(stored?.pullBadge).toBe(true);
	});

	it('an install already in use with no value keeps the check off', async () => {
		const { mobile } = await setup();
		const p = mobile.plugin;
		let saved = false;
		p.loadData = async () => ({ refreshToken: 'r' });
		p.saveData = async () => {
			saved = true;
		};
		await p.loadSettings();
		await sleep(10);
		expect(p.settings.pullBadge).toBeUndefined();
		expect(saved).toBe(false);
	});

	it('an explicit choice is kept, on or off', async () => {
		const { mobile } = await setup();
		const p = mobile.plugin;
		p.saveData = async () => {};
		for (const value of [true, false]) {
			p.loadData = async () => ({ refreshToken: 'r', pullBadge: value });
			await p.loadSettings();
			expect(p.settings.pullBadge).toBe(value);
		}
	});

	it('a check that is off still makes no request (the number stays unknown)', async () => {
		const { mobile } = await setup();
		const { refreshWaitingBadge } = await badgeModule();
		mobile.plugin.settings.pullBadge = undefined;
		await refreshWaitingBadge(mobile.plugin);
		expect(mobile.plugin.waitingOnDrive).toBeUndefined();
	});
});

describe('the time between two checks', () => {
	it('is 3 minutes when nothing is chosen', async () => {
		const { mobile } = await setup();
		delete mobile.plugin.settings.pullBadgeMinutes;
		expect(delayAfter(mobile.plugin)).toBe(3 * 60_000);
	});

	it('follows each choice, as text (how the settings page stores it) or as a number', async () => {
		const { mobile } = await setup();
		for (const minutes of [1, 2, 3, 5, 10, 15]) {
			mobile.plugin.settings.pullBadgeMinutes = String(minutes);
			expect(delayAfter(mobile.plugin)).toBe(minutes * 60_000);
			mobile.plugin.settings.pullBadgeMinutes = minutes;
			expect(delayAfter(mobile.plugin)).toBe(minutes * 60_000);
		}
	});

	it('falls back to 3 minutes for a value that is not a choice', async () => {
		const { mobile } = await setup();
		for (const bad of ['0', '-5', '4', 'soon', '', null, 99999]) {
			mobile.plugin.settings.pullBadgeMinutes = bad as any;
			expect(delayAfter(mobile.plugin)).toBe(3 * 60_000);
		}
	});

	it('changing the choice replaces the running timer (only one runs)', async () => {
		const { mobile } = await setup();
		const p = mobile.plugin;
		const clear = vi.spyOn(globalThis, 'clearInterval');
		p.settings.pullBadgeMinutes = '3';
		p.restartWaitingTimer();
		const first = p.waitingTimer;
		p.settings.pullBadgeMinutes = '1';
		p.restartWaitingTimer();
		expect(clear).toHaveBeenCalledWith(first);
		expect(p.waitingTimer).not.toBe(first);
		clearInterval(p.waitingTimer);
	});
});

describe('the setting on the settings page', () => {
	const find = (items: any[], key: string): any =>
		items.flatMap((i) => [i, ...(i.items ?? [])]).find((i) => i.control?.key === key);

	it('is a drop-down with the six choices and 3 minutes as the default', async () => {
		const { desktop } = await setup();
		const { setAdvancedOpen } = await import(ROOT + '/helpers/advanced.ts');
		setAdvancedOpen(true);
		const item = find(desktop.plugin.settingTab.getSettingDefinitions(), 'pullBadgeMinutes');
		setAdvancedOpen(false);
		expect(item.control.type).toBe('dropdown');
		expect(item.control.defaultValue).toBe('3');
		expect(Object.keys(item.control.options)).toEqual(['1', '2', '3', '5', '10', '15']);
	});

	it('choosing a time restarts the timer with it', async () => {
		const { desktop } = await setup();
		const p = desktop.plugin;
		const spy = vi.spyOn(globalThis, 'setInterval');
		p.settings.pullBadgeMinutes = '2';
		await p.settingTab.setControlValue('pullBadgeMinutes', '2');
		expect(spy.mock.calls.at(-1)![1]).toBe(2 * 60_000);
		clearInterval(p.waitingTimer);
	});
});
