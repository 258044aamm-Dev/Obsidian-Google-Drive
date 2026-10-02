import { describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as string[]);
vi.mock('obsidian', () => {
	class Menu {
		items: { title?: string; click?: () => void }[] = [];
		addItem(cb: (i: unknown) => void) {
			const e: { title?: string; click?: () => void } = {};
			const i: Record<string, unknown> = {};
			i.setTitle = (t: string) => ((e.title = t), i);
			i.setIcon = () => i;
			i.setDisabled = () => i;
			i.onClick = (f: () => void) => ((e.click = f), i);
			cb(i);
			this.items.push(e);
			return this;
		}
		addSeparator() {
			return this;
		}
	}
	return { Menu, Platform: { isMobile: false }, setIcon: () => {} };
});
vi.mock('../helpers/pull', () => ({ pull: vi.fn(async () => void calls.push('pull')) }));
vi.mock('../helpers/push', () => ({ push: vi.fn(async () => void calls.push('push')) }));
vi.mock('../helpers/doctor-command', () => ({ runSyncDoctor: vi.fn(async () => void calls.push('doctor')) }));
vi.mock('../helpers/history-ui', () => ({
	startVaultRestore: vi.fn(async () => void calls.push('restore')),
	createRestorePointNow: vi.fn(async () => void calls.push('restore-point')),
}));

import { Menu } from 'obsidian';
import { buildStatusBarMenu } from '../helpers/status-bar';

describe('status bar menu entries', () => {
	it('each entry runs the matching action', () => {
		const t = { settings: { operations: { 'a.md': 'modify' } } };
		const menu = buildStatusBarMenu(t as never, new Menu()) as unknown as { items: { title?: string; click?: () => void }[] };
		const run = (title: string) => menu.items.find((i) => i.title === title)?.click?.();
		run('Pull from Google Drive');
		run('Push to Google Drive');
		run('Sync doctor (read-only check)');
		run('Restore the whole vault from history');
		run('Create a restore point now');
		expect(calls).toEqual(['pull', 'push', 'doctor', 'restore', 'restore-point']);
	});
});
