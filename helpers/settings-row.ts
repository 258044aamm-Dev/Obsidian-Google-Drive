/**
 * Builds the title, the description and an empty control area of a settings row that draws its own
 * buttons (`render` rows). The rows used to call `settingEl.empty()` and then `setName()` / `setDesc()`:
 * that clears the title and description elements before they are filled, so only the buttons showed.
 * This uses the same element classes Obsidian uses, so the row looks like the others.
 */
export const renderRow = (
	setting: { settingEl: HTMLElement },
	title: string,
	description?: string,
): HTMLElement => {
	const row = setting.settingEl;
	row.empty();
	const info = row.createDiv({ cls: 'setting-item-info' });
	info.createDiv({ cls: 'setting-item-name', text: title });
	if (description) {
		info.createDiv({ cls: 'setting-item-description', text: description });
	}
	return row.createDiv({ cls: 'setting-item-control' });
};
