/**
 * 3.10.2: the settings page has a short basic part and an Advanced section that starts folded.
 * Nothing may get lost: every setting is in exactly one of the two parts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingDefinition, SettingDefinitionGroup, SettingDefinitionItem } from 'obsidian';
vi.stubGlobal('window', globalThis);
vi.mock('obsidian', async () => await import('./obsidian-mock'));
import { setup, ROOT } from './scenario-helpers';

const BASIC = [
	'Getting started',
	'Get refresh token',
	'Refresh token',
	'Sync now',
	'Pull when Obsidian starts',
	'Automatically push changes',
	'Move deleted files to Google Drive Trash',
];
/** Every stored setting that has a control on the page. None may disappear. */
const KEYS = [
	'refreshToken',
	'startupPull',
	'autoPush',
	'deleteToTrash',
	'ribbonBadges',
	'pullBadge',
	'ignorePatterns',
	'syncConfigFiles',
	'syncThemes',
	'syncSnippets',
	'historyEnabled',
	'historyRetentionDays',
	'accessTokenUrl',
	'clientId',
	'clientSecret',
	'enableDiagnostics',
	'maskFilePaths',
];

type Press = { click?: () => void; icon?: string; tip?: string };
const press = (group: SettingDefinitionGroup): Press => {
	const state: Press = {};
	const component = {
		setIcon: (icon: string) => ((state.icon = icon), component),
		setTooltip: (tip: string) => ((state.tip = tip), component),
		onClick: (cb: () => void) => ((state.click = cb), component),
	};
	group.extraButtons![0]!(component as never);
	return state;
};
const groups = (items: SettingDefinitionItem[]) =>
	items.filter((i): i is SettingDefinitionGroup => (i as SettingDefinitionGroup).type === 'group');
const named = (items: SettingDefinitionItem[]) =>
	items.filter((i) => (i as SettingDefinitionGroup).type !== 'group').map((i) => (i as SettingDefinition).name);
const keysOf = (items: unknown[]): string[] =>
	items.flatMap((i) => {
		const item = i as { control?: { key?: string }; items?: unknown[] };
		return [...(item.control?.key ? [item.control.key] : []), ...keysOf(item.items ?? [])];
	});

const open = async () => {
	const { desktop } = await setup();
	const { setAdvancedOpen, isAdvancedOpen } = await import(ROOT + '/helpers/advanced.ts');
	const { setCommandsOpen } = await import(ROOT + '/helpers/commands.ts');
	const tab = desktop.plugin.settingTab;
	const redraw = vi.spyOn(tab, 'update');
	return { tab, redraw, setAdvancedOpen, isAdvancedOpen, setCommandsOpen };
};

describe('the settings page', () => {
	beforeEach(async () => {
		const { setAdvancedOpen } = await import(ROOT + '/helpers/advanced.ts');
		const { setCommandsOpen } = await import(ROOT + '/helpers/commands.ts');
		setAdvancedOpen(false);
		setCommandsOpen(false);
	});

	it('shows only the basic settings by default, and an Advanced section that is folded', async () => {
		const { tab } = await open();
		const page: SettingDefinitionItem[] = tab.getSettingDefinitions();
		expect(named(page)).toEqual(BASIC);
		const [advanced, ...others] = groups(page);
		expect(others).toEqual([]); // no Commands section while Advanced is folded
		expect(advanced!.heading).toBe('Advanced');
		expect(advanced!.items).toHaveLength(1);
		expect((advanced!.items![0] as SettingDefinition).name).toBe('Advanced settings');
		expect(keysOf(page).sort()).toEqual(['autoPush', 'deleteToTrash', 'refreshToken', 'startupPull']);
		expect(press(advanced!)).toMatchObject({ icon: 'chevron-right', tip: 'Show the advanced settings' });
	});

	it('the arrow opens Advanced and draws the page again; then all other settings are there', async () => {
		const { tab, redraw, isAdvancedOpen } = await open();
		press(groups(tab.getSettingDefinitions())[0]!).click!();
		expect(isAdvancedOpen()).toBe(true);
		expect(redraw).toHaveBeenCalledTimes(1);
		const page: SettingDefinitionItem[] = tab.getSettingDefinitions();
		const [advanced, commands] = groups(page);
		expect(named(page)).toEqual(BASIC);
		expect(press(advanced!)).toMatchObject({ icon: 'chevron-down', tip: 'Hide the advanced settings' });
		expect(keysOf(page).sort()).toEqual([...KEYS].sort());
		const advancedNames = (advanced!.items as SettingDefinition[]).map((i) => i.name);
		for (const name of [
			'Show counts on the ribbon icons',
			'Ignore list',
			'Sync themes',
			'Version history',
			'End-to-end encryption',
			'Access token endpoint',
			'Diagnostics',
		]) {
			expect(advancedNames).toContain(name);
		}
		expect(advancedNames).not.toContain('Advanced settings');
		// the commands follow, still folded
		expect(commands!.heading).toBe('Commands');
		expect(commands!.items).toHaveLength(1); // only its card
		expect((commands!.items![0] as SettingDefinition).name).toBe('Commands');
	});

	it('every setting is in exactly one place (nothing lost, nothing twice)', async () => {
		const { tab, setAdvancedOpen } = await open();
		setAdvancedOpen(true);
		const keys = keysOf(tab.getSettingDefinitions());
		expect([...keys].sort()).toEqual([...KEYS].sort());
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('pressing the arrow again folds it, and the commands leave with it', async () => {
		const { tab, isAdvancedOpen, setAdvancedOpen } = await open();
		setAdvancedOpen(true);
		press(groups(tab.getSettingDefinitions())[0]!).click!();
		expect(isAdvancedOpen()).toBe(false);
		expect(groups(tab.getSettingDefinitions())).toHaveLength(1);
	});

	it('the Commands section keeps its own fold inside the open Advanced section', async () => {
		const { tab, setAdvancedOpen } = await open();
		setAdvancedOpen(true);
		press(groups(tab.getSettingDefinitions())[1]!).click!();
		const [, commands] = groups(tab.getSettingDefinitions());
		expect(commands!.items!.length).toBeGreaterThan(1);
	});

	it('the folded Advanced card opens it with a click anywhere or with Enter', async () => {
		const { tab, isAdvancedOpen, setAdvancedOpen } = await open();
		const fake = () => {
			const listeners: Record<string, ((e?: unknown) => void)[]> = {};
			const el: Record<string, unknown> = {
				empty: () => undefined,
				createDiv: () => fake(),
				addClass: () => undefined,
				setAttribute: () => undefined,
				addEventListener: (type: string, fn: (e?: unknown) => void) => (listeners[type] ??= []).push(fn),
				fire: (type: string, e?: unknown) => (listeners[type] ?? []).forEach((fn) => fn(e)),
			};
			return el as { fire: (type: string, e?: unknown) => void } & Record<string, unknown>;
		};
		const draw = () => {
			const settingEl = fake();
			(groups(tab.getSettingDefinitions())[0]!.items![0] as unknown as { render: (s: unknown) => void }).render({ settingEl });
			return settingEl;
		};
		draw().fire('click');
		expect(isAdvancedOpen()).toBe(true);
		setAdvancedOpen(false);
		draw().fire('keydown', { key: 'Enter', preventDefault: () => undefined });
		expect(isAdvancedOpen()).toBe(true);
	});
});
