import { Notice } from 'obsidian';
import ObsidianGoogleDrive from '../main';
import { unSplitPath } from './drive';

export const fixDrivePath = async (t: ObsidianGoogleDrive) => {
	const driveFiles = await t.diagnostics.withContext(
		'fix-paths',
		'search-all-files',
		() =>
			t.drive.searchFiles({
				include: ['id', 'properties'],
			}),
	);
	if (!driveFiles) {
		new Notice(
			'[fix paths] failed to fetch drive files. Check diagnostics.',
			8000,
		);
		return;
	}
	const idToPath = Object.fromEntries(
		driveFiles.map(({ id, properties }) => [id, unSplitPath(properties)]),
	);
	t.settings.driveIdToPath = idToPath;
	t.settings.operations = {};
	new Notice(
		'Google Drive paths have been fixed. Please restart the plugin to apply changes.',
	);
};
