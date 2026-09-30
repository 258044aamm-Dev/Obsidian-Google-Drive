/**
 * Deleting the files in a folder and then the (now empty) folder itself must remove the whole
 * folder on every device. Upstream 3.1.1 keeps the emptied folder on the other device and the
 * next Push sends it back to Drive, which brings it back on the first device as well.
 */
import { describe, expect, it, vi } from 'vitest';
vi.stubGlobal('window', globalThis);
vi.mock('obsidian', async () => await import('./obsidian-mock'));
import { sleep } from './world';
import { setup, simDefaults } from './scenario-helpers';

const FOLDER = 'application/vnd.google-apps.folder';
const vaultFolders = (w: any) =>
	[...w.drive.files.values()]
		.filter((f: any) => f.mimeType === FOLDER && !f.trashed && f.properties.obsidian !== 'vault' && !f.properties.history)
		.map((f: any) => f.name)
		.sort();
const emptied = (d: any) => d.vault.tree().filter((p: string) => p.endsWith('/') && /Alpha|Beta|notes/.test(p));

const feeds: [string, (w: any) => void][] = [
	['default feed', () => {}],
	['feed without the descendants of a deleted folder, strict batches', (w) => {
		w.drive.omitDescendantRemovals = true;
		w.drive.strictBatch = true;
	}],
];

for (const [feed, tweak] of feeds)
	for (const trash of [false, true])
		for (const mode of ['one push', 'files pushed first', 'other device pulls in between'] as const)
			describe(`emptied folders are removed everywhere (${feed}, deleteToTrash=${trash}, ${mode})`, () => {
				it('does not bring the folder back', async () => {
					Object.assign(simDefaults, { deleteToTrash: trash });
					try {
						const { w, desktop, mobile } = await setup();
						tweak(w);
						const v = desktop.vault;
						const cleanFolders = vaultFolders(w).filter((n: string) => !['Alpha', 'Beta', 'notes'].includes(n));

						for (const p of ['Projects/Alpha/notes/n1.md', 'Projects/Alpha/plan.md', 'Projects/Beta/readme.md'])
							await v.delete(v.getAbstractFileByPath(p)!);
						await sleep(20);
						if (mode !== 'one push') {
							await desktop.push();
							await sleep(20);
						}
						if (mode === 'other device pulls in between') {
							await mobile.pull();
							await sleep(20);
						}
						for (const p of ['Projects/Alpha/notes', 'Projects/Alpha', 'Projects/Beta'])
							await v.delete(v.getAbstractFileByPath(p)!);
						await sleep(20);
						await desktop.push();
						await sleep(20);
						expect(vaultFolders(w)).toEqual(cleanFolders);

						await mobile.pull();
						await sleep(20);
						expect(emptied(mobile)).toEqual([]);

						// the other device's next Push must not send them back
						await mobile.vault.create('Inbox/zz.md', 'z');
						await sleep(20);
						await mobile.push();
						await sleep(20);
						expect(vaultFolders(w)).toEqual(cleanFolders);
						await desktop.pull();
						await sleep(20);
						expect(emptied(desktop)).toEqual([]);
					} finally {
						delete simDefaults.deleteToTrash;
					}
				});
			});
