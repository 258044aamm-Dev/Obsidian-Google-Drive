// Mixed-version check: the fork (3.2.0) and upstream (3.1.1) sharing one Drive vault.
// Run from the fork root:  UP=/abs/path/to/upstream npx vitest run --config investigation/vitest.interop.config.ts
import { describe, expect, it, vi } from 'vitest';
vi.stubGlobal('window', globalThis);
vi.mock('obsidian', async () => await import('../../tests/sim/obsidian-mock'));
import { World, sleep, diff } from '../../tests/sim/world';
import { ROOT, VERSION } from '../../tests/sim/scenario-helpers';

const UP = process.env.UP!;
const same = (a: string[], b: string[]) => {
	const d = diff(a, b);
	return d.onlyA.length + d.onlyB.length === 0 ? 'IDENTICAL' : d;
};

async function seed(desktopRoot: string, phoneRoot: string) {
	const w = new World(ROOT, VERSION);
	const desktop = w.device('desktop', undefined, desktopRoot);
	await desktop.start({ startupPull: false });
	const v = desktop.vault;
	for (const d of ['Inbox', 'Projects', 'Projects/Alpha', 'Projects/Beta', 'Archive']) await v.createFolder(d);
	for (const [p, c] of Object.entries({ 'Inbox/a.md': 'a', 'Inbox/b.md': 'b', 'Projects/Alpha/plan.md': 'p', 'Projects/Beta/r.md': 'r', 'Archive/old.md': 'o', 'root.md': 'x' })) await v.create(p, c);
	await sleep(20);
	await desktop.push();
	const phone = w.device('phone', undefined, phoneRoot);
	await phone.start({ startupPull: false });
	phone.plugin.settings.changesToken = String(w.drive.changes.length + 1);
	await sleep(20);
	await phone.pull(true);
	await phone.plugin.endSync();
	phone.plugin.syncing = false;
	await sleep(20);
	return { w, desktop, phone };
}
async function cleanup(d: any) {
	const v = d.vault;
	await v.delete(v.getAbstractFileByPath('Inbox/a.md'));
	await v.delete(v.getAbstractFileByPath('Archive'));
	await v.delete(v.getAbstractFileByPath('Projects/Beta'));
	await v.rename(v.getAbstractFileByPath('Projects/Alpha'), 'Inbox/Alpha');
	await sleep(20);
	await d.push();
}

describe('interop', () => {
	it('upstream desktop -> fork phone: Pull mirrors everything, nothing pending', async () => {
		const { desktop, phone } = await seed(UP, ROOT);
		await cleanup(desktop);
		await phone.pull();
		expect(same(desktop.tree(), phone.tree())).toBe('IDENTICAL');
		expect(phone.ops()).toEqual({});
	});
	it('fork desktop -> upstream phone: Drive stays readable, files/moves arrive', async () => {
		const { w, desktop, phone } = await seed(ROOT, UP);
		await cleanup(desktop);
		await phone.pull();
		const t = phone.tree();
		expect(t).toContain('Inbox/Alpha/plan.md');
		expect(t).not.toContain('Inbox/a.md');
		expect(t).not.toContain('Archive/old.md');
		// upstream 3.1.1 still leaves its known ghost-folder shells (proves the phone really runs upstream code)
		expect(Object.keys(phone.ops())).toContain('Archive');
		expect(same(desktop.tree(), w.drive.snapshotNonConfig())).toBe('IDENTICAL');
	});
	it('fork desktop and upstream phone can both push without errors, Drive == desktop', async () => {
		const { w, desktop, phone } = await seed(ROOT, UP);
		await desktop.vault.create('Inbox/d.md', 'from desktop');
		await phone.vault.create('Inbox/p.md', 'from phone');
		await sleep(20);
		await desktop.push();
		await phone.push();
		await desktop.push();
		await phone.pull();
		await desktop.pull();
		expect(same(desktop.tree(), w.drive.snapshotNonConfig())).toBe('IDENTICAL');
		expect(desktop.tree()).toContain('Inbox/p.md');
		expect(phone.tree()).toContain('Inbox/d.md');
	});
});
