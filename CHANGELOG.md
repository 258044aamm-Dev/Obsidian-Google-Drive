# Changelog

All notable changes to this fork of [Obsidian Google Drive](https://github.com/RichardX366/Obsidian-Google-Drive) (plugin id `google-drive-sync`). The fork starts from upstream 3.1.1. The Google Drive format is unchanged, so devices on the original plugin still work with the same Drive vault.

Releases: https://github.com/258044aamm-Dev/Obsidian-Google-Drive/releases

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
