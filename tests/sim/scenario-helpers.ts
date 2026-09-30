import { World, Device, sleep, diff } from './world';

/** Root of the plugin source under test (this repo). */
export const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
export const VERSION = '3.5.0';

/** settings applied to every device created by `setup()`; the regression suite runs once per value of `deleteToTrash` */
export const simDefaults: Record<string, unknown> = {};

export const same = (a: string[], b: string[]) => {
	const d = diff(a, b);
	return d.onlyA.length + d.onlyB.length === 0 ? 'IDENTICAL' : d;
};

/**
 * Desktop with a realistic vault, pushed to a fresh fake Drive; phone bootstrapped with
 * the plugin's own first pull (the way the README's fallback describes).
 */
export async function setup(opts: { eventsForChildren?: boolean } = {}) {
	const w = new World(ROOT, VERSION);
	w.defaultSettings = { ...simDefaults };
	const desktop = w.device('desktop');
	desktop.vault.eventsForChildren = opts.eventsForChildren ?? true;
	await desktop.start({ startupPull: false });
	const v = desktop.vault;
	for (const d of ['Inbox', 'Projects', 'Projects/Alpha', 'Projects/Alpha/notes', 'Projects/Beta', 'Archive', 'Journal', 'Journal/2026'])
		await v.createFolder(d);
	const files: Record<string, string> = {
		'Inbox/a.md': 'a',
		'Inbox/b.md': 'b',
		'Projects/Alpha/plan.md': 'plan',
		'Projects/Alpha/notes/n1.md': 'n1',
		'Projects/Beta/readme.md': 'beta',
		'Archive/old.md': 'old',
		'Journal/2026/09-01.md': 'j',
		'root.md': 'root',
	};
	for (const [p, c] of Object.entries(files)) await v.create(p, c);
	await sleep(20);
	await desktop.push();

	const mobile = w.device('mobile');
	mobile.vault.eventsForChildren = opts.eventsForChildren ?? true;
	await mobile.start({ startupPull: false });
	mobile.plugin.settings.changesToken = String(w.drive.changes.length + 1);
	await sleep(20);
	await mobile.pull(true);
	await mobile.plugin.endSync();
	mobile.plugin.syncing = false;
	await sleep(20);
	return { w, desktop, mobile };
}

/** The user's cleanup on desktop: delete files+folders, move folders, sync. */
export async function desktopCleanup(desktop: Device) {
	const v = desktop.vault;
	await v.delete(v.getAbstractFileByPath('Inbox/a.md')!);
	await v.delete(v.getAbstractFileByPath('Archive')!);
	await v.delete(v.getAbstractFileByPath('Projects/Beta')!);
	await v.rename(v.getAbstractFileByPath('Projects/Alpha')!, 'Journal/Alpha');
	await v.rename(v.getAbstractFileByPath('root.md')!, 'Inbox/root.md');
	await sleep(20);
	await desktop.push();
}
