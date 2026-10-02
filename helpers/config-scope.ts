import type ObsidianGoogleDrive from '../main';

/**
 * Which files of the Obsidian configuration folder are synced.
 *  - `settings`: the settings files in the folder itself (appearance, hotkeys, which plugins
 *    are enabled ...) and the manifest/main.js/styles.css/data.json of the other plugins;
 *  - `themes`:   `<configDir>/themes/<name>/theme.css` and `manifest.json`;
 *  - `snippets`: `<configDir>/snippets/*.css`.
 * A switch counts as ON unless it is explicitly `false`, so a device whose settings were saved
 * by an older version behaves as before (settings files synced).
 */
export type ConfigCategory = 'settings' | 'themes' | 'snippets';

/** The category of a vault path, or undefined when it is not inside the configuration folder. */
export const configCategoryOf = (
	configDir: string,
	path: string,
): ConfigCategory | undefined => {
	if (path !== configDir && !path.startsWith(configDir + '/')) return undefined;
	if (path.startsWith(configDir + '/themes/') || path === configDir + '/themes') {
		return 'themes';
	}
	if (path.startsWith(configDir + '/snippets/') || path === configDir + '/snippets') {
		return 'snippets';
	}
	return 'settings';
};

export const isCategoryEnabled = (
	t: ObsidianGoogleDrive,
	category: ConfigCategory,
): boolean => {
	const settings = t.settings;
	if (category === 'themes') return settings.syncThemes !== false;
	if (category === 'snippets') return settings.syncSnippets !== false;
	return settings.syncConfigFiles !== false;
};

/** False for a configuration-folder file whose category is switched off; true for everything else. */
export const isConfigPathSynced = (
	t: ObsidianGoogleDrive,
	path: string,
): boolean => {
	const category = configCategoryOf(t.app.vault.configDir, path);
	return category === undefined || isCategoryEnabled(t, category);
};

/** Theme files that are synced (the folder may hold other things, which are left alone). */
export const THEME_FILES = ['theme.css', 'manifest.json'];
