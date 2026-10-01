import { describe, expect, it } from 'vitest';
import {
	TOUR_STEPS,
	clampStep,
	dismissTour,
	finishTour,
	goTo,
	lastStepIndex,
	nextStep,
	previousStep,
	shouldOfferTour,
	skipStep,
	skippedTitles,
	startTour,
} from '../helpers/tour-state';
import { configCategoryOf } from '../helpers/config-scope';

describe('who is offered the tour', () => {
	it('a brand-new device is', () => {
		expect(shouldOfferTour({})).toBe(true);
		expect(shouldOfferTour({ operations: {}, lastSyncedAt: 0 })).toBe(true);
	});
	it('nobody who already uses the plugin is', () => {
		expect(shouldOfferTour({ refreshToken: 'r' })).toBe(false);
		expect(shouldOfferTour({ lastSyncedAt: 5 })).toBe(false);
		expect(shouldOfferTour({ operations: { 'a.md': 'create' } })).toBe(false);
		expect(shouldOfferTour({ e2eeEnabled: true })).toBe(false);
	});
	it('nobody who already saw the offer is', () => {
		expect(shouldOfferTour({ tourState: { offered: true } })).toBe(false);
		expect(shouldOfferTour({ tourState: dismissTour(undefined) })).toBe(false);
	});
});

describe('tour progress', () => {
	it('has eight steps, each with a title and text', () => {
		expect(TOUR_STEPS).toHaveLength(8);
		expect(new Set(TOUR_STEPS.map((s) => s.id)).size).toBe(8);
		for (const s of TOUR_STEPS) {
			expect(s.title).toBeTruthy();
			expect(s.paragraphs.length).toBeGreaterThan(0);
		}
	});
	it('next and back stay inside the steps', () => {
		let s = startTour(undefined);
		expect(s.step).toBe(0);
		expect(previousStep(s).step).toBe(0);
		for (let i = 0; i < 20; i++) s = nextStep(s);
		expect(s.step).toBe(lastStepIndex());
		expect(clampStep(-4)).toBe(0);
		expect(clampStep(undefined)).toBe(0);
		expect(clampStep(Number.NaN)).toBe(0);
		expect(goTo(s, 2).step).toBe(2);
	});
	it('skipping a step remembers it once and moves on', () => {
		let s = startTour(undefined);
		s = skipStep(s);
		expect(s.step).toBe(1);
		expect(s.skipped).toEqual(['welcome']);
		s = skipStep(goTo(s, 0));
		expect(s.skipped).toEqual(['welcome']);
		expect(skippedTitles(s)).toEqual([TOUR_STEPS[0]?.title]);
	});
	it('"Skip tour" closes it for good, "Finish" marks it done', () => {
		const d = dismissTour({ step: 3 });
		expect(d.dismissed).toBe(true);
		expect(d.step).toBe(3);
		const f = finishTour({ step: 7, skipped: ['encryption'] });
		expect(f.finished).toBe(true);
		expect(f.skipped).toEqual(['encryption']);
	});
	it('starting again after a finished tour starts from the beginning with a clean list', () => {
		const s = startTour({ finished: true, step: 7, skipped: ['daily'] });
		expect(s.step).toBe(0);
		expect(s.skipped).toEqual([]);
		expect(s.finished).toBe(false);
	});
	it('resuming keeps the page and the skipped list', () => {
		const s = startTour({ step: 4, skipped: ['connect'] });
		expect(s.step).toBe(4);
		expect(s.skipped).toEqual(['connect']);
	});
});

describe('which part of the configuration folder a path belongs to', () => {
	const c = '.obsidian';
	it('sorts the paths', () => {
		expect(configCategoryOf(c, '.obsidian/app.json')).toBe('settings');
		expect(configCategoryOf(c, '.obsidian/plugins/foo/main.js')).toBe('settings');
		expect(configCategoryOf(c, '.obsidian/themes/Minimal/theme.css')).toBe('themes');
		expect(configCategoryOf(c, '.obsidian/themes')).toBe('themes');
		expect(configCategoryOf(c, '.obsidian/snippets/wide.css')).toBe('snippets');
		expect(configCategoryOf(c, '.obsidian')).toBe('settings');
	});
	it('leaves notes and look-alike names alone', () => {
		expect(configCategoryOf(c, 'Inbox/a.md')).toBeUndefined();
		expect(configCategoryOf(c, '.obsidian-other/themes/x')).toBeUndefined();
		expect(configCategoryOf(c, '.obsidian/themes-old/x.css')).toBe('settings');
	});
});
