/**
 * 3.11.0: the floating button follows a real plugin on a phone: edit a note and the number
 * appears, Push and it is gone, and the settings page offers its switch only on a phone.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.stubGlobal('window', globalThis);
vi.mock('obsidian', async () => await import('./obsidian-mock'));
import { Platform } from './obsidian-mock';
import { FakeEl } from './fake-dom';
import { sleep } from './world';
import { setup } from './scenario-helpers';

const phone = () => {
	const body = new FakeEl('body');
	vi.stubGlobal('document', { body, visibilityState: 'visible' });
	Platform.isMobile = true;
	return body;
};

afterEach(() => {
	Platform.isMobile = false;
	vi.unstubAllGlobals();
	vi.stubGlobal('window', globalThis);
});

const edit = async (d: any, path: string, text: string) => {
	await d.vault.modify(d.vault.getFileByPath(path), text);
	await sleep(20);
};
/** Both simulated devices act as the phone here; the second one created is `mobile`. */
const phoneEl = (body: FakeEl) => body.children.at(-1);
const pill = (body: FakeEl) => {
	const el = phoneEl(body);
	return {
		hidden: !el || el.classes.has('ogd-float-hide'),
		push: el && !el.children[0]!.classes.has('ogd-float-hide') ? el.children[0]!.textContent : '',
		pull: el && !el.children[1]!.classes.has('ogd-float-hide') ? el.children[1]!.textContent : '',
	};
};

describe('the floating button on a phone', () => {
	it('shows the changes made on the phone, and is gone after they are pushed', async () => {
		const body = phone();
		const { mobile } = await setup();
		expect(pill(body).hidden).toBe(true);
		await edit(mobile, 'Inbox/a.md', 'a2');
		await edit(mobile, 'root.md', 'r2');
		expect(pill(body)).toEqual({ hidden: false, push: '\u21912', pull: '' });
		await mobile.push();
		expect(pill(body).hidden).toBe(true);
	});

	it('shows nothing and never touches the page on a desktop', async () => {
		const body = new FakeEl('body');
		vi.stubGlobal('document', { body, visibilityState: 'visible' });
		const { desktop } = await setup();
		await edit(desktop, 'Inbox/a.md', 'a2');
		expect(body.children).toHaveLength(0);
	});

	it('shows what is waiting on Drive when the Drive check is on', async () => {
		const body = phone();
		const { desktop, mobile } = await setup();
		mobile.plugin.settings.pullBadge = true;
		await edit(desktop, 'Inbox/a.md', 'a2');
		await desktop.push();
		mobile.plugin.waitingOnDrive = 1;
		mobile.plugin.updateBadges();
		expect(pill(body)).toEqual({ hidden: false, push: '', pull: '\u21931' });
	});

	it('is removed when the plugin unloads', async () => {
		const body = phone();
		const { mobile } = await setup();
		await edit(mobile, 'Inbox/a.md', 'a2');
		const el = phoneEl(body)!;
		expect(el.removed).toBe(false);
		mobile.plugin.onunload();
		expect(el.removed).toBe(true);
	});

	it('the settings page offers its switch and a reset button only on a phone', async () => {
		const { mobile } = await setup();
		const names = (items: any[]): string[] => items.flatMap((i) => [i.name, ...names(i.items ?? [])]);
		const { setAdvancedOpen } = await import('../../helpers/advanced');
		setAdvancedOpen(true);
		const keys = (items: any[]): string[] => items.flatMap((i) => [i.control?.key, ...keys(i.items ?? [])]).filter(Boolean);
		expect(keys(mobile.plugin.settingTab.getSettingDefinitions())).not.toContain('floatingBadge');
		Platform.isMobile = true;
		const defs = mobile.plugin.settingTab.getSettingDefinitions();
		expect(keys(defs)).toContain('floatingBadge');
		expect(names(defs)).toContain('Position of the floating button');
		setAdvancedOpen(false);
	});
});
