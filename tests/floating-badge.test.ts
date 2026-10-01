/**
 * 3.11.0: the floating Push/Pull button for phones. A small fake DOM stands in for the page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('obsidian', async () => await import('./sim/obsidian-mock'));
import type ObsidianGoogleDrive from '../main';
import { FakeEl } from './sim/fake-dom';
import {
	FloatingBadge,
	LONG_PRESS_MS,
	MAX_Y,
	MIN_Y,
	clampY,
	isFloatVisible,
	parsePos,
	pullFloatLabel,
	pushFloatLabel,
	snapSide,
} from '../helpers/floating-badge';

const styleOf = (el: FakeEl, name: string) => el.store.get(name);

const setup = (opts: { isMobile?: boolean; settings?: Record<string, unknown>; operations?: Record<string, string>; keyboard?: boolean } = {}) => {
	const body = new FakeEl('body');
	const doc = { body };
	const viewportListeners: Record<string, (() => void)[]> = {};
	const win = {
		setTimeout: (fn: () => void, ms: number) => globalThis.setTimeout(fn, ms) as unknown as number,
		clearTimeout: (id?: number) => globalThis.clearTimeout(id),
		innerWidth: 400,
		innerHeight: 800,
		visualViewport: {
			height: opts.keyboard ? 300 : 800,
			addEventListener: (t: string, fn: () => void) => (viewportListeners[t] ??= []).push(fn),
			removeEventListener: (t: string, fn: () => void) => {
				viewportListeners[t] = (viewportListeners[t] ?? []).filter((f) => f !== fn);
			},
		},
	};
	const t = {
		settings: { operations: opts.operations ?? {}, ...(opts.settings ?? {}) },
		waitingOnDrive: undefined as number | undefined,
		syncing: false,
		debouncedSaveSettings: vi.fn(),
	} as unknown as ObsidianGoogleDrive;
	const handlers = { onPush: vi.fn(), onPull: vi.fn() };
	const badge = new FloatingBadge(t, handlers, { isMobile: opts.isMobile ?? true, doc: doc as never, win: win as never });
	const el = () => body.children[0];
	const part = (name: 'push' | 'pull') => el()!.children[name === 'push' ? 0 : 1]!;
	const shown = (name: 'push' | 'pull') => !part(name).classes.has('ogd-float-hide');
	return { badge, t, body, el, part, shown, handlers, win, viewportListeners };
};

describe('helpers', () => {
	it('clamps the height to the visible part of the screen and survives nonsense', () => {
		expect(clampY(-3)).toBe(MIN_Y);
		expect(clampY(5)).toBe(MAX_Y);
		expect(clampY(0.5)).toBe(0.5);
		expect(clampY(Number.NaN)).toBe(MAX_Y);
	});
	it('snaps to the nearer side', () => {
		expect(snapSide(10, 400)).toBe('left');
		expect(snapSide(199, 400)).toBe('left');
		expect(snapSide(200, 400)).toBe('right');
		expect(snapSide(390, 400)).toBe('right');
	});
	it('reads a saved position and refuses anything else', () => {
		expect(parsePos({ side: 'left', y: 0.4 })).toEqual({ side: 'left', y: 0.4 });
		expect(parsePos({ side: 'right', y: 9 })).toEqual({ side: 'right', y: MAX_Y });
		for (const bad of [undefined, null, 5, 'x', {}, { side: 'top', y: 0.1 }, { side: 'left' }, { side: 'left', y: 'a' }, { side: 'left', y: Number.NaN }]) {
			expect(parsePos(bad)).toBeUndefined();
		}
	});
	it('is visible only when something is waiting or a sync runs', () => {
		expect(isFloatVisible({ pending: 0, waiting: 0, busy: false })).toBe(false);
		expect(isFloatVisible({ pending: 1, waiting: 0, busy: false })).toBe(true);
		expect(isFloatVisible({ pending: 0, waiting: 2, busy: false })).toBe(true);
		expect(isFloatVisible({ pending: 0, waiting: 0, busy: true })).toBe(true);
	});
	it('labels say which side the changes are on', () => {
		expect(pushFloatLabel(1)).toBe('Push to Google Drive: 1 change waiting on this device');
		expect(pullFloatLabel(3)).toBe('Pull from Google Drive: 3 changes waiting on Google Drive');
	});
});

describe('what it shows', () => {
	it('does not exist on a desktop, whatever is pending', () => {
		const { badge, body } = setup({ isMobile: false, operations: { a: 'modify' } });
		badge.update();
		expect(body.children).toHaveLength(0);
	});

	it('does not exist when the user switched it off, and goes away when they do', () => {
		const { badge, body, t } = setup({ settings: { floatingBadge: false }, operations: { a: 'modify' } });
		badge.update();
		expect(body.children).toHaveLength(0);
		(t.settings as { floatingBadge?: boolean }).floatingBadge = undefined; // default: on
		badge.update();
		expect(body.children).toHaveLength(1);
		const el = body.children[0]!;
		(t.settings as { floatingBadge?: boolean }).floatingBadge = false;
		badge.update();
		expect(el.removed).toBe(true);
	});

	it('is hidden when nothing is waiting', () => {
		const { badge, el } = setup();
		badge.update();
		expect(el()!.classes.has('ogd-float-hide')).toBe(true);
	});

	it('shows the number of changes on this device on the up half, and nothing on the down half', () => {
		const { badge, el, part, shown, t } = setup({ operations: { a: 'modify', b: 'create', c: 'delete' } });
		badge.update();
		expect(el()!.classes.has('ogd-float-hide')).toBe(false);
		expect(shown('push')).toBe(true);
		expect(part('push').textContent).toBe('\u21913');
		expect(part('push').attrs['aria-label']).toBe(pushFloatLabel(3));
		expect(shown('pull')).toBe(false);
		(t as unknown as { waitingOnDrive: number }).waitingOnDrive = 4;
		badge.update();
		expect(shown('pull')).toBe(false); // the Drive check is off
	});

	it('shows the Drive side too when the Drive check is on, and both together', () => {
		const { badge, part, shown, t } = setup({ settings: { pullBadge: true }, operations: { a: 'modify' } });
		(t as unknown as { waitingOnDrive: number }).waitingOnDrive = 2;
		badge.update();
		expect(shown('push')).toBe(true);
		expect(shown('pull')).toBe(true);
		expect(part('pull').textContent).toBe('\u21932');
	});

	it('shows only the Drive side when only that is waiting', () => {
		const { badge, el, shown, t } = setup({ settings: { pullBadge: true } });
		(t as unknown as { waitingOnDrive: number }).waitingOnDrive = 7;
		badge.update();
		expect(el()!.classes.has('ogd-float-hide')).toBe(false);
		expect(shown('push')).toBe(false);
		expect(shown('pull')).toBe(true);
	});

	it('writes 99+ above 99', () => {
		const operations = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`n${i}`, 'modify']));
		const { badge, part } = setup({ operations });
		badge.update();
		expect(part('push').textContent).toBe('\u219199+');
	});

	it('shows a spinner instead of the numbers while a sync runs, and the numbers again afterwards', () => {
		const { badge, el, shown } = setup({ operations: { a: 'modify' } });
		badge.update(true);
		expect(el()!.classes.has('ogd-float-busy')).toBe(true);
		expect(el()!.children[2]!.classes.has('ogd-float-hide')).toBe(false);
		expect(shown('push')).toBe(false);
		badge.update(false);
		expect(el()!.classes.has('ogd-float-busy')).toBe(false);
		expect(el()!.children[2]!.classes.has('ogd-float-hide')).toBe(true);
		expect(shown('push')).toBe(true);
	});

	it('steps aside while the on-screen keyboard is open', () => {
		const { badge, el } = setup({ operations: { a: 'modify' }, keyboard: true });
		badge.update();
		expect(el()!.classes.has('ogd-float-hide')).toBe(true);
	});

	it('is removed completely when the plugin unloads', () => {
		const { badge, el, viewportListeners } = setup({ operations: { a: 'modify' } });
		badge.update();
		const node = el()!;
		expect(viewportListeners.resize).toHaveLength(1);
		badge.destroy();
		expect(node.removed).toBe(true);
		expect(viewportListeners.resize).toHaveLength(0);
		badge.destroy(); // twice is fine
	});
});

describe('tapping', () => {
	it('the up half pushes, the down half pulls', () => {
		const { badge, part, handlers, t } = setup({ settings: { pullBadge: true }, operations: { a: 'modify' } });
		(t as unknown as { waitingOnDrive: number }).waitingOnDrive = 1;
		badge.update();
		part('push').fire('click');
		expect(handlers.onPush).toHaveBeenCalledTimes(1);
		part('pull').fire('click');
		expect(handlers.onPull).toHaveBeenCalledTimes(1);
	});

	it('does nothing while a sync is running', () => {
		const { badge, part, handlers, t } = setup({ operations: { a: 'modify' } });
		badge.update();
		(t as unknown as { syncing: boolean }).syncing = true;
		part('push').fire('click');
		expect(handlers.onPush).not.toHaveBeenCalled();
	});
});

describe('moving it', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const draw = (opts = {}) => {
		const s = setup({ operations: { a: 'modify' }, ...opts });
		s.badge.update();
		return s;
	};

	it('starts at the bottom-right, above the phone\'s bottom bar', () => {
		const { el } = draw();
		expect(styleOf(el()!, 'right')).toContain('12px');
		expect(styleOf(el()!, 'bottom')).toContain('96px');
		expect(styleOf(el()!, 'top')).toBeUndefined();
		expect(styleOf(el()!, 'left')).toBeUndefined();
	});

	it('a quick tap is a tap, not a move', () => {
		const { el, part, handlers, t } = draw();
		el()!.fire('pointerdown', { clientX: 300, clientY: 700 });
		vi.advanceTimersByTime(LONG_PRESS_MS - 50);
		el()!.fire('pointerup');
		part('push').fire('click');
		expect(handlers.onPush).toHaveBeenCalledTimes(1);
		expect((t.settings as { floatingBadgePos?: unknown }).floatingBadgePos).toBeUndefined();
		vi.advanceTimersByTime(1000); // the hold timer was cancelled: no drag starts later
		expect(el()!.classes.has('ogd-float-drag')).toBe(false);
	});

	it('a finger that scrolls away before the hold is over never starts a drag', () => {
		const { el } = draw();
		el()!.fire('pointerdown', { clientX: 300, clientY: 700 });
		el()!.fire('pointermove', { clientX: 300, clientY: 650, preventDefault: vi.fn() });
		vi.advanceTimersByTime(LONG_PRESS_MS + 100);
		expect(el()!.classes.has('ogd-float-drag')).toBe(false);
	});

	it('press and hold, drag, drop: it snaps to the nearer side, the place is saved, and the drop is not a tap', () => {
		const { el, part, handlers, t } = draw();
		const node = el()!;
		node.rect = { left: 300, top: 700, width: 80, height: 40 };
		node.fire('pointerdown', { clientX: 320, clientY: 720 });
		vi.advanceTimersByTime(LONG_PRESS_MS + 10);
		expect(node.classes.has('ogd-float-drag')).toBe(true);
		const prevent = vi.fn();
		node.fire('pointermove', { clientX: 60, clientY: 200, preventDefault: prevent });
		expect(prevent).toHaveBeenCalled();
		expect(styleOf(node, 'left')).toBe('40px'); // finger minus where it grabbed the pill
		expect(styleOf(node, 'top')).toBe('180px');
		node.rect = { left: 40, top: 180, width: 80, height: 40 };
		node.fire('pointerup');
		expect(node.classes.has('ogd-float-drag')).toBe(false);
		expect((t.settings as { floatingBadgePos?: unknown }).floatingBadgePos).toEqual({ side: 'left', y: 180 / 800 });
		expect(t.debouncedSaveSettings).toHaveBeenCalled();
		expect(styleOf(node, 'left')).toContain('12px');
		expect(styleOf(node, 'top')).toBe('22.50%');
		expect(styleOf(node, 'right')).toBeUndefined();
		expect(styleOf(node, 'bottom')).toBeUndefined();
		part('push').fire('click'); // the click that ends the drag
		expect(handlers.onPush).not.toHaveBeenCalled();
		part('push').fire('click'); // the next one is a real tap
		expect(handlers.onPush).toHaveBeenCalledTimes(1);
	});

	it('keeps a dropped place at the right edge and inside the screen', () => {
		const { el, t } = draw();
		const node = el()!;
		node.fire('pointerdown', { clientX: 300, clientY: 700 });
		vi.advanceTimersByTime(LONG_PRESS_MS + 10);
		node.rect = { left: 330, top: 790, width: 80, height: 40 }; // dropped below the screen edge
		node.fire('pointerup');
		expect((t.settings as { floatingBadgePos?: { side: string; y: number } }).floatingBadgePos).toEqual({ side: 'right', y: MAX_Y });
	});

	it('uses a saved place when it is drawn, and ignores a broken one', () => {
		const saved = draw({ settings: { floatingBadgePos: { side: 'left', y: 0.3 } } });
		expect(styleOf(saved.el()!, 'top')).toBe('30.00%');
		expect(styleOf(saved.el()!, 'left')).toContain('12px');
		const broken = draw({ settings: { floatingBadgePos: { side: 'middle', y: 'x' } } });
		expect(styleOf(broken.el()!, 'bottom')).toContain('96px');
	});

	it('Reset position forgets the place and goes back to the corner', () => {
		const { badge, el, t } = draw({ settings: { floatingBadgePos: { side: 'left', y: 0.3 } } });
		badge.resetPosition();
		expect((t.settings as { floatingBadgePos?: unknown }).floatingBadgePos).toBeUndefined();
		expect(t.debouncedSaveSettings).toHaveBeenCalled();
		expect(styleOf(el()!, 'right')).toContain('12px');
		expect(styleOf(el()!, 'bottom')).toContain('96px');
		expect(styleOf(el()!, 'top')).toBeUndefined();
	});
});
