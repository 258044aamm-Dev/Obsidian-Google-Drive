import { describe, expect, it } from 'vitest';
import { renderRow } from '../helpers/settings-row';

/** Just enough of Obsidian's element helpers to see what a row contains. */
class El {
	children: El[] = [];
	cls = '';
	text = '';
	empty() {
		this.children = [];
	}
	createDiv(o: { cls?: string; text?: string } = {}) {
		const el = new El();
		el.cls = o.cls ?? '';
		el.text = o.text ?? '';
		this.children.push(el);
		return el;
	}
	find(cls: string): El | undefined {
		for (const c of this.children) {
			if (c.cls === cls) return c;
			const deeper = c.find(cls);
			if (deeper) return deeper;
		}
		return undefined;
	}
}

describe('settings rows that draw their own buttons', () => {
	it('keep their title and description next to the buttons', () => {
		const settingEl = new El();
		settingEl.createDiv({ cls: 'old-content' });
		const controls = renderRow({ settingEl: settingEl as unknown as HTMLElement }, 'End-to-end encryption', 'Off. Turn it on...');
		expect(settingEl.find('old-content')).toBeUndefined();
		expect(settingEl.find('setting-item-name')?.text).toBe('End-to-end encryption');
		expect(settingEl.find('setting-item-description')?.text).toBe('Off. Turn it on...');
		expect(settingEl.children.map((c) => c.cls)).toEqual(['setting-item-info', 'setting-item-control']);
		expect(settingEl.find('setting-item-control')).toBe(controls as unknown as El);
	});

	it('leaves out the description element when there is none', () => {
		const settingEl = new El();
		renderRow({ settingEl: settingEl as unknown as HTMLElement }, 'Diagnostics (0 entries)');
		expect(settingEl.find('setting-item-description')).toBeUndefined();
		expect(settingEl.find('setting-item-name')?.text).toBe('Diagnostics (0 entries)');
	});
});
