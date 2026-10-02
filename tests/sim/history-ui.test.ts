/** The restore dialog, driven the way a user would: choose a point, read the plan, restore, read the result. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.stubGlobal('window', globalThis);

const ui = vi.hoisted(() => ({
	texts: [] as string[],
	buttons: [] as { text: string; click?: () => void }[],
	toggles: [] as { value: boolean; change?: (v: boolean) => void }[],
	titles: [] as string[],
}));

vi.mock('obsidian', async () => {
	const base = await import('./obsidian-mock');
	class El {
		createEl(_tag: string, o?: { text?: string }) {
			if (o?.text) ui.texts.push(o.text);
			return new El();
		}
		createDiv() {
			return new El();
		}
		empty() {
			ui.texts.length = 0;
			ui.buttons.length = 0;
			ui.toggles.length = 0;
		}
	}
	class Modal {
		app: unknown;
		contentEl = new El();
		constructor(app: unknown) {
			this.app = app;
		}
		setTitle(t: string) {
			ui.titles.push(t);
		}
		open() {
			(this as unknown as { onOpen?: () => void }).onOpen?.();
		}
		close() {
			(this as unknown as { onClose?: () => void }).onClose?.();
		}
	}
	class Setting {
		constructor(_el: unknown) {}
		setName(n: string) {
			ui.texts.push(n);
			return this;
		}
		setDesc(d: string) {
			ui.texts.push(d);
			return this;
		}
		addToggle(cb: (t: unknown) => void) {
			const state = { value: false } as (typeof ui.toggles)[number];
			const toggle = {
				setValue: (v: boolean) => ((state.value = v), toggle),
				onChange: (fn: (v: boolean) => void) => ((state.change = fn), toggle),
			};
			cb(toggle);
			ui.toggles.push(state);
			return this;
		}
		addButton(cb: (b: unknown) => void) {
			const state = { text: '' } as (typeof ui.buttons)[number];
			const button: Record<string, unknown> = {
				setButtonText: (t: string) => ((state.text = t), button),
				setCta: () => button,
				setDestructive: () => button,
				onClick: (fn: () => void) => ((state.click = fn), button),
			};
			cb(button);
			ui.buttons.push(state);
			return this;
		}
	}
	return { ...base, Modal, Setting };
});

import { sleep, dec, notices } from './world';
import { setup, simDefaults } from './scenario-helpers';
import { TFile } from './obsidian-mock';
import { startVaultRestore } from '../../helpers/history-ui';

const waitFor = async (what: string, test: () => boolean) => {
	for (let i = 0; i < 300; i++) {
		if (test()) return;
		await sleep(10);
	}
	throw new Error('timed out waiting for: ' + what + '\nscreen: ' + ui.texts.join(' | '));
};
const screen = () => ui.texts.join('\n');
const press = (text: string, nth = 0) => {
	const b = ui.buttons.filter((x) => x.text === text)[nth];
	if (!b?.click) throw new Error(`no button "${text}" on screen: ${ui.buttons.map((x) => x.text).join(', ')}`);
	b.click();
};

describe('restore dialog', () => {
	beforeEach(() => {
		simDefaults.deleteToTrash = true;
		simDefaults.historyEnabled = true;
		ui.texts.length = 0;
		ui.buttons.length = 0;
		ui.toggles.length = 0;
		ui.titles.length = 0;
	});

	async function twoPoints() {
		const s = await setup();
		const v = s.desktop.vault;
		await v.modify(v.getFileByPath('Inbox/a.md') as TFile, 'edited');
		await v.delete(v.getAbstractFileByPath('Archive/old.md')!);
		await sleep(20);
		await s.desktop.push();
		return s;
	}

	it('walks from the list of points to a finished restore, and uploads nothing by itself', async () => {
		const s = await twoPoints();
		await startVaultRestore(s.desktop.plugin);
		expect(ui.titles).toContain('Restore the whole vault');
		expect(screen()).toMatch(/kept for 10 days/);
		expect(ui.buttons.filter((b) => b.text === 'Choose')).toHaveLength(2);

		press('Choose', 1); // the older point
		await waitFor('the plan', () => /Restore to /.test(screen()));
		expect(screen()).toMatch(/1 file go back to their old content/);
		expect(screen()).toMatch(/1 deleted file come back/);
		expect(screen()).toMatch(/Inbox\/a\.md/);
		expect(screen()).toMatch(/Archive\/old\.md/);
		expect(screen()).toMatch(/a restore point of the current state is saved/);

		const driveBefore = JSON.stringify(s.w.drive.snapshot());
		press('Restore on this device');
		await waitFor('the result', () => /Restore finished on this device/.test(screen()));
		expect(screen()).toMatch(/Nothing has been uploaded yet/);
		expect(dec(s.desktop.vault.disk.get('Inbox/a.md')!.data as Uint8Array)).toBe('a');
		expect(dec(s.desktop.vault.disk.get('Archive/old.md')!.data as Uint8Array)).toBe('old');
		expect(JSON.stringify(s.w.drive.snapshot())).toBe(driveBefore);
		expect(ui.buttons.map((b) => b.text)).toEqual(['Close', 'Review and push now']);
	});

	it('the checkbox decides whether settings files are included, and Back returns to the list', async () => {
		const s = await twoPoints();
		await startVaultRestore(s.desktop.plugin);
		expect(ui.toggles[0]!.value).toBe(true);
		ui.toggles[0]!.change!(false);
		press('Choose', 1);
		await waitFor('the plan', () => /Restore to /.test(screen()));
		press('Back');
		expect(ui.buttons.filter((b) => b.text === 'Choose')).toHaveLength(2);
		expect(ui.toggles[0]!.value).toBe(false); // the choice is remembered
	});

	it('tells the user why it cannot start (unpushed changes) and does not open the dialog', async () => {
		const s = await twoPoints();
		await s.desktop.vault.create('unpushed.md', 'x');
		notices.length = 0;
		await startVaultRestore(s.desktop.plugin);
		expect(notices.at(-1)).toMatch(/not pushed yet/);
		expect(ui.titles).toEqual([]);
	});

	it('says so when there are no restore points yet', async () => {
		simDefaults.historyEnabled = false;
		const s = await setup();
		notices.length = 0;
		await startVaultRestore(s.desktop.plugin);
		expect(notices.at(-1)).toMatch(/no restore points yet/);
	});

	it('a Pull problem before the restore stops it with the reason, changing nothing', async () => {
		const s = await twoPoints();
		await startVaultRestore(s.desktop.plugin);
		s.w.drive.failNext.push({ match: /^GET \/drive\/v3\/changes$/, status: 500 });
		const before = s.desktop.tree().join();
		press('Choose', 1);
		await waitFor('back to the list', () => ui.buttons.some((b) => b.text === 'Choose') && notices.some((n) => /did not finish/.test(n)));
		expect(s.desktop.tree().join()).toBe(before);
		expect(s.desktop.ops()).toEqual({});
	});
});
