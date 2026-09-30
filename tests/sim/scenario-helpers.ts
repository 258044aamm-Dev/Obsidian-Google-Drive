import { World, Device, sleep, diff } from './world';

/** Root of the plugin source under test (this repo). */
export const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
export const VERSION = '3.6.2';

/** settings applied to every device created by `setup()`; the regression suite runs once per value of `deleteToTrash` */
export const simDefaults: Record<string, unknown> = {};

/** When `on`, `setup()` links both devices to an end-to-end encrypted Drive vault (the regression suite runs once more this way). */
export const simE2ee = { on: process.env.SIM_E2EE === '1', passphrase: 'correct horse battery staple' };

let spied = false;
let currentDrive: () => { plainPaths: Map<string, string> } = () => ({ plainPaths: new Map() });
/** Records (encrypted path id -> real path) whenever the plugin encodes properties, so the fake Drive can show real paths. */
const spyOnPaths = (E2ee: any, drive: () => { plainPaths: Map<string, string> }) => {
	currentDrive = drive;
	if (spied) return;
	spied = true;
	const original = E2ee.prototype.encodeProperties;
	E2ee.prototype.encodeProperties = async function (props: Record<string, string>) {
		const out = await original.call(this, props);
		if (props.path !== undefined) {
			const real = Object.keys(props)
				.filter((k) => k === 'path' || /^path\d+$/.test(k))
				.sort((a, b) => Number(a.slice(4) || 1) - Number(b.slice(4) || 1))
				.map((k) => props[k])
				.join('');
			currentDrive().plainPaths.set(out.path, real);
		}
		return out;
	};
};

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
	const e2ee = simE2ee.on ? await import(ROOT + '/helpers/e2ee.ts') : undefined;
	if (e2ee) {
		(await import(ROOT + '/helpers/crypto.ts')).kdf.iterations = 1000; // fast key derivation for tests
		spyOnPaths(e2ee.E2ee, () => w.drive);
		w.drive.decryptContent = async (content: Uint8Array, f: any) =>
			new Uint8Array(
				f.properties.history
					? await desktop.plugin.e2ee.decryptBlob(content, 'restore-point')
					: await desktop.plugin.e2ee.decryptFile(content, w.drive.shown(f) ?? ''),
			);
		await e2ee.enableEncryption(desktop.plugin, simE2ee.passphrase);
	}
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
	if (e2ee) await e2ee.enableEncryption(mobile.plugin, simE2ee.passphrase);
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
