import type { SettingDefinition, SettingDefinitionGroup } from 'obsidian';
import { foldButton } from './fold';

/**
 * Whether the Advanced section of the settings page is unfolded. Folded by default so that a new
 * user only sees what is needed to connect and sync; the choice is kept while Obsidian runs.
 */
let advancedOpen = false;
export const isAdvancedOpen = () => advancedOpen;
export const setAdvancedOpen = (open: boolean) => {
	advancedOpen = open;
};

/** What the folded section says it holds, so that nobody has to guess what is behind the arrow. */
export const ADVANCED_SUMMARY =
	'Counts on the ribbon icons, the ignore list, which settings files sync, version history, end-to-end encryption, the connection settings and diagnostics. The defaults work for most people.';

/**
 * The "Advanced" section: a heading with an arrow. Folded, it holds one line that says what is in it;
 * unfolded, it holds `items`. `redraw` draws the settings page again after the arrow was pressed.
 */
export const advancedSettingGroup = (
	items: SettingDefinition[],
	redraw: () => void = () => {},
): SettingDefinitionGroup => {
	const open = advancedOpen;
	return {
		type: 'group',
		heading: 'Advanced',
		cls: 'ogd-advanced',
		extraButtons: [
			foldButton(open, 'the advanced settings', () => {
				advancedOpen = !advancedOpen;
				redraw();
			}),
		],
		items: open ? items : [{ name: 'Advanced settings', desc: ADVANCED_SUMMARY }],
	};
};
