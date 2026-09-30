import { describe, it, vi } from 'vitest';
import { writeFileSync, readFileSync, existsSync } from 'fs';
vi.stubGlobal('window', globalThis); // eslint-disable-line obsidianmd/no-global-this
vi.mock('obsidian', async () => await import('../../tests/sim/obsidian-mock'));
import { World, diff, sleep, notices, dec, Device } from '../../tests/sim/world';
import { TFile } from '../../tests/sim/obsidian-mock';

const ROOT = process.env.SIM_ROOT as string; // plugin source root under test
const VERSION = process.env.SIM_VERSION ?? '0.0.0';
const LABEL = process.env.SIM_LABEL ?? 'run';
const RESULTS = `/tmp/sim-results-${LABEL}.json`;
const results: Record<string, any> = existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, 'utf8')) : {};
const record = (id: string, data: any) => {
	results[id] = data;
	writeFileSync(RESULTS, JSON.stringify(results, null, 1));
	console.log(`\n=== ${id}\n` + JSON.stringify(data, null, 1));
};
const same = (a: string[], b: string[]) => {
	const d = diff(a, b);
	return d.onlyA.length + d.onlyB.length === 0 ? 'IDENTICAL' : d;
};

const pullMod = () => import(ROOT + '/helpers/pull.ts');

/** desktop with a realistic vault, pushed to a fresh fake Drive; mobile bootstrapped via the plugin's own first pull */
async function setup(opts: { eventsForChildren?: boolean; steady?: boolean } = {}) {
	const w = new World(ROOT, VERSION);
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
	// First-time setup in the real plugin: the settings tab stores a fresh changes token, then onload() → startup pull
	mobile.plugin.settings.changesToken = String(w.drive.changes.length + 1);
	await sleep(20);
	mobile.plugin.syncing = true;
	const { pull } = await pullMod();
	if (await pull(mobile.plugin, true)) await mobile.plugin.endSync();
	mobile.plugin.syncing = false;
	if (opts.steady) {
		// fork has already run its one-time migration on this device
		mobile.plugin.settings.lastInstalledVersion = VERSION;
		await mobile.save();
	}
	await sleep(20);
	return { w, desktop, mobile };
}

/** the user's actions on desktop: delete files+folders, move folders, then sync */
async function desktopCleanup(desktop: Device) {
	const v = desktop.vault;
	await v.delete(v.getAbstractFileByPath('Inbox/a.md')!);
	await v.delete(v.getAbstractFileByPath('Archive')!);
	await v.delete(v.getAbstractFileByPath('Projects/Beta')!);
	await v.rename(v.getAbstractFileByPath('Projects/Alpha')!, 'Journal/Alpha');
	await v.rename(v.getAbstractFileByPath('root.md')!, 'Inbox/root.md');
	await sleep(20);
	await desktop.push();
}

const variants = VERSION >= '3.1.2' ? [true, false] : [true];

describe('reproduction', () => {
	it('S0 sanity: mobile bootstrap equals desktop', async () => {
		const { w, desktop, mobile } = await setup();
		const cfg = [...w.drive.files.values()].find((f) => f.properties.path === '.obsidian/plugins/google-drive-sync/data.json')!;
		const uploaded = JSON.parse(dec(cfg.content!));
		record('S0', {
			'desktop == Drive': same(desktop.tree(), w.drive.snapshotNonConfig()),
			'desktop == mobile': same(desktop.tree(), mobile.tree()),
			'phone pending ops after clean bootstrap': Object.keys(mobile.ops()).length,
			'keys inside data.json that the plugin uploads to Drive': Object.keys(uploaded),
			'uploaded data.json contains refreshToken?': !!uploaded.refreshToken,
			'uploaded data.json: pending ops count (should be 0 after a finished push)': Object.keys(uploaded.operations).length,
			'uploaded data.json: changesToken vs real latest': [uploaded.changesToken, String(w.drive.changes.length + 1)],
		});
	});

	for (const steady of variants) {
		const tag = VERSION >= '3.1.2' ? (steady ? ' [fork steady-state]' : ' [fork FIRST launch → migration runs]') : '';
		it(`S1 desktop cleanup → phone restart (startup pull)${tag}`, async () => {
			const { w, desktop, mobile } = await setup({ steady });
			await desktopCleanup(desktop);
			const driveOk = same(desktop.tree(), w.drive.snapshotNonConfig());
			await mobile.start();
			const afterPull = diff(desktop.tree(), mobile.tree());
			const opsAfterPull = mobile.ops();
			await mobile.start();
			const secondRestart = same(desktop.tree(), mobile.tree());
			// user edits a note on the phone and presses Push
			await mobile.vault.modify(mobile.vault.getFileByPath('Inbox/b.md') as TFile, 'b edited on phone');
			await sleep(20);
			await mobile.push();
			const driveAfterPhonePush = diff(w.drive.snapshotNonConfig(), desktop.tree());
			await desktop.start();
			record(`S1${steady ? 'steady' : 'first'}`, {
				'1. Drive == desktop after desktop push': driveOk,
				'2. phone vs desktop after startup pull (onlyA=missing on phone, onlyB=should be gone)': afterPull,
				'3. phone pending ops after pull': opsAfterPull,
				'4. after 2nd restart': secondRestart,
				'5. Drive vs desktop after phone push (onlyB = ghosts/resurrected on Drive)': driveAfterPhonePush,
				'6. desktop after it pulls the phone push (ghosts now back on desktop?)': same(desktop.tree(), w.drive.snapshotNonConfig()) === 'IDENTICAL' ? diff(desktop.tree(), ['Inbox/', 'Inbox/b.md', 'Inbox/root.md', 'Journal/', 'Journal/2026/', 'Journal/2026/09-01.md', 'Journal/Alpha/', 'Journal/Alpha/notes/', 'Journal/Alpha/notes/n1.md', 'Journal/Alpha/plan.md', 'Projects/']) : 'n/a',
			});
		});
	}

	it('S2 manual Pull command (steady state)', async () => {
		const { desktop, mobile } = await setup({ steady: true });
		await desktopCleanup(desktop);
		await mobile.pull(false);
		record('S2', { 'phone vs desktop': diff(desktop.tree(), mobile.tree()), ops: mobile.ops(), notices: [...notices] });
	});

	it('S3 pull interrupted mid-way (network drop / app killed), then retried', async () => {
		const { w, desktop, mobile } = await setup({ steady: true });
		await desktopCleanup(desktop);
		// phone starts pull; a download fails (network drop). Deletions were already applied.
		w.drive.failNext.push({ match: /GET \/drive\/v3\/files\/[^/]+$/, status: 500 });
		const r1 = await mobile.pull(false);
		const afterFail = { returned: r1, phoneVsDesktop: diff(desktop.tree(), mobile.tree()), ops: mobile.ops() };
		// app restarts (settings reloaded from disk) and user retries
		await mobile.save();
		await mobile.start();
		const afterRetry = { phoneVsDesktop: diff(desktop.tree(), mobile.tree()), ops: mobile.ops() };
		await mobile.vault.modify(mobile.vault.getFileByPath('Inbox/b.md') as TFile, 'edit');
		await sleep(20);
		await mobile.push();
		record('S3', {
			'after failed pull': afterFail,
			'after retry/restart': afterRetry,
			'Drive vs desktop after phone push (onlyB = deleted stuff resurrected)': diff(w.drive.snapshotNonConfig(), desktop.tree()),
		});
	});

	it('S4 phone clock ahead of desktop by 60s (lastSyncedAt compared with Drive modifiedTime)', async () => {
		const { w, desktop, mobile } = await setup({ steady: true });
		mobile.plugin.settings.lastSyncedAt = Date.now() + 60_000; // phone clock runs 60s fast when it last synced
		await mobile.save();
		await desktop.vault.create('Inbox/new-from-desktop.md', 'hello');
		await sleep(20);
		await desktop.push();
		await mobile.start();
		record('S4', { 'phone vs desktop': same(desktop.tree(), mobile.tree()), ops: mobile.ops() });
	});

	it('S5 phone bootstrapped the README way (download Drive folder incl. its data.json), then desktop cleanup', async () => {
		const { w, desktop } = await setup();
		// Phone = copy of the Drive folder, exactly as README "New Devices" says
		const mobile = w.device('mobile2');
		const dir = '.obsidian/plugins/google-drive-sync';
		for (const f of [...w.drive.files.values()].filter((f) => f.properties.obsidian !== 'vault').sort((a, b) => a.properties.path!.length - b.properties.path!.length)) {
			const p = f.properties.path!;
			if (p.endsWith('/main.js') || p.endsWith('/manifest.json')) continue;
			if (f.mimeType.includes('folder')) mobile.vault.disk.set(p, { type: 'folder', mtime: Date.now() });
			else mobile.vault.disk.set(p, { type: 'file', data: f.content!, mtime: Date.parse(f.modifiedTime) });
		}
		mobile.vault.refresh();
		await sleep(20);
		await mobile.start({ startupPull: true });
		const afterBoot = { 'phone vs desktop': same(desktop.tree(), mobile.tree()), 'phone pending ops (count)': Object.keys(mobile.ops()).length, sample: Object.entries(mobile.ops()).slice(0, 3) };
		// phone user touches one note and pushes
		await mobile.vault.modify(mobile.vault.getFileByPath('Inbox/b.md') as TFile, 'phone edit');
		await sleep(20);
		const before = w.drive.files.size;
		await mobile.push();
		const dupes: Record<string, number> = {};
		for (const f of w.drive.files.values()) if (f.properties.path && f.properties.obsidian !== 'vault') dupes[f.properties.path] = (dupes[f.properties.path] ?? 0) + 1;
		record('S5', {
			'after bootstrap+startup pull': afterBoot,
			'Drive object count before → after phone push': [before, w.drive.files.size],
			'paths that now exist more than once on Drive (duplicates)': Object.entries(dupes).filter(([, n]) => n > 1).map(([p, n]) => `${p} ×${n}`),
		});
	});

	it('S6 strict Drive: child DELETE inside same batch as its parent folder returns 404', async () => {
		const { w, desktop } = await setup({ steady: true });
		w.drive.strictBatch = true;
		await desktopCleanup(desktop);
		const first = { notices: [...notices], driveVsDesktop: diff(w.drive.snapshotNonConfig(), desktop.tree()), ops: Object.keys(desktop.ops()).length };
		await desktop.push();
		record('S6', { 'after 1st push attempt': first, 'after retry': { notices: [...notices], driveVsDesktop: diff(w.drive.snapshotNonConfig(), desktop.tree()), ops: Object.keys(desktop.ops()).length } });
	});

	it('S3b pull dies AFTER bookkeeping is mutated but BEFORE local deletes run (app killed / file locked), then retried', async () => {
		const { w, desktop, mobile } = await setup({ steady: true });
		await desktopCleanup(desktop);
		// make the first local delete blow up (locked file, iOS/Android sandbox error, or OS kills the app right there)
		const orig = mobile.vault.fileManager.trashFile;
		let armed = true;
		mobile.vault.fileManager.trashFile = async (f: any) => {
			if (armed) {
				armed = false;
				throw new Error('EPERM simulated');
			}
			return orig(f);
		};
		const r1 = await mobile.pull(false);
		await mobile.save(); // settings persisted (debounced save / quit handler)
		mobile.vault.fileManager.trashFile = orig;
		await mobile.start(); // reopen app → startup pull with the SAME changes token
		const afterRetry = { phoneVsDesktop: diff(desktop.tree(), mobile.tree()), ops: mobile.ops() };
		await mobile.vault.modify(mobile.vault.getFileByPath('Inbox/b.md') as TFile, 'edit');
		await sleep(20);
		await mobile.push();
		record('S3b', {
			'first pull returned': r1,
			'after retry: phone vs desktop (onlyB = deleted on desktop but still on phone)': afterRetry.phoneVsDesktop,
			'phone ops after retry': afterRetry.ops,
			'Drive vs desktop after phone push (onlyA = resurrected on Drive)': diff(w.drive.snapshotNonConfig(), desktop.tree()),
		});
	});

	it('S7 files-only cleanup (no folder deleted/moved) → phone pull', async () => {
		const { w, desktop, mobile } = await setup({ steady: true });
		const v = desktop.vault;
		await v.delete(v.getAbstractFileByPath('Inbox/a.md')!);
		await v.delete(v.getAbstractFileByPath('Archive/old.md')!);
		await v.rename(v.getAbstractFileByPath('root.md')!, 'Inbox/root.md');
		await sleep(20);
		await desktop.push();
		await mobile.start();
		record('S7', { 'phone vs desktop': same(desktop.tree(), mobile.tree()), ops: mobile.ops() });
	});

	it('S5b README-bootstrapped phone: desktop edits a note; phone pulls; phone pushes another note', async () => {
		const { w, desktop } = await setup();
		const mobile = w.device('mobile2');
		for (const f of [...w.drive.files.values()].filter((f) => f.properties.obsidian !== 'vault').sort((a, b) => a.properties.path!.length - b.properties.path!.length)) {
			const p = f.properties.path!;
			if (p.endsWith('/main.js') || p.endsWith('/manifest.json')) continue;
			if (f.mimeType.includes('folder')) mobile.vault.disk.set(p, { type: 'folder', mtime: Date.now() });
			else mobile.vault.disk.set(p, { type: 'file', data: f.content!, mtime: Date.parse(f.modifiedTime) });
		}
		mobile.vault.refresh();
		await sleep(20);
		await mobile.start({ startupPull: true });
		const opsAtBoot = Object.keys(mobile.ops()).length;
		// desktop edits a note and pushes
		await desktop.vault.modify(desktop.vault.getFileByPath('Inbox/b.md') as TFile, 'NEW TEXT WRITTEN ON DESKTOP');
		await sleep(20);
		await desktop.push();
		const driveBBefore = dec([...w.drive.files.values()].find((f) => f.properties.path === 'Inbox/b.md')!.content!);
		await mobile.start(); // phone opens → pull
		const phoneSees = dec(await mobile.vault.adapter.readBinary('Inbox/b.md'));
		await mobile.vault.modify(mobile.vault.getFileByPath('Inbox/a.md') as TFile, 'phone edit of a different note');
		await sleep(20);
		await mobile.push();
		const driveB = [...w.drive.files.values()].find((f) => f.properties.path === 'Inbox/b.md')!;
		record('S5b', {
			'phone pending ops right after bootstrap': opsAtBoot,
			'Inbox/b.md on Drive after DESKTOP push (before phone does anything)': driveBBefore,
			'Inbox/b.md on phone after pull (should be desktop text)': phoneSees,
			'phone ops after pull (b.md?)': mobile.ops()['Inbox/b.md'],
			'Inbox/b.md on Drive after phone push': dec(driveB.content!),
		});
	});
});
