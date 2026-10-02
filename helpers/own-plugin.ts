import type ObsidianGoogleDrive from '../main';

/**
 * The folder of this very plugin (code + settings). It must never be synced: it holds the
 * plugin's own code and this device's private state (tokens, pending operations), and
 * overwriting or deleting it from another device breaks sync on this one.
 */
export const ownPluginFolder = (t: ObsidianGoogleDrive) =>
	`${t.app.vault.configDir}/plugins/${t.manifest?.id || 'google-drive-sync'}`;

export const isOwnPluginPath = (t: ObsidianGoogleDrive, path: string) => {
	const folder = ownPluginFolder(t);
	return path === folder || path.startsWith(folder + '/');
};
