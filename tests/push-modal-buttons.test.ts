import { describe, expect, it, vi } from 'vitest';

const buttons = vi.hoisted(
	() => [] as { text: string; cta: boolean; click?: () => void }[],
);
const choice = vi.hoisted(() => ({ text: '' }));
const seen = vi.hoisted(() => ({ modes: [] as string[], notices: [] as string[] }));

vi.mock('../helpers/pull', () => ({
	pull: vi.fn(async (_t: unknown, _silent: boolean, guard: { mode: string; blocked?: boolean; remoteCount?: number }) => {
		seen.modes.push(guard.mode);
		guard.blocked = true;
		guard.remoteCount = 2;
		return false;
	}),
}));

vi.mock('obsidian', () => {
	class Element {
		createEl() {
			return new Element();
		}
		createDiv() {
			return new Element();
		}
		createSpan() {
			return new Element();
		}
		setText() {}
		addClass() {}
		empty() {}
	}
	class Modal {
		contentEl = new Element();
		setTitle() {}
		open() {
			if (choice.text) buttons.find((b) => b.text === choice.text)?.click?.();
		}
		close() {
			(this as { onClose?: () => void }).onClose?.();
		}
	}
	class Setting {
		addButton(configure: (b: unknown) => void) {
			const state = { text: '', cta: false, click: undefined as undefined | (() => void) };
			const b = {
				setButtonText: (text: string) => ((state.text = text), b),
				setCta: () => ((state.cta = true), b),
				onClick: (click: () => void) => ((state.click = click), b),
			};
			configure(b);
			buttons.push(state);
			return this;
		}
	}
	class Plain {}
	class Notice {
		constructor(message: string) {
			seen.notices.push(message);
		}
	}
	return { Modal, Setting, Notice, TFile: Plain, TFolder: Plain, setIcon: () => {} };
});

import { ConfirmPushModal, push } from '../helpers/push';

const open = () => {
	buttons.length = 0;
	choice.text = '';
	const proceed = vi.fn();
	const t = { app: {}, settings: { driveIdToPath: {}, deleteToTrash: true } };
	new ConfirmPushModal(t as never, [['a.md', 'modify']], proceed);
	return proceed;
};
const click = (text: string) => buttons.find((b) => b.text === text)?.click?.();

describe('ConfirmPushModal buttons', () => {
	it('has Cancel, Confirm and Push without pulling', () => {
		open();
		expect(buttons.map((b) => b.text)).toEqual(['Cancel', 'Confirm', 'Push without pulling']);
		expect(buttons.find((b) => b.text === 'Confirm')?.cta).toBe(true);
		expect(buttons.find((b) => b.text === 'Push without pulling')?.cta).toBe(false);
	});
	it('Confirm is an ordinary push (no "without pulling" flag)', () => {
		const proceed = open();
		click('Confirm');
		expect(proceed).toHaveBeenNthCalledWith(1, true);
	});
	it('Push without pulling passes the flag', () => {
		const proceed = open();
		click('Push without pulling');
		expect(proceed).toHaveBeenNthCalledWith(1, true, true);
	});
	it('Cancel and closing the window do not push', () => {
		const proceed = open();
		click('Cancel');
		expect(proceed).toHaveBeenCalledWith(false);
		expect(proceed).not.toHaveBeenCalledWith(true);
	});
});

describe('push() reads the choice made in the window', () => {
	const run = async (text: string) => {
		seen.modes.length = 0;
		seen.notices.length = 0;
		buttons.length = 0;
		choice.text = text;
		const plugin = {
			syncing: false,
			app: { vault: { adapter: {} } },
			settings: { operations: { 'a.md': 'modify' }, driveIdToPath: {}, deleteToTrash: true },
			startSync: vi.fn(async () => {
				plugin.syncing = true;
				return { hide() {}, setMessage() {} };
			}),
			abortSync: vi.fn(),
			diagnostics: { record: vi.fn() },
		};
		await push(plugin as never);
		return plugin;
	};

	it('Confirm: Drive is only checked, and any newer change stops the push', async () => {
		const plugin = await run('Confirm');
		expect(seen.modes).toEqual(['any']);
		expect(seen.notices.join(' ')).toContain('Push stopped: Google Drive has 2 newer changes');
		expect(plugin.abortSync).toHaveBeenCalled();
	});
	it('Push without pulling: stops only for collisions', async () => {
		await run('Push without pulling');
		expect(seen.modes).toEqual(['overlap']);
	});
	it('Cancel: nothing is checked or started', async () => {
		const plugin = await run('Cancel');
		expect(seen.modes).toEqual([]);
		expect(plugin.startSync).not.toHaveBeenCalled();
	});
});
