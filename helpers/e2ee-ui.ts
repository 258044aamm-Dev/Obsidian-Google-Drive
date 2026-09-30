import { Modal, Notice, Setting } from 'obsidian';
import type ObsidianGoogleDrive from '../main';
import { changePassphrase, disableEncryption, enableEncryption, unlockEncryption } from './e2ee';
import { MIN_PASSPHRASE_CHARS, checkPassphrase } from './crypto';

type Field = { label: string; key: string; desc?: string; hint?: boolean };

/** A small dialog with password fields. `onSubmit` returns an error text to show, or nothing when it worked. */
class PassphraseModal extends Modal {
	private values: Record<string, string> = {};
	private errorEl?: { setText: (t: string) => void };
	private hintEl?: { setText: (t: string) => void };
	private busy = false;

	constructor(
		t: ObsidianGoogleDrive,
		private readonly title: string,
		private readonly intro: string[],
		private readonly fields: Field[],
		private readonly submitLabel: string,
		private readonly onSubmit: (values: Record<string, string>) => Promise<string | undefined>,
	) {
		super(t.app);
	}

	onOpen() {
		const { contentEl } = this;
		this.setTitle(this.title);
		for (const line of this.intro) contentEl.createEl('p', { text: line });
		for (const field of this.fields) {
			const setting = new Setting(contentEl).setName(field.label);
			if (field.desc) setting.setDesc(field.desc);
			setting.addText((text) => {
				text.inputEl.type = 'password';
				text.inputEl.autocomplete = 'off';
				text.onChange((value) => {
					this.values[field.key] = value;
					if (field.hint) this.hintEl?.setText(value ? checkPassphrase(value).message : '');
				});
			});
		}
		this.hintEl = contentEl.createEl('p', { text: '' });
		this.errorEl = contentEl.createEl('p', { text: '' });
		const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
		const submit = buttons.createEl('button', { text: this.submitLabel, cls: 'mod-cta' });
		const cancel = buttons.createEl('button', { text: 'Cancel' });
		cancel.addEventListener('click', () => this.close());
		submit.addEventListener('click', () => {
			if (this.busy) return;
			this.busy = true;
			submit.disabled = true;
			this.errorEl?.setText('Working, this can take a few seconds...');
			void this.onSubmit(this.values)
				.then((error) => {
					if (error) {
						this.errorEl?.setText(error);
						return;
					}
					this.close();
				})
				.catch((error: unknown) => this.errorEl?.setText(error instanceof Error ? error.message : String(error)))
				.finally(() => {
					this.busy = false;
					submit.disabled = false;
				});
		});
	}

	onClose() {
		this.contentEl.empty();
		this.values = {};
	}
}

class ConfirmModal extends Modal {
	constructor(
		t: ObsidianGoogleDrive,
		private readonly title: string,
		private readonly lines: string[],
		private readonly confirmLabel: string,
		private readonly onConfirm: () => Promise<void>,
	) {
		super(t.app);
	}

	onOpen() {
		this.setTitle(this.title);
		for (const line of this.lines) this.contentEl.createEl('p', { text: line });
		const buttons = this.contentEl.createDiv({ cls: 'modal-button-container' });
		const ok = buttons.createEl('button', { text: this.confirmLabel, cls: 'mod-warning' });
		const cancel = buttons.createEl('button', { text: 'Cancel' });
		cancel.addEventListener('click', () => this.close());
		ok.addEventListener('click', () => {
			ok.disabled = true;
			void this.onConfirm()
				.catch((error: unknown) => new Notice(error instanceof Error ? error.message : String(error), 10000))
				.finally(() => this.close());
		});
	}

	onClose() {
		this.contentEl.empty();
	}
}

const asText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const openEnableEncryption = (t: ObsidianGoogleDrive, refresh: () => void) => {
	if (t.syncing) {
		new Notice('A sync is running. Try again when it has finished.');
		return;
	}
	new PassphraseModal(
		t,
		'Turn on end-to-end encryption',
		[
			'Your notes and their names are encrypted on this device before they are sent to Google Drive, in a NEW encrypted vault folder next to your current one. Your current Drive vault is not changed or deleted.',
			'If no encrypted vault exists yet, this device creates it and your next Push uploads everything (do this on your main device first). If it already exists, this device joins it with the same passphrase and you then press Pull.',
			`If you lose the passphrase, nobody can recover the encrypted notes, including the plugin author. Use at least ${MIN_PASSPHRASE_CHARS} characters (a few random words are good).`,
		],
		[
			{ label: 'Passphrase', key: 'pass', hint: true },
			{ label: 'Repeat the passphrase', key: 'repeat', desc: 'Needed when the encrypted vault is created.' },
		],
		'Turn on',
		async (v) => {
			try {
				const mode = await enableEncryption(t, v.pass ?? '', v.repeat ?? '');
				new Notice(
					mode === 'created'
						? 'Encryption is on. A new encrypted vault was created. Press Push to upload your notes, encrypted.'
						: 'Encryption is on. Joined the existing encrypted vault. Press Pull to download your notes.',
					12000,
				);
				refresh();
				return undefined;
			} catch (error) {
				return asText(error);
			}
		},
	).open();
};

export const openUnlockEncryption = (t: ObsidianGoogleDrive, refresh: () => void) => {
	new PassphraseModal(
		t,
		'Enter the encryption passphrase',
		['This device does not have the key for the encrypted vault (for example after the app data was cleared). Sync is paused until you enter the passphrase.'],
		[{ label: 'Passphrase', key: 'pass' }],
		'Unlock',
		async (v) => {
			try {
				await unlockEncryption(t, v.pass ?? '');
				new Notice('Unlocked. You can pull and push again.');
				refresh();
				return undefined;
			} catch (error) {
				return asText(error);
			}
		},
	).open();
};

export const openChangePassphrase = (t: ObsidianGoogleDrive) => {
	new PassphraseModal(
		t,
		'Change the encryption passphrase',
		[
			'Nothing is re-uploaded. Devices that already use the vault keep working. A new device needs the new passphrase. An old passphrase that someone already knows can still open copies of the vault header they saved earlier, so if it leaked, create a new encrypted vault instead.',
		],
		[
			{ label: 'Current passphrase', key: 'old' },
			{ label: 'New passphrase', key: 'pass', hint: true },
			{ label: 'Repeat the new passphrase', key: 'repeat' },
		],
		'Change',
		async (v) => {
			if ((v.repeat ?? '') === '') return 'Type the new passphrase a second time in the repeat box.';
			if ((v.pass ?? '') !== (v.repeat ?? '')) return 'The two new passphrases are different.';
			try {
				await changePassphrase(t, v.old ?? '', v.pass ?? '');
				new Notice('Passphrase changed.');
				return undefined;
			} catch (error) {
				return asText(error);
			}
		},
	).open();
};

export const openDisableEncryption = (t: ObsidianGoogleDrive, refresh: () => void) => {
	if (t.syncing) {
		new Notice('A sync is running. Try again when it has finished.');
		return;
	}
	new ConfirmModal(
		t,
		'Turn off end-to-end encryption on this device',
		[
			'This device goes back to the plain Drive vault it used before (if any). The encrypted vault on Drive is not deleted, and the key is removed from this device.',
			'Changes made on this device while encryption was on are not sent to the plain vault automatically; the next Push looks for edited files.',
		],
		'Turn off',
		async () => {
			await disableEncryption(t);
			new Notice('Encryption is off on this device.');
			refresh();
		},
	).open();
};
