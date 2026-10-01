import { describe, expect, it, vi } from 'vitest';
vi.stubGlobal('window', globalThis);
vi.mock('obsidian', async () => await import('./sim/obsidian-mock'));
import { badgeText, pullIconLabel, pushIconLabel, setBadge } from '../helpers/badge';

class El {
	classes = new Set<string>();
	text = '';
	attrs: Record<string, string> = {};
	children: El[] = [];
	selector = '';
	setText(t: string) {
		this.text = t;
	}
	addClass(c: string) {
		this.classes.add(c);
	}
	removeClass(c: string) {
		this.classes.delete(c);
	}
	setAttribute(k: string, v: string) {
		this.attrs[k] = v;
	}
	createSpan(o: { cls: string }) {
		const child = new El();
		child.classes.add(o.cls);
		this.children.push(child);
		return child;
	}
	querySelector(selector: string) {
		return this.children.find((c) => selector === '.' + [...c.classes][0]) ?? null;
	}
}

describe('badge text', () => {
	it('is empty for nothing, the number up to 99, and 99+ above', () => {
		expect(badgeText(undefined)).toBe('');
		expect(badgeText(0)).toBe('');
		expect(badgeText(-3)).toBe('');
		expect(badgeText(1)).toBe('1');
		expect(badgeText(99)).toBe('99');
		expect(badgeText(100)).toBe('99+');
		expect(badgeText(5000)).toBe('99+');
	});

	it('tooltips say where the changes are waiting', () => {
		expect(pushIconLabel(0)).toBe('Push to Google Drive');
		expect(pushIconLabel(1)).toBe('Push to Google Drive (1 change waiting on this device)');
		expect(pushIconLabel(271)).toBe('Push to Google Drive (271 changes waiting on this device)');
		expect(pullIconLabel(undefined)).toBe('Pull from Google Drive');
		expect(pullIconLabel(2)).toBe('Pull from Google Drive (2 changes waiting on Google Drive)');
	});
});

describe('setBadge', () => {
	it('creates the badge once, updates it, and hides it when empty', () => {
		const icon = new El();
		setBadge(icon, '3', 'Push (3)');
		expect(icon.children).toHaveLength(1);
		const badge = icon.children[0]!;
		expect(badge.text).toBe('3');
		expect(badge.classes.has('ogd-badge-hidden')).toBe(false);
		expect(icon.classes.has('ogd-badge-host')).toBe(true);
		expect(icon.attrs['aria-label']).toBe('Push (3)');

		setBadge(icon, '99+', 'Push (many)');
		expect(icon.children).toHaveLength(1); // not a second badge
		expect(badge.text).toBe('99+');

		setBadge(icon, '', 'Push');
		expect(badge.classes.has('ogd-badge-hidden')).toBe(true);
		expect(badge.text).toBe('');
		expect(icon.attrs['aria-label']).toBe('Push');

		setBadge(icon, '1', 'Push (1)');
		expect(badge.classes.has('ogd-badge-hidden')).toBe(false);
	});

	it('does nothing for a missing icon or one that is not a real element', () => {
		expect(() => setBadge(undefined, '1', 'x')).not.toThrow();
		expect(() => setBadge({ addClass: () => {}, removeClass: () => {} } as never, '1', 'x')).not.toThrow();
	});
});
