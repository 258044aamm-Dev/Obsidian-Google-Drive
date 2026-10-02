import { describe, expect, it, vi } from 'vitest';

const created = vi.hoisted(() => [] as { tag: string; text?: string; cls?: string }[]);

vi.mock('obsidian', () => {
	class Element {
		createEl(tag: string, o?: { text?: string; cls?: string }) {
			created.push({ tag, ...o });
			return new Element();
		}
		createDiv() {
			return new Element();
		}
		createSpan() {
			return new Element();
		}
		setText(text: string) {
			created.push({ tag: 'text', text });
		}
		addClass() {}
		empty() {}
	}
	class Modal {
		contentEl = new Element();
		setTitle() {}
	}
	class Setting {
		addButton(configure: (b: unknown) => void) {
			const b: Record<string, unknown> = {};
			for (const k of ['setButtonText', 'setCta', 'onClick']) b[k] = () => b;
			configure(b);
			return this;
		}
	}
	class Plain {}
	return { Modal, Setting, Notice: Plain, TFile: Plain, TFolder: Plain, setIcon: () => {} };
});

import { ConfirmPushModal } from '../helpers/push';

const open = (deletes: number, tracked: number, toTrash: boolean) => {
	created.length = 0;
	const operations = Array.from({ length: deletes }, (_, i) => [`f${i}.md`, 'delete'] as ['f0.md', 'delete']);
	const driveIdToPath = Object.fromEntries(Array.from({ length: tracked }, (_, i) => [`id${i}`, `f${i}.md`]));
	const t = { app: {}, settings: { driveIdToPath, deleteToTrash: toTrash } };
	new ConfirmPushModal(t as never, operations, () => {});
	return created.filter((c) => c.cls === 'mod-warning');
};

describe('ConfirmPushModal mass-delete warning', () => {
	it('shows a warning paragraph above the list for a mass delete', () => {
		const warnings = open(30, 100, true);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]?.text).toContain('WARNING: this Push deletes 30 items');
		// the warning comes before the first listed operation
		const firstOp = created.findIndex((c) => c.text?.startsWith(': f'));
		expect(created.findIndex((c) => c.cls === 'mod-warning')).toBeLessThan(firstOp);
	});
	it('shows nothing extra for an ordinary delete', () => {
		expect(open(2, 100, true)).toEqual([]);
	});
});
