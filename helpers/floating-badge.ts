/**
 * A small floating button for phones and tablets (3.11.0).
 *
 * On a phone the ribbon is hidden in a menu, so the counts on the Push and Pull icons (3.9.0) are
 * never in sight. This pill stays on screen instead and shows the same two numbers:
 *   ↑N  changes made on this device that Google Drive does not have yet (tap: Push)
 *   ↓N  changes waiting on Google Drive (tap: Pull; only with "Check Google Drive for waiting changes")
 * A half only shows while its number is above 0, and nothing shows when nothing is waiting. While a
 * sync runs it shows a spinner, and it steps aside while the on-screen keyboard is open.
 *
 * It can be moved: press and hold, then drag. It snaps to the nearest side and the place is remembered
 * on this device. Everything it does is also done by the ribbon icons; it only makes them visible.
 */
import type ObsidianGoogleDrive from '../main';
import { badgeText } from './badge';

/** Where the pill sits after the user moved it: on which side, and how far down (0 = top, 1 = bottom of the screen). */
export interface FloatPos {
	side: 'left' | 'right';
	y: number;
}

export const MIN_Y = 0.04;
export const MAX_Y = 0.88;
/** Press and hold this long before a drag starts (a quick tap is a tap). */
export const LONG_PRESS_MS = 350;
/** A finger that moves further than this before the hold is over is scrolling, not holding. */
export const MOVE_TOLERANCE_PX = 10;
/** The on-screen keyboard is open when the visible area is this much smaller than the window. */
export const KEYBOARD_RATIO = 0.75;

export const clampY = (y: number) => Math.min(MAX_Y, Math.max(MIN_Y, Number.isFinite(y) ? y : MAX_Y));

/** The side the pill snaps to, from where the middle of it was dropped. */
export const snapSide = (centerX: number, viewportWidth: number): 'left' | 'right' =>
	centerX < viewportWidth / 2 ? 'left' : 'right';

/** A saved position, or undefined when there is none or it is not usable. */
export const parsePos = (value: unknown): FloatPos | undefined => {
	if (!value || typeof value !== 'object') return undefined;
	const { side, y } = value as { side?: unknown; y?: unknown };
	if ((side !== 'left' && side !== 'right') || typeof y !== 'number' || !Number.isFinite(y)) return undefined;
	return { side, y: clampY(y) };
};

export interface FloatState {
	pending: number;
	waiting: number;
	busy: boolean;
}

/** Is there anything to show? */
export const isFloatVisible = ({ pending, waiting, busy }: FloatState) => busy || pending > 0 || waiting > 0;

export const pushFloatLabel = (count: number) =>
	`Push to Google Drive: ${count} change${count === 1 ? '' : 's'} waiting on this device`;
export const pullFloatLabel = (count: number) =>
	`Pull from Google Drive: ${count} change${count === 1 ? '' : 's'} waiting on Google Drive`;

export interface FloatHandlers {
	onPush: () => void;
	onPull: () => void;
}

export interface FloatEnv {
	isMobile: boolean;
	doc?: Document;
	win?: Window;
}

export class FloatingBadge {
	private el?: HTMLElement;
	private pushBtn?: HTMLElement;
	private pullBtn?: HTMLElement;
	private spinner?: HTMLElement;
	private holdTimer?: number;
	private dragging = false;
	private justDragged = false;
	private downX = 0;
	private downY = 0;
	private grabX = 0;
	private grabY = 0;
	private readonly onViewport = () => this.update();

	constructor(
		private readonly t: ObsidianGoogleDrive,
		private readonly handlers: FloatHandlers,
		private readonly env: FloatEnv,
	) {}

	private get doc() {
		return this.env.doc ?? document;
	}
	private get win() {
		return this.env.win ?? window;
	}

	/** The button exists on phones and tablets, unless the user switched it off. */
	enabled() {
		return (
			this.env.isMobile &&
			this.t.settings.floatingBadge !== false &&
			(!!this.env.doc || typeof document !== 'undefined')
		);
	}

	private keyboardOpen() {
		const viewport = this.win.visualViewport;
		return !!viewport && viewport.height < this.win.innerHeight * KEYBOARD_RATIO;
	}

	state(busy = this.t.syncing): FloatState {
		return {
			pending: Object.keys(this.t.settings.operations).length,
			waiting: this.t.settings.pullBadge === true ? (this.t.waitingOnDrive ?? 0) : 0,
			busy: !!busy,
		};
	}

	/** Draws the current numbers (and creates or removes the button when the setting changed). */
	update(busy?: boolean) {
		try {
			this.draw(busy);
		} catch {
			// a button that cannot be drawn must never get in the way of a sync
		}
	}

	private draw(busy?: boolean) {
		if (!this.enabled()) {
			this.destroy();
			return;
		}
		this.ensure();
		const state = this.state(busy);
		const el = this.el as HTMLElement;
		const hidden = !isFloatVisible(state) || this.keyboardOpen();
		el.classList.toggle('ogd-float-hide', hidden);
		el.classList.toggle('ogd-float-busy', state.busy);
		(this.spinner as HTMLElement).classList.toggle('ogd-float-hide', !state.busy);
		const showPush = !state.busy && state.pending > 0;
		const showPull = !state.busy && state.waiting > 0;
		const push = this.pushBtn as HTMLElement;
		const pull = this.pullBtn as HTMLElement;
		push.classList.toggle('ogd-float-hide', !showPush);
		pull.classList.toggle('ogd-float-hide', !showPull);
		push.textContent = `\u2191${badgeText(state.pending)}`;
		pull.textContent = `\u2193${badgeText(state.waiting)}`;
		push.setAttribute('aria-label', pushFloatLabel(state.pending));
		pull.setAttribute('aria-label', pullFloatLabel(state.waiting));
		if (!this.dragging) this.place();
	}

	/** Puts the pill where the user left it, or at the default place (bottom-right, above the phone's bottom bar). */
	private place() {
		const el = this.el as HTMLElement;
		const pos = parsePos(this.t.settings.floatingBadgePos);
		const edge = 'calc(env(safe-area-inset-left, 0px) + 12px)';
		const edgeRight = 'calc(env(safe-area-inset-right, 0px) + 12px)';
		// an empty value takes the property away again
		if (!pos) {
			el.setCssProps({ left: '', top: '', right: edgeRight, bottom: 'calc(env(safe-area-inset-bottom, 0px) + 96px)' });
			return;
		}
		el.setCssProps({
			bottom: '',
			top: `${(pos.y * 100).toFixed(2)}%`,
			left: pos.side === 'left' ? edge : '',
			right: pos.side === 'right' ? edgeRight : '',
		});
	}

	/** Back to the default place. */
	resetPosition() {
		delete this.t.settings.floatingBadgePos;
		this.t.debouncedSaveSettings();
		if (this.el) this.place();
	}

	private ensure() {
		if (this.el) return;
		const el = this.doc.body.createDiv({ cls: 'ogd-float' });
		el.setAttribute('role', 'group');
		el.setAttribute('aria-label', 'Google Drive sync');
		const push = el.createEl('button', { cls: ['ogd-float-part', 'ogd-float-push', 'ogd-float-hide'] });
		const pull = el.createEl('button', { cls: ['ogd-float-part', 'ogd-float-pull', 'ogd-float-hide'] });
		const spinner = el.createSpan({ cls: ['ogd-float-spinner', 'ogd-float-hide'], text: '\u21BB' });
		spinner.setAttribute('aria-label', 'Syncing with Google Drive');
		push.addEventListener('click', () => this.tap(this.handlers.onPush));
		pull.addEventListener('click', () => this.tap(this.handlers.onPull));
		el.addEventListener('pointerdown', (event) => this.down(event));
		el.addEventListener('pointermove', (event) => this.move(event));
		el.addEventListener('pointerup', () => this.up());
		el.addEventListener('pointercancel', () => this.up());
		el.addEventListener('contextmenu', (event) => event.preventDefault());
		this.el = el;
		this.pushBtn = push;
		this.pullBtn = pull;
		this.spinner = spinner;
		this.win.visualViewport?.addEventListener('resize', this.onViewport);
	}

	private tap(action: () => void) {
		if (this.justDragged) {
			this.justDragged = false; // the click that ends a drag is not a tap
			return;
		}
		if (this.t.syncing) return;
		action();
	}

	private down(event: PointerEvent) {
		this.justDragged = false;
		this.downX = event.clientX;
		this.downY = event.clientY;
		this.win.clearTimeout(this.holdTimer);
		this.holdTimer = this.win.setTimeout(() => this.startDrag(), LONG_PRESS_MS);
	}

	private startDrag() {
		const el = this.el;
		if (!el) return;
		this.dragging = true;
		const rect = el.getBoundingClientRect();
		this.grabX = this.downX - rect.left;
		this.grabY = this.downY - rect.top;
		el.classList.add('ogd-float-drag');
	}

	private move(event: PointerEvent) {
		if (!this.dragging) {
			// A finger that wanders off before the hold is over is scrolling: no drag.
			if (this.holdTimer !== undefined && Math.hypot(event.clientX - this.downX, event.clientY - this.downY) > MOVE_TOLERANCE_PX) {
				this.win.clearTimeout(this.holdTimer);
				this.holdTimer = undefined;
			}
			return;
		}
		event.preventDefault();
		const el = this.el as HTMLElement;
		el.setCssProps({
			right: 'auto',
			bottom: 'auto',
			left: `${event.clientX - this.grabX}px`,
			top: `${event.clientY - this.grabY}px`,
		});
	}

	private up() {
		this.win.clearTimeout(this.holdTimer);
		this.holdTimer = undefined;
		if (!this.dragging) return;
		this.dragging = false;
		this.justDragged = true;
		const el = this.el as HTMLElement;
		el.classList.remove('ogd-float-drag');
		const rect = el.getBoundingClientRect();
		const win = this.win;
		this.t.settings.floatingBadgePos = {
			side: snapSide(rect.left + rect.width / 2, win.innerWidth),
			y: clampY(rect.top / Math.max(1, win.innerHeight)),
		};
		this.t.debouncedSaveSettings();
		this.place();
	}

	destroy() {
		this.win.clearTimeout(this.holdTimer);
		if (!this.el) return;
		this.win.visualViewport?.removeEventListener('resize', this.onViewport);
		this.el?.remove();
		this.el = this.pushBtn = this.pullBtn = this.spinner = undefined;
		this.dragging = false;
	}
}
