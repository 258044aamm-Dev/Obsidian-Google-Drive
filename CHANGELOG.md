# Changelog

All notable changes to this fork of [Obsidian Google Drive](https://github.com/RichardX366/Obsidian-Google-Drive) (plugin id `google-drive-sync`). The fork starts from upstream 3.1.1. The Google Drive format is unchanged, so devices on the original plugin still work with the same Drive vault.

Releases: https://github.com/258044aamm-Dev/Obsidian-Google-Drive/releases

## 3.6.0 - 2026-09-30

### Added
- **End-to-end encryption (optional, off by default).** File contents **and** file and folder names are encrypted on your device before they are sent to Google Drive. Google, and anyone who gets into your Google account, then see only random names and unreadable data. Turn it on in the plugin settings under *End-to-end encryption*.
  - It starts a **new** encrypted vault folder on Drive next to your current one. Your current Drive vault is not changed or deleted, and a device that you do not switch keeps using it.
  - **Switch the desktop first**: it creates the encrypted vault and its next Push uploads everything, encrypted. Then switch each other device with the same passphrase and press Pull.
  - AES-256-GCM, key from your passphrase (PBKDF2-SHA-256, 600,000 rounds) wrapping a random data key. Each file is bound to its path, so Drive cannot swap or move files without the plugin noticing. A changed, damaged or swapped file is never written into your vault: Pull reports it, pulls the rest and tries again next time.
  - The key stays on the device (non-extractable, in the app's own storage) after you type the passphrase once. A device that lost it syncs nothing until you enter the passphrase again. **A lost passphrase cannot be recovered.**
  - Change the passphrase without re-uploading anything. Turn encryption off to go back to the plain vault.
  - Version history works with encryption: restore points are encrypted too.
  - Sync doctor reports whether encryption is on and whether this device has the key.

### Changed
- (Only while encryption is on) Drive web preview and Drive search cannot read your notes; the README's "download the vault folder" method for new devices does not work for an encrypted vault.
- `updateFile` and `getFile` take the vault path (used to check encrypted files); nothing changes when encryption is off.

### Tests
- New `tests/crypto.test.ts` (round trips, wrong passphrase, every changed byte, swapped paths, Unicode and long paths) and `tests/sim/e2ee.test.ts` (nothing readable on Drive, changed / swapped / planted files, wrong and missing key, changing the passphrase, switching on and off, version history, doctor).
- The whole two-device regression suite also runs with encryption on (`npm run test:e2ee` runs every simulated scenario that way).

### Limits
- Google still sees how many files you have, the folder shape, file sizes (+33 bytes), and when files change. A Drive account holder can delete or roll back files without the plugin being able to tell. A weak passphrase can be guessed offline (the salt and wrapped key are stored on Drive): use a long one.
- Not tested against real Google Drive or real Obsidian on a phone (simulation only). Try it on a copy of your vault first.

## 3.5.2 - 2026-09-30

### Added
- **Sync doctor shows the Google permission** of this device's token (one read-only request to Google's `tokeninfo`). `drive.file` is reported as "only files this plugin created". A broad Drive permission (`drive`, `drive.readonly`, `drive.metadata`, ...) raises a warning with how to revoke it. The token itself is never shown.

### Tests
- Emptied folders are removed on every device (12 cases; they fail on upstream 3.1.1 and pass here).

## 3.5.1 - 2026-09-30

### Fixed
- **Config and plugin files no longer bounce between devices** (upstream issue #55). Files that a Pull downloaded were counted as changed on that device and uploaded again by the next Push. A settings file you really changed and did not push yet is still pushed.

## 3.5.0 - 2026-09-30

### Added
- **Status bar button (desktop)**: `Drive`, `Drive 3` (pending changes on this device) or `Drive …` while syncing, next to the word and character counts. Click it for a menu: Pull, Push, Sync doctor, Restore the whole vault from history, Create a restore point now. Not shown on the phone (Obsidian mobile has no status bar).

## 3.4.1 - 2026-09-30

### Changed
- **Push no longer pulls.** Push only checks whether Google Drive has changes this device has not pulled. If it has, Push stops and changes nothing, and tells you to Pull first. Pull is the only action that changes files on this device (besides a visible restore).
- New **Push without pulling** button. It refuses items changed on both sides. The sync position is not moved, so the next Pull still brings in everything.

### Added
- **Missed-edit check**: before Push, notes written after the last sync but missing from the pending list are compared with their Drive copy and added if they differ. The Push window says "Nothing to push" instead of an empty list.
- Sync doctor shows how many vault events the plugin has seen since it loaded (0 means change tracking is not working).

### Fixed
- A rename was counted twice in the event counter.

## 3.4.0 - 2026-09-30

### Added
- **Version history for the whole vault**: a restore point after every successful Push (a list of every file with its Drive id and version), kept for 1 to 30 days (default 10). Commands and settings buttons to create a restore point and to restore the whole vault. A restore changes this device only and saves a restore point of the current state first, so it can be undone. You then Push to apply it to Drive.

## 3.3.0 - 2026-09-30

### Added
- **Deleted files go to the Google Drive Trash** instead of being deleted forever (setting, on by default). Pull notices trashed files without relying on the changes feed.
- **Conflicts keep both versions**: a note changed on Drive and on this device stays as it is here, and the Drive version is saved as `Note (Drive YYYY-MM-DD).md`.
- **Push warning** when a Push deletes more than 20 items or more than 25% of the tracked items.
- Sync doctor checks the device clock against Google, Obsidian's "Deleted files" option and the Drive deletion mode.

## 3.2.0 - 2026-09-30

### Changed
- **Manual sync by default**: no pull when Obsidian starts (opt-in setting `Pull when Obsidian starts`) and no automatic Push (opt-in setting `Automatically push changes`).
- Pull never leaves empty "ghost" folders and never deletes local content it should keep (this also fixes upstream's emptied folder coming back on the other device).
- Deleted ids are kept until the deletion has really been applied. The migration only merges.

### Added
- **Sync doctor**: a read-only comparison of this device with Google Drive (files deleted on Drive, files only on Drive, new local files, duplicate paths, pending operations).
- Pull ribbon icon, and Pull / Push / Sync doctor buttons in the settings.

### Fixed
- The plugin's own folder is never synced.
- A Drive 404 while deleting counts as success.
- A Pull handles Drive feeds that leave out the contents of a deleted folder.
- Missing parent folders are created during a Pull.

## 3.1.1 and earlier

See the [upstream releases](https://github.com/RichardX366/Obsidian-Google-Drive/releases).
