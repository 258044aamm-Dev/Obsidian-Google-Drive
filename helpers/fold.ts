import type { ExtraButtonComponent } from 'obsidian';

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
