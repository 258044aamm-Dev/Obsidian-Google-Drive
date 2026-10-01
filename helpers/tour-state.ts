/**
 * The getting-started tour: its steps, the saved progress and the rules for when it is offered.
 * Pure data and functions (no Obsidian objects), so they can be tested on their own; the window
 * that shows them is in tour.ts.
 */

export type TourStepId =
	| 'welcome'
	| 'connect'
	| 'vault'
	| 'encryption'
	| 'daily'
	| 'safety'
	| 'what-syncs'
	| 'done';

/** What a button inside a step can do. Every one of them asks first or opens something the user then confirms. */
export type TourActionId =
	| 'open-signin'
	| 'open-token-settings'
	| 'pull'
	| 'push'
	| 'encryption'
	| 'doctor'
	| 'open-settings';

export interface TourAction {
	id: TourActionId;
	label: string;
}

export interface TourStep {
	id: TourStepId;
	title: string;
	paragraphs: string[];
	actions?: TourAction[];
	/** Show the three "what syncs" switches in this step. */
	switches?: boolean;
	/** A bold warning shown first. When set, "Skip this step" is the highlighted choice and the action buttons are quiet. */
	warning?: string;
}

export interface TourState {
	/** The offer was shown (so it is not shown again by itself). */
	offered?: boolean;
	/** The user chose "Skip tour" (or skipped the offer). */
	dismissed?: boolean;
	/** The tour was run to its last page. */
	finished?: boolean;
	/** Index of the page to continue from. */
	step?: number;
	/** Steps the user skipped. */
	skipped?: TourStepId[];
}

export const TOUR_STEPS: TourStep[] = [
	{
		id: 'welcome',
		title: 'How syncing works',
		paragraphs: [
			'This plugin keeps your vault on Google Drive and on your devices in step. Nothing happens by itself: it only syncs when you press Pull or Push.',
			'Pull brings what changed on Google Drive to this device. Push sends what you changed on this device to Google Drive.',
			'You can skip any step of this tour, and start it again at any time from the plugin settings ("Getting started") or with the command "Open the getting-started tour".',
		],
	},
	{
		id: 'connect',
		title: 'Connect Google Drive',
		paragraphs: [
			'The plugin needs a refresh token that lets it use a folder of your Google Drive. It only gets access to files it creates itself (the "drive.file" permission).',
			'1. Open the sign-in page and sign in with Google. 2. Copy the token it shows. 3. Paste it into the "Refresh token" setting.',
		],
		actions: [
			{ id: 'open-signin', label: 'Open the sign-in page' },
			{ id: 'open-token-settings', label: 'Open the token setting' },
		],
	},
	{
		id: 'vault',
		title: 'New or existing Drive vault',
		paragraphs: [
			'First device with the notes: press Push. The vault is created on Google Drive.',
			'Another device (for example your phone) that should get those notes: start with an EMPTY vault of the same name and press Pull.',
			'Make a backup of the vault before the first sync. Pull never overwrites a note you changed here: your version is kept and Drive\'s version is saved next to it as a copy.',
		],
		actions: [
			{ id: 'pull', label: 'Pull now...' },
			{ id: 'push', label: 'Push now...' },
		],
	},
	{
		id: 'encryption',
		title: 'End-to-end encryption (optional)',
		warning: 'Beginners: do not turn this on. Skip this step.',
		paragraphs: [
			'With encryption on, notes and their names are encrypted on your device before they reach Google Drive.',
			'Risks: if you lose the passphrase, your notes cannot be recovered by anyone, including the plugin author and Google. It creates a separate encrypted copy of your vault on Drive. Every device needs the same passphrase. Google Drive\'s web preview and search can no longer read your notes.',
			'You can turn it on later in the settings, once you are comfortable with the sync.',
		],
		actions: [{ id: 'encryption', label: 'Set up encryption (advanced)...' }],
	},
	{
		id: 'daily',
		title: 'Daily use',
		paragraphs: [
			'Ribbon icons: the circular arrows push, the cloud with an arrow pulls. On the desktop the status bar shows how many changes wait to be pushed; click it for a menu.',
			'If a Push says "Push stopped", Google Drive has changes this device has not pulled: press Pull first, then Push.',
			'If the connection drops in the middle, just press the same button again: finished work is not repeated.',
		],
	},
	{
		id: 'safety',
		title: 'Safety tools',
		paragraphs: [
			'Restore points: after each Push a restore point is saved; you can restore the whole vault to an earlier one (Settings, "Version history").',
			'Sync doctor: a read-only check that explains what is wrong when something does not sync. It changes nothing.',
			'Files named "... (Drive YYYY-MM-DD)" are copies made so that nothing you wrote is lost when a note changed on two devices.',
		],
		actions: [{ id: 'doctor', label: 'Run the Sync doctor' }],
	},
	{
		id: 'what-syncs',
		title: 'What is synced',
		paragraphs: [
			'Always: your notes, attachments and folders.',
			'Switchable here and in the settings: Obsidian\'s settings files (including which plugins are enabled) and the other plugins\' files, your themes, and your CSS snippets. Open tabs and the graph view layout are never synced, and neither is this plugin\'s own folder.',
			'After a Pull brought new plugins or settings, restart Obsidian.',
		],
		switches: true,
		actions: [{ id: 'open-settings', label: 'Open the plugin settings' }],
	},
	{
		id: 'done',
		title: 'You are set',
		paragraphs: ['That is all. You can open this tour again whenever you like.'],
	},
];

export const lastStepIndex = () => TOUR_STEPS.length - 1;

export const clampStep = (index: number | undefined) =>
	Math.min(Math.max(Number.isInteger(index) ? (index as number) : 0, 0), lastStepIndex());

/**
 * Only a device that has never been set up is offered the tour: no token, no earlier tour
 * state, nothing synced, nothing pending and no encryption. Anybody who already uses the
 * plugin sees no change.
 */
export const shouldOfferTour = (settings: {
	refreshToken?: string;
	tourState?: TourState;
	lastSyncedAt?: number;
	operations?: Record<string, unknown>;
	e2eeEnabled?: boolean;
}) =>
	!settings.refreshToken &&
	settings.tourState === undefined &&
	!settings.lastSyncedAt &&
	Object.keys(settings.operations ?? {}).length === 0 &&
	settings.e2eeEnabled !== true;

export const startTour = (state: TourState | undefined): TourState => ({
	...state,
	offered: true,
	dismissed: false,
	step: clampStep(state?.finished ? 0 : state?.step),
	skipped: state?.finished ? [] : (state?.skipped ?? []),
	finished: false,
});

export const goTo = (state: TourState, index: number): TourState => ({
	...state,
	step: clampStep(index),
});

export const nextStep = (state: TourState): TourState => goTo(state, (state.step ?? 0) + 1);
export const previousStep = (state: TourState): TourState => goTo(state, (state.step ?? 0) - 1);

/** "Skip this step": remembered, then the next page is shown. */
export const skipStep = (state: TourState): TourState => {
	const id = TOUR_STEPS[clampStep(state.step)]?.id as TourStepId;
	const skipped = [...(state.skipped ?? [])];
	if (!skipped.includes(id)) skipped.push(id);
	return nextStep({ ...state, skipped });
};

/** "Skip tour": closes it for good (it can still be started again by hand). */
export const dismissTour = (state: TourState | undefined): TourState => ({
	...state,
	offered: true,
	dismissed: true,
});

export const finishTour = (state: TourState): TourState => ({
	...state,
	offered: true,
	dismissed: false,
	finished: true,
	step: lastStepIndex(),
});

/** The pages the user skipped, by title, for the last page. */
export const skippedTitles = (state: TourState) =>
	(state.skipped ?? [])
		.map((id) => TOUR_STEPS.find((step) => step.id === id)?.title)
		.filter((title): title is string => !!title);
