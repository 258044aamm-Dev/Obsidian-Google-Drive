import type { ExtraButtonComponent, SettingDefinition } from 'obsidian';
import { renderRow } from './settings-row';

/**
 * The arrow button in the heading of a settings group that folds and unfolds it. The group is
 * built again after every press (see `redraw`), showing its rows only while it is open.
 */
export const foldButton =
	(open: boolean, name: string, onToggle: () => void) =>
	(button: ExtraButtonComponent) => {
		button
			.setIcon(open ? 'chevron-down' : 'chevron-right')
			.setTooltip(open ? `Hide ${name}` : `Show ${name}`)
			.onClick(onToggle);
	};

/**
 * What a folded group shows below its heading: one card that says what is inside. The whole card is
 * the button (mouse, touch, and Enter or Space from the keyboard), so nobody has to hit the small arrow.
 */
export const foldedCard = (
	name: string,
	desc: string,
	onOpen: () => void,
): SettingDefinition => ({
	name,
	desc,
	render: (setting) => {
		renderRow(setting, name, desc);
		const row = setting.settingEl;
		row.addClass('ogd-fold-card');
		row.setAttribute('role', 'button');
		row.setAttribute('tabindex', '0');
		row.setAttribute('aria-expanded', 'false');
		row.addEventListener('click', () => onOpen());
		row.addEventListener('keydown', (event: KeyboardEvent) => {
			if (event.key !== 'Enter' && event.key !== ' ') return;
			event.preventDefault();
			onOpen();
		});
	},
});
