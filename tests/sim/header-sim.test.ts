/**
 * 3.12.0: the header icon follows a real plugin on a phone: edit a note and the number appears on the
 * icon, Push from its menu and it is gone, and the settings page offers its switch only on a phone.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.stubGlobal('window', globalThis);
vi.mock('obsidian', async () => await import('./obsidian-mock'));
import { Platform, lastMenu } from './obsidian-mock';

// The menu runs the plugin's own push() and pull(). Their windows need a real screen, so while `spy.on`
// is set they are only recorded; otherwise (the harness's own Push and Pull) the real ones run.
const spy = vi.hoisted(() => ({ on: false, push: 0, pull: 0 }));
vi.mock('../../helpers/push', async (orig) => {
	const real: any = await orig();
	return { ...real, push: (...a: unknown[]) => (spy.on ? (spy.push++, Promise.resolve()) : real.push(...a)) };
});
vi.mock('../../helpers/pull', async (orig) => {
	const real: any = await orig();
	return { ...real, pull: (...a: unknown[]) => (spy.on ? (spy.pull++, Promise.resolve()) : real.pull(...a)) };
});
import { sleep } from './world';
import { setup } from './scenario-helpers';

afterEach(() => {
	Platform.isMobile = false;
	spy.on = false;
	spy.push = spy.pull = 0;
	lastMenu.current = undefined;
});

const edit = async (d: any, path: string, text: string) => {
	await d.vault.modify(d.vault.getFileByPath(path), text);
	await sleep(20);
};

/** An open note: its header takes icons, as in Obsidian. */
const note = () => {
	const icons: any[] = [];
	const view = {
		icons,
		addAction: (icon: string, title: string, cb: (e: any) => void) => {
			const el: any = {
				cls: new Set<string>(),
				attrs: {} as Record<string, string>,
				kids: [] as any[],
				addClass: (c: string) => el.cls.add(c),
				removeClass: (c: string) => el.cls.delete(c),
				setAttribute: (k: string, v: string) => (el.attrs[k] = v),
				remove: () => (el.removed = true),
				createSpan: (o: { cls: string }) => {
					const kid: any = { cls: new Set([o.cls]), text: '', setText: (t: string) => (kid.text = t), addClass: (c: string) => kid.cls.add(c), removeClass: (c: string) => kid.cls.delete(c) };
					el.kids.push(kid);
					return kid;
				},
				querySelector: () => el.kids[0] ?? null,
			};
			icons.push({ icon, title, cb, el });
			return el;
		},
	};
	return view;
};
const number = (el: any) => (el.kids[0] && !el.kids[0].cls.has('ogd-badge-hidden') ? el.kids[0].text : '');

/** Starts the phone with one open note. */
const phone = async () => {
	Platform.isMobile = true;
	const world = await setup();
	const view = note();
	world.mobile.plugin.app.workspace.iterateAllLeaves = (cb: (leaf: any) => void) => cb({ view });
	// the plugin was started before the note existed: Obsidian then reports a layout change
	world.mobile.plugin.header.refresh();
	return { ...world, view };
};

describe('the header icon on a phone', () => {
	it('shows the changes made on the phone, and is cleared after a Push', async () => {
		const { mobile, view } = await phone();
		expect(view.icons).toHaveLength(1);
		const el = view.icons[0]!.el;
		expect(number(el)).toBe('');
		await edit(mobile, 'Inbox/a.md', 'a2');
		await edit(mobile, 'root.md', 'r2');
		expect(number(el)).toBe('2');
		await mobile.push();
		expect(number(el)).toBe('');
	});

	it('Push and Pull in its menu run the plugin\'s Push and Pull, and not while a sync runs', async () => {
		const { mobile, view } = await phone();
		spy.on = true;
		await edit(mobile, 'Inbox/a.md', 'from the phone');
		view.icons[0]!.cb({});
		const menu = lastMenu.current!;
		expect(menu.items.map((i) => i.title?.split(' (')[0])).toEqual(['Push to Google Drive', 'Pull from Google Drive']);
		expect(menu.items[0]!.title).toContain('1 waiting on this device');
		menu.items[0]!.click!();
		expect(spy).toMatchObject({ push: 1, pull: 0 });
		menu.items[1]!.click!();
		expect(spy).toMatchObject({ push: 1, pull: 1 });
		mobile.plugin.syncing = true;
		menu.items[0]!.click!();
		menu.items[1]!.click!();
		expect(spy).toMatchObject({ push: 1, pull: 1 });
		mobile.plugin.syncing = false;
	});

	it('is added on a desktop too, with the same number', async () => {
		const { mobile } = await setup();
		expect(Platform.isMobile).toBe(false);
		const view = note();
		mobile.plugin.app.workspace.iterateAllLeaves = (cb: (leaf: any) => void) => cb({ view });
		mobile.plugin.header.refresh();
		expect(view.icons).toHaveLength(1);
		await edit(mobile, 'Inbox/a.md', 'a2');
		expect(number(view.icons[0]!.el)).toBe('1');
	});

	it('can be switched off, and is taken away at once', async () => {
		const { mobile, view } = await phone();
		mobile.plugin.settings.headerButton = false;
		mobile.plugin.updateBadges();
		expect(view.icons[0]!.el.removed).toBe(true);
	});

	it('is removed when the plugin unloads', async () => {
		const { mobile, view } = await phone();
		mobile.plugin.onunload();
		expect(view.icons[0]!.el.removed).toBe(true);
	});

	it('the settings page offers its switch on a desktop and on a phone, and no floating-button settings', async () => {
		const { mobile } = await setup();
		const { setAdvancedOpen } = await import('../../helpers/advanced');
		setAdvancedOpen(true);
		const keys = (items: any[]): string[] => items.flatMap((i) => [i.control?.key, ...keys(i.items ?? [])]).filter(Boolean);
		for (const isMobile of [false, true]) {
			Platform.isMobile = isMobile;
			const k = keys(mobile.plugin.settingTab.getSettingDefinitions());
			expect(k).toContain('headerButton');
			expect(k).not.toContain('floatingBadge');
		}
		setAdvancedOpen(false);
	});
});
