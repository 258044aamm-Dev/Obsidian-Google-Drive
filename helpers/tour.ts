import { Modal, Notice } from 'obsidian';
import type { App } from 'obsidian';
import type ObsidianGoogleDrive from '../main';
import { pull } from './pull';
import { push } from './push';
import { runSyncDoctor } from './doctor-command';
import { openEnableEncryption } from './e2ee-ui';
import {
	TOUR_STEPS,
	clampStep,
	dismissTour,
	finishTour,
	goTo,
	lastStepIndex,
	nextStep,
	previousStep,
	shouldOfferTour,
	skipStep,
	skippedTitles,
	startTour,
	type TourActionId,
	type TourState,
} from './tour-state';

export const SIGN_IN_URL = 'https://ogd.richardxiong.com';

const saveState = (t: ObsidianGoogleDrive, state: TourState) => {
	t.settings.tourState = state;
	try {
		void t.saveSettings();
	} catch {
		// best effort
	}
};

/** Opens Obsidian's settings on this plugin's page (an internal API; falls back to a hint). */
export const openPluginSettings = (t: ObsidianGoogleDrive) => {
	try {
		const setting = (
			t.app as unknown as {
				setting?: { open: () => void; openTabById: (id: string) => void };
			}
		).setting;
		if (!setting) throw new Error('no settings API');
		setting.open();
		setting.openTabById(t.manifest?.id || 'google-drive-sync');
	} catch {
		new Notice('Open settings, then community plugins, then Google Drive sync.', 8000);
	}
};

/** A small "are you sure" window used before the tour starts a Pull. */
class ConfirmWindow extends Modal {
	constructor(
		app: App,
		private heading: string,
		private body: string,
		private confirmLabel: string,
		private onConfirm: () => void,
	) {
		super(app);
	}
	onOpen() {
		this.setTitle(this.heading);
		this.contentEl.empty();
		this.contentEl.createEl('p', { text: this.body });
		const cancel = this.contentEl.createEl('button', { text: 'Cancel' });
		cancel.addEventListener('click', () => this.close());
		const ok = this.contentEl.createEl('button', {
			text: this.confirmLabel,
			cls: 'mod-cta',
		});
		ok.addEventListener('click', () => {
			this.close();
			this.onConfirm();
		});
	}
}

export class TourModal extends Modal {
	private state: TourState;

	constructor(
		app: App,
		private t: ObsidianGoogleDrive,
		state: TourState,
	) {
		super(app);
		this.state = state;
	}

	onOpen() {
		this.render();
	}

	onClose() {
		this.contentEl.empty();
	}

	private go(next: TourState) {
		this.state = next;
		saveState(this.t, next);
		this.render();
	}

	private connected() {
		return !!this.t.settings.refreshToken;
	}

	private runAction(id: TourActionId) {
		const t = this.t;
		switch (id) {
			case 'open-signin':
				window.open(SIGN_IN_URL);
				return;
			case 'open-token-settings':
			case 'open-settings':
				this.close();
				openPluginSettings(t);
				return;
			case 'pull':
				new ConfirmWindow(
					this.app,
					'Pull from Google Drive?',
					'This brings the changes from Google Drive to this device. A note you changed here is never overwritten: your version is kept and Drive\'s version is saved next to it as a copy.',
					'Pull',
					() => {
						this.close();
						if (!t.syncing) void pull(t);
					},
				).open();
				return;
			case 'push':
				// Push shows its own confirmation window listing what will be sent.
				this.close();
				if (!t.syncing) void push(t);
				return;
			case 'encryption':
				this.close();
				openEnableEncryption(t, () => undefined);
				return;
			case 'doctor':
				this.close();
				void runSyncDoctor(t);
				return;
		}
	}

	private render() {
		const { contentEl } = this;
		const index = clampStep(this.state.step);
		const step = TOUR_STEPS[index];
		if (!step) return;
		const last = index === lastStepIndex();

		contentEl.empty();
		this.setTitle(`Getting started (${index + 1} of ${TOUR_STEPS.length}): ${step.title}`);

		for (const text of step.paragraphs) contentEl.createEl('p', { text });

		if (step.id === 'connect') {
			contentEl.createEl('p', {
				text: this.connected()
					? 'Status: connected to Google Drive.'
					: 'Status: not connected yet.',
			});
		}

		if (step.switches) {
			const rows: [
				'syncConfigFiles' | 'syncThemes' | 'syncSnippets',
				string,
			][] = [
				['syncConfigFiles', 'Sync Obsidian settings and other plugins\' files'],
				['syncThemes', 'Sync themes'],
				['syncSnippets', 'Sync CSS snippets'],
			];
			for (const [key, label] of rows) {
				const row = contentEl.createEl('label');
				const box = row.createEl('input', { type: 'checkbox' });
				box.checked = this.t.settings[key] !== false;
				row.createSpan({ text: ' ' + label });
				box.addEventListener('change', () => {
					this.t.settings[key] = box.checked;
					try {
						void this.t.saveSettings();
					} catch {
						// best effort
					}
				});
			}
		}

		if (step.id === 'done') {
			const skipped = skippedTitles(this.state);
			contentEl.createEl('p', {
				text: skipped.length
					? `You skipped: ${skipped.join(', ')}.`
					: 'You went through every step.',
			});
		}

		for (const action of step.actions ?? []) {
			const needsConnection = !['open-signin', 'open-token-settings', 'open-settings'].includes(action.id);
			const button = contentEl.createEl('button', { text: action.label });
			if (needsConnection && !this.connected()) {
				button.disabled = true;
				button.title = 'Connect Google Drive first (step 2).';
			}
			button.addEventListener('click', () => this.runAction(action.id));
		}

		const back = contentEl.createEl('button', { text: 'Back' });
		back.disabled = index === 0;
		back.addEventListener('click', () => this.go(previousStep(this.state)));

		if (!last) {
			const skip = contentEl.createEl('button', { text: 'Skip this step' });
			skip.addEventListener('click', () => this.go(skipStep(this.state)));
			const next = contentEl.createEl('button', { text: 'Next', cls: 'mod-cta' });
			next.addEventListener('click', () => this.go(nextStep(this.state)));
			const dismiss = contentEl.createEl('button', { text: 'Skip tour' });
			dismiss.addEventListener('click', () => {
				saveState(this.t, dismissTour(this.state));
				this.close();
			});
		} else {
			const finish = contentEl.createEl('button', { text: 'Finish', cls: 'mod-cta' });
			finish.addEventListener('click', () => {
				saveState(this.t, finishTour(this.state));
				this.close();
			});
		}
	}
}

/** Opens the tour: from the beginning, or (when `resume`) where the user stopped. */
export const openTour = (t: ObsidianGoogleDrive, resume = false) => {
	const previous = t.settings.tourState;
	const state = resume && previous && !previous.finished
		? startTour(previous)
		: goTo(startTour({ ...previous, finished: true }), 0);
	saveState(t, state);
	new TourModal(t.app, t, state).open();
};

/** True when the user stopped the tour part way and can continue it. */
export const canResumeTour = (t: ObsidianGoogleDrive) => {
	const s = t.settings.tourState;
	return !!s && !s.finished && !s.dismissed && (s.step ?? 0) > 0;
};

/**
 * A new device is offered the tour with a small notice (Start tour / Skip), once.
 * Returns true when the notice was shown.
 */
export const maybeOfferTour = (t: ObsidianGoogleDrive) => {
	if (!shouldOfferTour(t.settings)) return false;
	// Remembered at once, so the offer is not repeated at the next start whatever the user does.
	t.settings.tourState = { offered: true };
	// A new device learns about theme and snippet sync in the tour.
	t.settings.themeNoticeShown = true;
	try {
		void t.saveSettings();
	} catch {
		// best effort
	}

	let notice: Notice | undefined;
	const fragment = createFragment((frag) => {
		frag.appendText('Welcome to Google Drive Sync. Take a one-minute tour of how to set it up? ');
		const add = (label: string, run: () => void) => {
			const button = frag.createEl('button', { text: label });
			button.addEventListener('click', () => {
				notice?.hide();
				run();
			});
		};
		add('Start tour', () => openTour(t));
		add('Skip', () => saveState(t, dismissTour(t.settings.tourState)));
	});
	notice = new Notice(fragment, 0);
	return true;
};

/**
 * Themes and CSS snippets are synced by default since 3.7.0. A device that already used the
 * plugin is told once, so nothing is uploaded or downloaded without the user having been told
 * how to switch it off.
 */
export const maybeShowThemeNotice = (t: ObsidianGoogleDrive) => {
	if (t.settings.themeNoticeShown) return false;
	t.settings.themeNoticeShown = true;
	try {
		void t.saveSettings();
	} catch {
		// best effort
	}
	if (t.settings.syncThemes === false && t.settings.syncSnippets === false) return false;
	new Notice(
		'New in 3.7.0: themes and CSS snippets are now synced together with your settings files. You can switch this off in the plugin settings ("sync themes", "sync CSS snippets").',
		15000,
	);
	return true;
};
