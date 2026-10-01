/**
 * 3.12.0: the Drive icon in the note header on phones. Tap it: Push and Pull, both always offered.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('obsidian', async () => await import('./obsidian-mock'));
import { lastMenu } from './obsidian-mock';
import {
	HeaderButton,
	headerCount,
	headerLabel,
	pullMenuLabel,
	pushMenuLabel,
	HEADER_ICON,
} from '../../helpers/header-button';

/** A header icon element as Obsidian's addAction returns it. */
const makeEl = () => {
	const el: any = {
		classes: new Set<string>(),
		attrs: {} as Record<string, string>,
		kids: [] as any[],
		removed: false,
		addClass: (c: string) => el.classes.add(c),
		removeClass: (c: string) => el.classes.delete(c),
		setAttribute: (k: string, v: string) => (el.attrs[k] = v),
		remove: () => (el.removed = true),
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

const makeView = () => {
	const view: any = { added: [] as any[] };
	view.addAction = (icon: string, title: string, cb: (e: any) => void) => {
		const el = makeEl();
		view.added.push({ icon, title, cb, el });
		return el;
	};
	return view;
};

const setup = (opts: { views?: any[]; settings?: Record<string, unknown> } = {}) => {
	const handlers: Record<string, () => void> = {};
	const views = opts.views ?? [makeView()];
	const t: any = {
		settings: { operations: {}, ...opts.settings },
		waitingOnDrive: undefined,
		syncing: false,
		registerEvent: (x: unknown) => x,
		app: {
			workspace: {
				on: (name: string, fn: () => void) => ((handlers[name] = fn), {}),
				iterateAllLeaves: (cb: (leaf: any) => void) => views.forEach((view) => cb({ view })),
			},
		},
	};
	const calls = { push: 0, pull: 0 };
	const header = new HeaderButton(t, { onPush: () => calls.push++, onPull: () => calls.pull++ }, { isMobile: true });
	return { t, header, views, handlers, calls };
};
const ops = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}.md`, {}]));

afterEach(() => {
	lastMenu.current = undefined;
});

describe('the texts', () => {
	it('say what is waiting, and the number adds both sides', () => {
		expect(pushMenuLabel(0)).toBe('Push to Google Drive');
		expect(pushMenuLabel(3)).toContain('3 waiting on this device');
		expect(pullMenuLabel(undefined)).toBe('Pull from Google Drive');
		expect(pullMenuLabel(0)).toBe('Pull from Google Drive');
		expect(pullMenuLabel(2)).toContain('2 waiting on Google Drive');
		expect(headerCount(3, 2)).toBe(5);
		expect(headerCount(3, undefined)).toBe(3);
		expect(headerCount(0, undefined)).toBe(0);
		expect(headerLabel(0, undefined)).not.toMatch(/waiting/);
		expect(headerLabel(1, undefined)).toContain('1 change waiting');
	});
});

describe('the icon in the header', () => {
	it('is added to every open view, once, with the right icon', () => {
		const { header, views } = setup({ views: [makeView(), makeView()] });
		header.start();
		header.refresh();
		header.refresh();
		for (const v of views) {
			expect(v.added).toHaveLength(1);
			expect(v.added[0].icon).toBe(HEADER_ICON);
		}
	});

	it('is added to a view opened later, when the layout changes', () => {
		const { header, views, handlers } = setup();
		header.start();
		const later = makeView();
		views.push(later);
		handlers['layout-change']!();
		expect(later.added).toHaveLength(1);
		expect(views[0].added).toHaveLength(1);
	});

	it('skips views that cannot take a header icon', () => {
		const { header } = setup({ views: [{}, undefined, makeView()] });
		expect(() => header.start()).not.toThrow();
	});

	it('shows no number when nothing waits, then the changes of this device, then Drive\'s too', () => {
		const { header, t, views } = setup();
		header.start();
		const el = views[0].added[0].el;
		expect(shown(el)).toBe('');
		t.settings.operations = ops(3);
		header.update();
		expect(shown(el)).toBe('3');
		t.waitingOnDrive = 2;
		header.update();
		expect(shown(el)).toBe('5');
		expect(el.attrs['aria-label']).toContain('5 changes waiting');
		t.settings.operations = {};
		t.waitingOnDrive = undefined;
		header.update();
		expect(shown(el)).toBe('');
	});

	it('shows no number when the ribbon counts are switched off', () => {
		const { header, views } = setup({ settings: { operations: ops(2), ribbonBadges: false } });
		header.start();
		expect(shown(views[0].added[0].el)).toBe('');
	});

	it('turns during a sync, and keeps that state when update() is called without it', () => {
		const { header, views } = setup();
		header.start();
		const el = views[0].added[0].el;
		header.update(true);
		expect(el.classes.has('spin')).toBe(true);
		header.update();
		expect(el.classes.has('spin')).toBe(true);
		header.update(false);
		expect(el.classes.has('spin')).toBe(false);
	});

	it('starts with the current numbers on a view added later', () => {
		const { header, views, t, handlers } = setup({ settings: { operations: ops(4) } });
		header.start();
		const later = makeView();
		views.push(later);
		handlers['active-leaf-change']!();
		expect(shown(later.added[0].el)).toBe('4');
		void t;
	});
});

describe('the menu', () => {
	const open = (s: ReturnType<typeof setup>) => {
		s.header.start();
		s.views[0].added[0].cb({});
		return lastMenu.current!;
	};

	it('opens when the icon is tapped, with Push and Pull both offered', () => {
		const menu = open(setup());
		expect(menu.items.map((i) => i.title)).toEqual(['Push to Google Drive', 'Pull from Google Drive']);
		expect(menu.items.every((i) => !i.disabled)).toBe(true);
	});

	it('Push does the push and Pull does the pull, and nothing else', () => {
		const s = setup();
		const menu = open(s);
		menu.items[0]!.click!();
		expect(s.calls).toEqual({ push: 1, pull: 0 });
		menu.items[1]!.click!();
		expect(s.calls).toEqual({ push: 1, pull: 1 });
	});

	it('shows the counts in the rows when they are known', () => {
		const s = setup({ settings: { operations: ops(3) } });
		s.t.waitingOnDrive = 2;
		const menu = open(s);
		expect(menu.items[0]!.title).toContain('3 waiting on this device');
		expect(menu.items[1]!.title).toContain('2 waiting on Google Drive');
	});

	it('offers Pull even when the Drive check is off and nothing is known', () => {
		const s = setup({ settings: { operations: ops(1), pullBadge: false } });
		const menu = open(s);
		expect(menu.items[1]!.title).toBe('Pull from Google Drive');
		expect(menu.items[1]!.disabled).toBe(false);
	});

	it('greys both rows out while a sync runs', () => {
		const s = setup();
		s.t.syncing = true;
		const menu = open(s);
		expect(menu.items.map((i) => i.disabled)).toEqual([true, true]);
	});
});

describe('switched off, a desktop, and unloading', () => {
	it('adds nothing on a desktop', () => {
		const s = setup();
		const t = s.t;
		const header = new HeaderButton(t, { onPush() {}, onPull() {} }, { isMobile: false });
		header.start();
		header.refresh();
		header.update(true);
		expect(s.views[0].added).toHaveLength(0);
	});

	it('adds nothing while the switch is off, and takes the icon away when it is turned off', () => {
		const off = setup({ settings: { headerButton: false } });
		off.header.start();
		expect(off.views[0].added).toHaveLength(0);

		const on = setup();
		on.header.start();
		const el = on.views[0].added[0].el;
		on.t.settings.headerButton = false;
		on.header.update();
		expect(el.removed).toBe(true);
		on.t.settings.headerButton = true;
		on.header.refresh();
		expect(on.views[0].added).toHaveLength(2);
	});

	it('takes the icon away when the plugin unloads', () => {
		const s = setup();
		s.header.start();
		const el = s.views[0].added[0].el;
		s.header.destroy();
		expect(el.removed).toBe(true);
	});

	it('never throws, even when the workspace is odd', () => {
		const s = setup();
		s.t.app.workspace.iterateAllLeaves = () => {
			throw new Error('boom');
		};
		expect(() => s.header.start()).not.toThrow();
		expect(() => s.header.update(true)).not.toThrow();
		const bare = setup();
		bare.t.app.workspace = {};
		expect(() => new HeaderButton(bare.t, { onPush() {}, onPull() {} }, { isMobile: true }).refresh()).not.toThrow();
	});
});
