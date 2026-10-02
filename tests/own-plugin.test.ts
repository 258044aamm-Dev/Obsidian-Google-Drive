import { describe, expect, it } from 'vitest';
import { isOwnPluginPath, ownPluginFolder } from '../helpers/own-plugin';

const plugin = (id?: string) =>
	({ app: { vault: { configDir: 'cfg' } }, manifest: id ? { id } : undefined }) as never;

describe('own plugin folder', () => {
	it('uses the manifest id, falling back to the published id', () => {
		expect(ownPluginFolder(plugin('x'))).toBe('cfg/plugins/x');
		expect(ownPluginFolder(plugin())).toBe('cfg/plugins/google-drive-sync');
	});

	it('matches the folder and its contents only', () => {
		const t = plugin();
		expect(isOwnPluginPath(t, 'cfg/plugins/google-drive-sync')).toBe(true);
		expect(isOwnPluginPath(t, 'cfg/plugins/google-drive-sync/data.json')).toBe(true);
		expect(isOwnPluginPath(t, 'cfg/plugins/google-drive-sync-other/main.js')).toBe(false);
		expect(isOwnPluginPath(t, 'cfg/plugins/other/main.js')).toBe(false);
		expect(isOwnPluginPath(t, 'notes/google-drive-sync/data.json')).toBe(false);
	});
});
