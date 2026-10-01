import { describe, expect, it, vi } from 'vitest';

const { El, log } = vi.hoisted(() => {
	class El {
		children: El[] = [];
		handlers: Record<string, () => void> = {};
		text = '';
		cls = '';
		disabled = false;
		checked = false;
		type = '';
		autocomplete = '';
		constructor(public tag = 'div') {}
		empty() {
			this.children = [];
		}
		setText(t: string) {
			this.text = t;
		}
		createEl(tag: string, o?: { text?: string; cls?: string }) {
			const e = new El(tag);
			e.text = o?.text ?? '';
			e.cls = o?.cls ?? '';
			this.children.push(e);
			return e;
		}
		createDiv(o?: { cls?: string }) {
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
	return { El, log: { modals: [] as { contentEl: InstanceType<typeof El> }[], enable: [] as string[][], unlock: [] as string[], texts: [] as string[], onChanges: [] as ((v: string) => void)[] } };
});

vi.mock('obsidian', () => {
	class Modal {
		contentEl = new El();
		constructor(public app: unknown) {
			log.modals.push(this);
		}
		setTitle() {}
		open() {
			(this as unknown as { onOpen?: () => void }).onOpen?.();
		}
		close() {
			(this as unknown as { onClose?: () => void }).onClose?.();
		}
	}
	class Setting {
		constructor(public el: InstanceType<typeof El>) {}
		setName() {
			return this;
		}
		setDesc() {
			return this;
		}
		addText(cb: (t: { inputEl: Record<string, unknown>; onChange: (f: (v: string) => void) => void }) => void) {
			cb({ inputEl: {}, onChange: (f) => void log.onChanges.push(f) });
			return this;
		}
	}
	return { Modal, Setting, Notice: class { constructor(m: string) { log.texts.push(m); } } };
});
vi.mock('../helpers/e2ee', () => ({
	changePassphrase: vi.fn(),
	disableEncryption: vi.fn(),
	enableEncryption: vi.fn(async (_t: unknown, pass: string, repeat: string) => {
		log.enable.push([pass, repeat]);
		return 'created';
	}),
	unlockEncryption: vi.fn(async (_t: unknown, pass: string) => void log.unlock.push(pass)),
}));
vi.mock('../helpers/crypto', () => ({ MIN_PASSPHRASE_CHARS: 12, checkPassphrase: () => ({ message: '' }) }));

import { openEnableEncryption, openUnlockEncryption } from '../helpers/e2ee-ui';

const plugin = { app: {}, syncing: false } as never;
const lastModal = () => log.modals[log.modals.length - 1]?.contentEl as InstanceType<typeof El>;
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the "Turn on end-to-end encryption" window', () => {
	it('starts with the beginner warning and a box that must be ticked', () => {
		openEnableEncryption(plugin, () => undefined);
		const el = lastModal();
		const warning = el.all().find((c) => c.cls.includes('ogd-warning-text'));
		expect(warning?.text).toContain('if you are a beginner, press Cancel');
		expect(el.all().filter((c) => c.tag === 'p')[0]?.cls).toContain('ogd-warning-text');
		const box = el.all().find((c) => c.tag === 'input');
		expect(box).toBeTruthy();
		expect(el.all().some((c) => c.text.includes('nobody can recover my notes'))).toBe(true);
		expect(el.button('Turn on')?.disabled).toBe(true);
	});

	it('does nothing while the box is not ticked, and works after it is', async () => {
		log.enable.length = 0;
		log.onChanges.length = 0;
		openEnableEncryption(plugin, () => undefined);
		const el = lastModal();
		log.onChanges[0]?.('correct horse battery staple');
		log.onChanges[1]?.('correct horse battery staple');
		el.button('Turn on')?.handlers.click?.(); // ignored: disabled
		await flush();
		expect(log.enable).toHaveLength(0);

		const box = el.all().find((c) => c.tag === 'input')!;
		box.checked = true;
		box.handlers.change?.();
		expect(el.button('Turn on')?.disabled).toBe(false);
		el.button('Turn on')?.handlers.click?.();
		await flush();
		expect(log.enable).toEqual([['correct horse battery staple', 'correct horse battery staple']]);
	});

	it('unticking the box disables the button again', () => {
		openEnableEncryption(plugin, () => undefined);
		const el = lastModal();
		const box = el.all().find((c) => c.tag === 'input')!;
		box.checked = true;
		box.handlers.change?.();
		box.checked = false;
		box.handlers.change?.();
		expect(el.button('Turn on')?.disabled).toBe(true);
	});

	it('Cancel is always available', () => {
		openEnableEncryption(plugin, () => undefined);
		expect(lastModal().button('Cancel')).toBeTruthy();
	});
});

describe('the other encryption windows are unchanged', () => {
	it('the unlock window has no warning, no box, and an enabled button', async () => {
		log.unlock.length = 0;
		log.onChanges.length = 0;
		openUnlockEncryption(plugin, () => undefined);
		const el = lastModal();
		expect(el.all().some((c) => c.cls.includes('ogd-warning-text'))).toBe(false);
		expect(el.all().some((c) => c.tag === 'input')).toBe(false);
		expect(el.button('Unlock')?.disabled).toBe(false);
		log.onChanges[0]?.('my passphrase');
		el.button('Unlock')?.handlers.click?.();
		await flush();
		expect(log.unlock).toEqual(['my passphrase']);
	});
});
