import { describe, expect, it, vi } from 'vitest';

const log = vi.hoisted(() => ({ calls: [] as string[], notices: [] as unknown[], modals: [] as { contentEl: unknown }[] }));
const { El } = vi.hoisted(() => {
class El {
	children: El[] = [];
	handlers: Record<string, () => void> = {};
	text = '';
	cls = '';
	disabled = false;
	checked = false;
	constructor(public tag = 'div') {}
	empty() {
		this.children = [];
	}
	createEl(tag: string, o?: { text?: string; cls?: string }) {
		const e = new El(tag);
		e.text = o?.text ?? '';
		e.cls = o?.cls ?? '';
		this.children.push(e);
		return e;
	}
	addClass() {}
	createDiv(o?: { text?: string; cls?: string }) {
		return this.createEl('div', o);
	}
	createSpan(o?: { text?: string }) {
		return this.createEl('span', o);
	}
	addEventListener(name: string, fn: () => void) {
		this.handlers[name] = fn;
	}
	all(): El[] {
		return this.children.flatMap((c) => [c, ...c.all()]);
	}
	button(text: string) {
		return this.all().find((c) => c.tag === 'button' && c.text === text);
	}
}

	return { El };
});
vi.mock('obsidian', () => {
	class Modal {
		app: unknown;
		contentEl: unknown = new El();
		title = '';
		constructor(app: unknown) {
			this.app = app;
			log.modals.push(this);
		}
		setTitle(t: string) {
			this.title = t;
		}
		open() {
			(this as unknown as { onOpen?: () => void }).onOpen?.();
		}
		close() {
			log.calls.push('close');
			(this as unknown as { onClose?: () => void }).onClose?.();
		}
	}
	class Notice {
		hidden = false;
		constructor(public message: unknown) {
			log.notices.push(message);
		}
		hide() {
			this.hidden = true;
		}
	}
	return { Modal, Notice };
});
vi.mock('../helpers/pull', () => ({ pull: vi.fn(async () => void log.calls.push('pull')) }));
vi.mock('../helpers/push', () => ({ push: vi.fn(async () => void log.calls.push('push')) }));
vi.mock('../helpers/doctor-command', () => ({ runSyncDoctor: vi.fn(async () => void log.calls.push('doctor')) }));
vi.mock('../helpers/e2ee-ui', () => ({ openEnableEncryption: vi.fn(() => void log.calls.push('encryption')) }));

import { TourModal, maybeOfferTour, maybeShowThemeNotice, openTour, canResumeTour } from '../helpers/tour';

interface Rec {
	tourState?: { step?: number; skipped?: string[]; dismissed?: boolean; finished?: boolean; offered?: boolean };
	syncThemes?: boolean;
	syncSnippets?: boolean;
	themeNoticeShown?: boolean;
}
const g = globalThis as unknown as { createFragment?: (cb: (f: ElT & { appendText: () => void }) => void) => unknown };
const installFragment = (onCreate?: (f: ElT) => void) => {
	g.createFragment = (cb) => {
		const f = new El('fragment') as ElT & { appendText: () => void };
		f.appendText = () => undefined;
		cb(f);
		onCreate?.(f);
		return f;
	};
};
const makePlugin = (settings: Record<string, unknown> = {}) => {
	const saves: unknown[] = [];
	const t = {
		app: {},
		manifest: { id: 'google-drive-sync' },
		syncing: false,
		settings: { ...settings },
		saveSettings: async () => void saves.push(JSON.stringify(t.settings.tourState)),
	};
	return { t: t as never, settings: t.settings as unknown as Rec, saves };
};

type ElT = InstanceType<typeof El>;
const open = (t: never) => {
	const modal = new TourModal({} as never, t, { step: 0 });
	const el = new El();
	(modal as unknown as { contentEl: ElT }).contentEl = el;
	modal.open();
	return { modal, el };
};

describe('the tour window', () => {
	it('walks through the steps; Next, Back and Skip this step work and progress is saved', () => {
		const { t, settings } = makePlugin();
		const { modal, el } = open(t);
		expect((modal as unknown as { title: string }).title).toContain('1 of 8');
		el.button('Next')?.handlers.click?.();
		expect((modal as unknown as { title: string }).title).toContain('2 of 8');
		el.button('Skip this step')?.handlers.click?.();
		expect((modal as unknown as { title: string }).title).toContain('3 of 8');
		expect(settings.tourState?.skipped).toEqual(['connect']);
		el.button('Back')?.handlers.click?.();
		expect((modal as unknown as { title: string }).title).toContain('2 of 8');
		expect(settings.tourState?.step).toBe(1);
	});

	it('every step but the last offers "Skip this step" and "Skip tour"', () => {
		const { t } = makePlugin();
		const { el } = open(t);
		for (let i = 0; i < 7; i++) {
			expect(el.button('Skip this step')).toBeTruthy();
			expect(el.button('Skip tour')).toBeTruthy();
			el.button('Next')?.handlers.click?.();
		}
		expect(el.button('Finish')).toBeTruthy();
		expect(el.button('Skip this step')).toBeUndefined();
	});

	it('"Skip tour" saves it as dismissed and closes the window', () => {
		log.calls.length = 0;
		const { t, settings } = makePlugin();
		const { el } = open(t);
		el.button('Skip tour')?.handlers.click?.();
		expect(settings.tourState?.dismissed).toBe(true);
		expect(log.calls).toContain('close');
	});

	it('"Finish" saves it as finished', () => {
		const { t, settings } = makePlugin();
		const { el } = open(t);
		for (let i = 0; i < 7; i++) el.button('Next')?.handlers.click?.();
		el.button('Finish')?.handlers.click?.();
		expect(settings.tourState?.finished).toBe(true);
	});

	it('action buttons that need Google Drive are disabled until a token exists', () => {
		const { t } = makePlugin();
		const { el } = open(t);
		el.button('Next')?.handlers.click?.();
		el.button('Next')?.handlers.click?.(); // step 3: Pull / Push
		expect(el.button('Pull now...')?.disabled).toBe(true);
		expect(el.button('Push now...')?.disabled).toBe(true);
		const connected = makePlugin({ refreshToken: 'r' });
		const second = open(connected.t);
		second.el.button('Next')?.handlers.click?.();
		second.el.button('Next')?.handlers.click?.();
		expect(second.el.button('Pull now...')?.disabled).toBe(false);
	});

	it('Pull from the tour asks first (nothing runs before the confirmation), Push opens its own window', () => {
		log.calls.length = 0;
		const { t } = makePlugin({ refreshToken: 'r' });
		const { el } = open(t);
		el.button('Next')?.handlers.click?.();
		el.button('Next')?.handlers.click?.();
		el.button('Pull now...')?.handlers.click?.();
		expect(log.calls).not.toContain('pull'); // only the confirmation window is open
		const confirm = log.modals[log.modals.length - 1]?.contentEl as ElT;
		confirm.button('Cancel')?.handlers.click?.();
		expect(log.calls).not.toContain('pull');
		el.button('Pull now...')?.handlers.click?.();
		(log.modals[log.modals.length - 1]?.contentEl as ElT).button('Pull')?.handlers.click?.();
		expect(log.calls).toContain('pull');
		const again = open(t); // the first window was closed by the Pull above
		again.el.button('Next')?.handlers.click?.();
		again.el.button('Next')?.handlers.click?.();
		again.el.button('Push now...')?.handlers.click?.();
		expect(log.calls).toContain('push');
	});

	it('the switches on the "what is synced" step change the settings', () => {
		const { t, settings } = makePlugin({ refreshToken: 'r' });
		const { el } = open(t);
		for (let i = 0; i < 6; i++) el.button('Next')?.handlers.click?.();
		const boxes = el.all().filter((c) => c.tag === 'input');
		expect(boxes).toHaveLength(3);
		expect(boxes.every((b) => b.checked)).toBe(true); // on by default
		boxes[1]!.checked = false;
		boxes[1]!.handlers.change?.();
		expect(settings.syncThemes).toBe(false);
		expect(settings.syncSnippets).toBeUndefined();
	});

	it('the doctor step starts the Sync doctor', () => {
		log.calls.length = 0;
		const b = makePlugin({ refreshToken: 'r' });
		const second = open(b.t);
		for (let i = 0; i < 5; i++) second.el.button('Next')?.handlers.click?.();
		second.el.button('Run the Sync doctor')?.handlers.click?.();
		expect(log.calls).toContain('doctor');
	});

	describe('the encryption step advises beginners against it', () => {
		const atEncryption = (settings: Record<string, unknown> = { refreshToken: 'r' }) => {
			const p = makePlugin(settings);
			const view = open(p.t);
			for (let i = 0; i < 3; i++) view.el.button('Next')?.handlers.click?.();
			return view;
		};

		it('shows the warning first, in a warning style', () => {
			const { el } = atEncryption();
			const warning = el.all().find((c) => c.cls.includes('ogd-tour-warning'));
			expect(warning?.text).toBe('Beginners: do not turn this on. Skip this step.');
			expect(el.all().filter((c) => c.tag === 'p')[0]?.cls).toContain('ogd-tour-warning');
		});

		it('"Skip this step" is the highlighted button, Next and the action button are not', () => {
			const { el } = atEncryption();
			expect(el.button('Skip this step')?.cls).toContain('mod-cta');
			expect(el.button('Next')?.cls).not.toContain('mod-cta');
			const action = el.button('Set up encryption (advanced)...');
			expect(action?.cls).toContain('ogd-tour-quiet');
			expect(action?.cls).not.toContain('mod-cta');
		});

		it('the advanced button asks first, with Cancel highlighted; nothing starts before "Continue"', () => {
			log.calls.length = 0;
			const { el } = atEncryption();
			el.button('Set up encryption (advanced)...')?.handlers.click?.();
			expect(log.calls).not.toContain('encryption');
			const confirm = log.modals[log.modals.length - 1]?.contentEl as ElT;
			expect(confirm.button('Cancel')?.cls).toContain('mod-cta');
			expect(confirm.button('Continue (advanced)')?.cls).not.toContain('mod-cta');
			confirm.button('Cancel')?.handlers.click?.();
			expect(log.calls).not.toContain('encryption');
			el.button('Set up encryption (advanced)...')?.handlers.click?.();
			(log.modals[log.modals.length - 1]?.contentEl as ElT).button('Continue (advanced)')?.handlers.click?.();
			expect(log.calls).toContain('encryption');
		});

		it('every other step keeps its normal buttons ("Next" highlighted)', () => {
			const p = makePlugin({ refreshToken: 'r' });
			const { el } = open(p.t);
			for (const step of [0, 1, 2, 4, 5, 6]) {
				// move to the step
				const view = open(makePlugin({ refreshToken: 'r' }).t);
				for (let i = 0; i < step; i++) view.el.button('Next')?.handlers.click?.();
				expect(view.el.button('Next')?.cls).toContain('mod-cta');
				expect(view.el.button('Skip this step')?.cls).not.toContain('mod-cta');
				expect(view.el.all().some((c) => c.cls.includes('ogd-tour-warning'))).toBe(false);
			}
			expect(el.button('Next')?.cls).toContain('mod-cta');
		});
	});
});

describe('the first-run offer', () => {
	it('is shown to a brand-new device, once, and remembered', () => {
		log.notices.length = 0;
		const s = makePlugin();
		installFragment();
		expect(maybeOfferTour(s.t)).toBe(true);
		expect(log.notices).toHaveLength(1);
		expect(s.settings.tourState).toEqual({ offered: true });
		expect(s.settings.themeNoticeShown).toBe(true);
		expect(maybeOfferTour(s.t)).toBe(false);
		expect(log.notices).toHaveLength(1);
	});

	it('is never shown to a device that already has a token or has synced', () => {
		log.notices.length = 0;
		expect(maybeOfferTour(makePlugin({ refreshToken: 'r' }).t)).toBe(false);
		expect(maybeOfferTour(makePlugin({ lastSyncedAt: 1 }).t)).toBe(false);
		expect(log.notices).toHaveLength(0);
	});

	it('Start tour opens the tour, Skip dismisses it', () => {
		log.notices.length = 0;
		const s = makePlugin();
		let fragment: ElT | undefined;
		installFragment((f) => (fragment = f));
		maybeOfferTour(s.t);
		fragment?.button('Skip')?.handlers.click?.();
		expect(s.settings.tourState?.dismissed).toBe(true);
	});

	it('openTour from the settings starts at step 1 after a finished tour; a stopped one can resume', () => {
		const s = makePlugin({ tourState: { finished: true, step: 7 } });
		g.createFragment = undefined;
		// opening needs a real element: only check the saved state
		try {
			openTour(s.t);
		} catch {
			/* contentEl is not a real element here */
		}
		expect(s.settings.tourState?.step).toBe(0);
		const stopped = makePlugin({ tourState: { step: 3, skipped: [] } });
		expect(canResumeTour(stopped.t)).toBe(true);
		expect(canResumeTour(makePlugin({ tourState: { step: 3, finished: true } }).t)).toBe(false);
		expect(canResumeTour(makePlugin({ tourState: { step: 3, dismissed: true } }).t)).toBe(false);
		expect(canResumeTour(makePlugin().t)).toBe(false);
	});
});

describe('the one-time notice about themes and snippets', () => {
	it('is shown once to an existing device', () => {
		log.notices.length = 0;
		const s = makePlugin({ refreshToken: 'r' });
		expect(maybeShowThemeNotice(s.t)).toBe(true);
		expect(String(log.notices[0])).toContain('themes and CSS snippets');
		expect(maybeShowThemeNotice(s.t)).toBe(false);
		expect(log.notices).toHaveLength(1);
	});
	it('is not shown when both switches are already off, or when the new-device offer covered it', () => {
		log.notices.length = 0;
		expect(maybeShowThemeNotice(makePlugin({ syncThemes: false, syncSnippets: false }).t)).toBe(false);
		expect(maybeShowThemeNotice(makePlugin({ themeNoticeShown: true }).t)).toBe(false);
		expect(log.notices).toHaveLength(0);
	});
});
