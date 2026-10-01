# Changelog

All notable changes to this fork of [Obsidian Google Drive](https://github.com/RichardX366/Obsidian-Google-Drive) (plugin id `google-drive-sync`). The fork starts from upstream 3.1.1. The Google Drive format is unchanged, so devices on the original plugin still work with the same Drive vault.

Releases: https://github.com/258044aamm-Dev/Obsidian-Google-Drive/releases

## 3.11.0 - 2026-10-01

### Added
- **A floating button that shows what is waiting, on phones and tablets.** On a phone the ribbon is hidden in a menu, so the counts on the Push and Pull icons (3.9.0) were never in sight. A small round button now stays on the screen:
  - **up arrow + number:** changes made on this device that Google Drive does not have yet. Tap it to Push (same as the Push icon).
  - **down arrow + number:** changes waiting on Google Drive. Only with **Check Google Drive for waiting changes** switched on. Tap it to Pull.
  - A half only shows while its number is above 0, and the button is gone when nothing is waiting. While a sync runs it shows a turning arrow instead of the numbers. It steps aside while the on-screen keyboard is open. Tapping it during a sync does nothing.
  - **Moving it:** press and hold for about a third of a second, then drag. When you let go it snaps to the nearer side of the screen and the place is remembered on this device. It starts at the bottom-right, above the bottom bar, clear of the notch. **Reset position** (in the Advanced settings) puts it back.
  - On by default on phones and tablets, never on a desktop (where the ribbon counts and the status bar work). The Advanced settings have **Show a floating button** to turn it off; on a desktop that setting is not shown.

### Notes
- Nothing else changed: Push, Pull, the pending list and the ribbon counts are as before. The button only shows the same numbers and runs the same actions as the ribbon icons.
- Not verified on a real phone: how it looks next to your theme and navigation bar, and the long-press drag on a touch screen. Tests cover the numbers, the tap, the drag with a simulated page, the saved position and the keyboard.

## 3.10.3 - 2026-10-01

### Changed
- **A folded section is one big button.** The folded **Advanced** section and the folded **Commands** section each show a card below their heading that says what is inside (Commands used to show nothing there). Click or tap anywhere on the card to open the section; with the keyboard, focus the card and press Enter or Space. The small arrow next to the heading still works, and it is what closes an open section. Nothing else changed.

## 3.10.2 - 2026-10-01

### Changed
- **The settings page is shorter: an Advanced section holds the rest, and starts folded.** A new user sees only what is needed to connect and sync: Getting started, Get refresh token, Refresh token, Sync now, Pull when Obsidian starts, Automatically push changes and Move deleted files to Google Drive Trash. Under the heading **Advanced** a line says what is behind the arrow. Press the arrow to show everything else: the ribbon counts and the Drive check, the ignore list, which settings files sync (settings, themes, snippets), version history, end-to-end encryption, the connection settings (access token endpoint, client ID and secret) and diagnostics. The **Commands** section is part of it: it appears under Advanced once that is open, and keeps its own arrow (folded).
- Nothing was removed, renamed or reset: every setting keeps its name, its place in the stored settings and its value. The choice to unfold is kept while Obsidian runs and starts folded again after a restart.

## 3.10.1 - 2026-10-01

### Changed
- **The Commands section of the settings page can be folded, and starts folded.** It shows the heading "Commands" and a small arrow button; press it to show the search box and the list of commands, press it again to hide them. The choice is kept while Obsidian is running. The commands themselves, their order, the search, the Run buttons and the command palette are unchanged.

## 3.10.0 - 2026-10-01

### Added
- **Ignore list.** A new text box in the settings, **Ignore list**: one pattern per line for files and folders that sync leaves alone. Use it for a file that every device writes to, such as `BRAT-log.md`, which would otherwise be a conflict on every sync.
  - A name such as `BRAT-log.md` or `*.tmp` matches at any depth. A pattern with a `/` at the start or in the middle starts at the vault root (`Daily/*.md`, `/Inbox`). `*` matches within one name, `**` also across folders, `?` is one character. A `/` at the end is allowed (`Archive/`). A folder covers everything inside it. Lines starting with `#` are notes. Upper and lower case are the same. There are no exceptions with `!`.
  - An ignored path is never uploaded, never deleted on Drive, never pulled, never counted (Push guard, ribbon badges, Sync doctor) and never a conflict. Marks that were already pending for it are dropped when the list changes. The files themselves are not touched, here or on Drive.
  - A file that is already on Drive stays there. If the Drive copy is deleted or the folder around it is removed on another device, the ignored file on this device is kept (and so is its folder).
  - **Renaming** is a delete of the old name plus a create of the new one: a synced file renamed to an ignored name is removed from Drive under its old name and kept here; an ignored file renamed to a normal name is uploaded.
  - The list is saved on this device only (the plugin's folder is never synced). Use the same list on every device. **Ignored files** below the box shows how many files in this vault match.
  - Take a pattern out and the next Push uploads what was changed in the meantime, and the next Pull treats the file like any other (a file that differs on both sides keeps both versions).
  - The matcher is a small automaton, not a regular expression: no pattern can be invalid or slow. `*` or `**` alone ignores everything, so check the count under the box.

### Notes
- With an empty list nothing changes. The restore-point history is not affected by the list (it records and restores Drive as it is).

## 3.9.0 - 2026-10-01

### Added
- **Counts on the ribbon icons.**
  - **Push icon:** a small number shows how many changes are waiting on this device (the pending list), `99+` above 99. The icon's tooltip says it too. It costs nothing and updates as you work. On a phone the ribbon is in the side menu, so the number shows when that menu is open. While a sync runs the icon spins and the number is hidden.
  - **Pull icon (opt-in, off by default):** how many changes are waiting on Google Drive. Turn on **Check Google Drive for waiting changes** in the settings. The plugin then asks Drive once, about 10 seconds after Obsidian has started, and every 15 minutes while the app is open (two small requests each time: the files changed since the last sync and the removals). It never asks during a sync or while the app is in the background, and it only reads. A Pull sets the number back to 0. The number is a hint: your own uploads are not counted, folders are not counted, and Pull still decides what to do.
  - Both counts can be switched off together with **Show counts on the ribbon icons** (on by default).

### Notes
- The count on the Push icon is the length of the pending list, so notes with a stale mark are counted too. **Repair sync memory** (3.8.3) removes marks that are not real.
- Pull, Push, the guard, conflict copies and the Drive format are unchanged. The desktop status-bar button is unchanged.

## 3.8.3 - 2026-10-01

### Added
- **Command "Repair sync memory (keeps your notes)"** (also in the settings list of commands). For a device that gets a "(Drive date)" copy at every Pull and whose note never updates.
  - **Cause (confirmed on a real phone with "Compare with Google Drive"):** older versions marked every note a Pull wrote as "changed here", and a device that never pushes keeps those marks for ever. With no remembered synced state for such a note, Pull cannot tell an edit from a false mark, so it keeps your old note and saves Drive's version as a copy. Keeping your note means it is never downloaded, so the state is never recorded and the next Pull does the same.
  - **What it does.** It looks at every note that is marked as changed here and that Drive knows (nothing else), shows what it would do, and asks first:
    - unchanged since the last sync, or exactly the same as Drive: the mark is removed and the synced state is recorded;
    - edited here since the last sync: kept as it is (Push uploads it);
    - different from Drive and **older here than on Drive**: Drive's version replaces it, and your old version is saved next to it as `Note (this device DATE).md`, so nothing is lost;
    - different from Drive and as new or newer here: kept as it is.
  - A note you change while the window is open is left alone. Cancelling changes nothing. It does not move the position in Drive's change list, so the next Pull still gets everything.
  - After the repair a Pull simply updates these notes (no more copies), because the device now remembers them.
- **Sync doctor:** a "Pending list" line names the notes that are marked as changed with no remembered state, and points to the new command.

### Notes
- Pull, Push, the guard and the Drive format are unchanged. Copies named "(this device DATE)" are new files like any other: the next Push uploads them, so the other devices get them too. Delete the ones you do not need.
- The choice between "older here" and "newer here" is made from the note's modified time on this device against Drive's, so a device clock that is wrong can send a note to the wrong side. Either way the version that is replaced is kept as a copy.

## 3.8.2 - 2026-10-01

### Added
- **A "Commands" section on the settings page.** Every command of this plugin is listed there, with a **Run** button, so you can use them without the command palette (handy on a phone).
  - A search box filters the list by name, description, command id or group (Sync, Checks, History, Repair, Help).
  - Each row says what the command does to your data: *Read-only*, *Changes data* or *Destructive*. The two destructive commands (**Reset local vault to Google Drive** and **Fix Google Drive paths**) have a red Run button. Reset asks for confirmation itself; Fix Google Drive paths now also asks when you run it from this list (it clears the list of pending changes). From the command palette it behaves exactly as before.
  - Without a refresh token only the tour can be run; the other buttons are disabled and say why.
  - A hint explains where to give a command a hotkey (Settings → Hotkeys, search "Google Drive").

### Changed
- The commands are defined once, in `helpers/commands.ts`. The command palette and the new settings list both read that list, so they cannot differ. Command ids and names are unchanged (hotkeys keep working). A test fails if a command is registered anywhere else or if an id or name changes.

### Notes
- Nothing else changed: Push, Pull, conflict copies, the guard, settings files and the Drive format are as in 3.8.1.

## 3.8.1 - 2026-10-01

### Fixed
- **Pull made a "Note (Drive YYYY-MM-DD).md" copy for every note that was only changed on the other device.** Reported on a phone: desktop, phone and Drive were identical, a note was edited on the desktop and pushed, nothing was touched on the phone, and the phone's Pull kept the old note and saved the new text as a copy.
  - **Cause (reproduced in the simulation, not yet on a real phone):** after a Pull wrote a note, Obsidian reported that file change *later* (a phone reports file changes from its file watcher, after the write call has returned). The plugin took the report for an edit made on the phone and marked the note as changed; the next Pull saw "changed on both devices". The mark was only checked for existing, never against the note's content.
  - **Pull now judges by content.** A note marked `create` or `modify` whose content is exactly what it was at the last sync (same content fingerprint) is not an edit: the mark is dropped and the Drive version is taken, with no copy. A real edit, an edit with a remembered state that differs, or a note with no remembered state behaves exactly as before (your version is kept, Drive's goes to a copy).
  - A late report can still leave a mark on a note that did not change. That is harmless: the next Pull ignores it (as above), and a Push of such a note uploads the same content it already has.
  - The Sync doctor lists notes that are marked as changed but identical to the last sync ("Pending list ... false alarm"), read-only.
  - The diagnostics now say why a copy was made (which rule fired, which mark, what was remembered) and when a false mark was ignored.
  - Nothing is lost by this: the shortcut only applies to a note that equals what Drive had at the last sync, and Drive's version history keeps that content.

### Changed
- Test suite: the known-failing scenario "S5b a phone that inherited stale pending ops never overwrites a newer desktop edit" (it was marked as an expected failure) now passes and is a normal test. Its encrypted variant had only "failed" because the test could not find the file; it now looks it up the right way. The simulated vault can deliver file reports late (`lateEventsMs`; `SIM_LATE_EVENTS=30 npx vitest run tests/sim` runs everything that way; many older scenarios are timing-sensitive in that mode, with or without this fix: 132 failures before, 69 after).

### Notes
- Nothing else changed: Push, the guard, conflict copies for real edits, settings files and the Drive format are unchanged. A Push still uploads a note that was saved again with identical content, as before.
- Not verified on a real device: whether Obsidian on your phone reports file changes late in exactly this way. If copies still appear, run the Sync doctor before the Pull and "Copy diagnostics" after it; the new entries show the reason.

## 3.8.0 - 2026-10-01

### Added
- **A slow or unstable connection no longer freezes or breaks a sync as easily.**
  - **Time limits:** every request to Google Drive has a time limit (30 s for small requests, longer for uploads in proportion to their size, 2 minutes for downloads). A request that never answers is given up on instead of waiting for ever.
  - **Quiet retries:** reading, updating by id and deleting are repeated up to 3 times (after about 1, 3 and 9 seconds) when Google answers 429, 500, 502, 503 or 504 or when the connection fails. `Retry-After` is honoured (at most 30 s). All retries of one sync together are limited to about one minute, after which the sync stops with the usual message. Refusals (400, 401, 403, 404 ...) are never retried.
  - **Creating files and folders is never repeated blindly.** If the answer to a create is lost, the file may exist on Drive already. Before trying again the plugin looks for it (twice after a lost connection, with a short wait between) and uses it if it is there, so nothing is duplicated. If it cannot find out, it stops and reports the original problem. A delete that is repeated and finds the file already gone counts as done.
  - **Clearer messages:** when a failure was the connection, the Push message adds "The connection to Google Drive was lost or too slow. ... Press Push again when the connection is back." (the existing text is unchanged), and a Pull shows one extra notice. Refusals from Google do not say this.
  - **"Online, but Google Drive cannot be reached"**: before a Push, Pull or Reset the plugin also checks that `www.googleapis.com` answers. If a firewall, VPN or network filter blocks only Google, it says so and stops before doing anything.
  - **Phones:** the screen is kept on while a sync runs (where the system allows it; released when the sync ends or fails), a notice asks to keep the screen open, and when the app comes back after more than 5 seconds in the background during a sync a notice says to press the button again if it did not finish. The plugin cannot stop the system from pausing the app; an interrupted sync is safe to repeat.
  - **Sync doctor** shows a "Connection" line (how long one small request to Google took).
  - Retries are recorded in the diagnostics.

### Changed
- Test suite: the simulated tests turn retries off by default (`tests/setup-net.ts`) because they inject single failures; one existing test (`tests/sync-fix.test.ts`) got `Platform` added to its mocked `obsidian` module. `NET_RETRY_ON=1 npx vitest run` runs everything with retries on: only one test then differs (a single injected 503 is now absorbed by a retry, which is the intended behaviour).

### Notes
- No change to the Drive format, to what is synced, or to existing messages (new text is only added).
- Not changed: `requestUrl` cannot be cancelled, so a request given up on may still finish in the background; its answer is ignored. In rare cases Drive's search can lag behind a create, so after a lost answer a duplicate file is possible; the plugin looks twice to make this unlikely.
- Not verified on a real device: behaviour on a phone with the screen locked, and the time limits on a very slow mobile connection.
- Ignore paths and a large-file limit are still planned for a later release.

## 3.7.2 - 2026-10-01

### Changed
- **Encryption is now clearly marked as an advanced option for beginners.** Wording and button emphasis only; encryption itself and syncing are unchanged.
  - **Tour, encryption step:** starts with a bold warning ("Beginners: do not turn this on. Skip this step."), lists the risks (a lost passphrase cannot be recovered by anyone, a separate encrypted copy on Drive, the same passphrase on every device, no Drive preview or search), and says it can be turned on later. "Skip this step" is the highlighted button; the action button is quiet, is called "Set up encryption (advanced)..." and asks "This is for advanced users" first, with Cancel highlighted.
  - **Settings, End-to-end encryption (when off):** starts with "Advanced option: if you are a beginner, leave this off."
  - **"Turn on end-to-end encryption" window:** a warning at the top and a box "I understand that nobody can recover my notes without the passphrase." that must be ticked before "Turn on" works. The unlock, change-passphrase and turn-off windows are unchanged.

## 3.7.1 - 2026-10-01

### Fixed
- **The getting-started tour's buttons had no spacing or alignment.** The step's own buttons (for example "Open the sign-in page", "Pull now...") now sit in a row with a gap and wrap to full-width buttons on a phone. The navigation is a separate footer under a divider: Back and "Skip tour" on the left, "Skip this step" and Next on the right (on a phone, stacked with Next first). The three switches are aligned rows. The first-run notice buttons and the Pull confirmation window use the same layout. A hint explains why the buttons are greyed out before Google Drive is connected.
- No change to syncing; only the tour window and `styles.css` changed.

## 3.7.0 - 2026-10-01

### Added
- **Themes and CSS snippets are synced** (`themes/<name>/theme.css`, `themes/<name>/manifest.json`, `snippets/*.css` in the configuration folder). Other files in those folders are not synced. They travel like the other settings files (and are encrypted when end-to-end encryption is on).
- **Three switches in the settings, all on by default:** settings files and other plugins' files, themes, snippets. A switched-off kind is not uploaded, not downloaded and not deleted (locally or on Drive); switching one off later deletes nothing. A restore from version history also leaves a switched-off kind alone. A one-time notice informs existing users.
- **Getting-started tour** (8 steps, each skippable; "Skip tour"): offered once, with a small notice, to a device that has no token, nothing synced and no earlier tour state; also from the settings ("Getting started") and the command "Open the getting-started tour". Actions inside (open the sign-in page, open the settings, Pull, Push, set up encryption, Sync doctor) run only after the user presses the button, and Pull asks for confirmation first. Progress is saved so the tour can be continued.

### Fixed
- **A device that never had a settings file could delete it from Drive.** Push removed a settings/plugin/theme/snippet file from Drive when it was missing locally, with no check that this device had ever had it. Now it is removed only if this device pulled or pushed it before (a remembered state). After the first successful sync after the update, existing files get that remembered state, so deletions are passed on again; before it, a local deletion of a settings file is not passed on (the safe direction).

### Notes
- New optional settings fields: `syncConfigFiles`, `syncThemes`, `syncSnippets` (absent = on), `themeNoticeShown`, `tourState`. The Drive format is unchanged. Existing settings-file rules are unchanged.
- Themes and snippets that already exist on a device are uploaded at its first Push even if they are old (they were not synced before); files already on Drive are not uploaded again unless changed.
- Not changed: ignore paths and the large-file limit (moved to 3.8.0). Unverified on real Obsidian: how the tour looks on a phone, and whether Obsidian creates the theme folders on a device that has none (the plugin already relies on this for plugin folders).

## 3.6.4 - 2026-10-01

### Fixed
- **A Push that was interrupted (connection lost) can now simply be repeated.** Found by simulating a lost connection at each step of Push and Pull:
  - **Notes and folders were uploaded twice.** The pending list was emptied only after *all* uploads had succeeded, so after an interruption the notes that had already reached Drive were created again, and a new folder was created twice (the phone then pulled the copy and queued yet another upload). This came from the fork's "Push never pulls" change (upstream's Push began with a full Pull, which hid it). Now each note, folder and delete is removed from the pending list the moment it is done on Drive, and progress is saved as the Push goes.
  - **A Push could get stuck** with "could not identify all drive files to delete" on every attempt (this was also in upstream 3.1.1): the deletes were done on Drive and their ids forgotten, but the pending "delete" entries stayed. They are now cleared together, and a pending delete whose Drive file is no longer known is dropped (Drive is not touched) instead of stopping the Push.
  - **An interrupted Pull left false "deleted here" entries** (`note.md: delete`) in the pending list, and the next Push re-uploaded identical notes. Pull now takes back the ids of files that never reached this device.
- A failed batch of uploads or downloads now waits until every request of that batch has finished before it reports the failure, so nothing keeps changing files in the background after "failed".

### Changed
- The Push failure message says how far it got: "3 files were uploaded before it stopped and 3 changes are still pending. Press Push again", or, when only the last step failed, "after everything was uploaded… nothing will be uploaded twice".
- Not changed: timeouts and automatic retries (planned together with 3.7.0). The Drive format is unchanged.

## 3.6.3 - 2026-10-01

### Fixed
- **Pull no longer overwrites a note that was edited on this device without the plugin noticing.** Before, a note with no pending edit was always replaced by Drive's version, so an edit whose event was lost (and not yet found by the missed-edit scan) could be lost. Now Pull compares the note with the state remembered when it last matched Drive (modified time, size and, new in this version, a short content fingerprint). If the content really changed here, your version is kept, Drive's version is saved next to it as `name (Drive YYYY-MM-DD).md`, the note is marked to be pushed, and a Notice says so. A note that was only touched (same content) or whose content equals Drive's is not treated as edited, so no needless copies are made.
- **A note deleted on Drive but edited here is kept** and uploaded again at the next Push (also for notes inside a folder deleted on Drive).
- Unchanged behaviour: a note with nothing remembered (a vault just copied or joined) is overwritten by Drive as before, so a device with a stale copy gets no flood of copies; a note edited with a pending edit is handled as before; notes changed only on Drive are updated as before.

### Changed
- The remembered state of each note gains an optional content fingerprint (first 16 bytes of SHA-256, stored only in this device's plugin settings; never uploaded). States saved by 3.6.2 without it still work: a different size counts as an edit, a different time alone does not. The Drive format is unchanged.

### Documentation
- The two Remotely Save comparison documents wrongly said the encrypted Drive vault hides the folder tree. It does not: Drive folders mirror the vault's folders with opaque names, so Google sees the tree shape (like Remotely Save's rclone mode; only its OpenSSL mode is flat). Corrected.

## 3.6.2 - 2026-09-30

### Fixed
- **A false "changed both on this device and on Google Drive" stop.** "Push without pulling" does not move this device's sync position (on purpose), so the next Push saw this device's *own earlier upload* as a change made on Google Drive and stopped. The device now remembers the exact time Drive gave each of its own uploads and no longer counts those. A change made by another device still stops the Push, as before, and the message now says so.
- **The same edited notes were added and uploaded again by every Push** (for example after copying a vault to a phone: 219 notes each time). Each note's modified time and size are now remembered when it is uploaded, downloaded or found identical to Drive. A note counts as edited only when it differs from that. Notes with nothing remembered behave as in 3.6.1, and get a remembered state after their first Push or Pull.
- An edit whose event was lost is now also found when it is older than the last Pull (before, only notes newer than the last sync were looked at).

### Added
- **The Push result checks Drive.** After uploading, up to 20 of the uploaded files are looked up on Google Drive (size and Trash) and the message says so ("Checked 3 uploaded file(s) on Google Drive: all present."), or warns which ones do not look right. With encryption on it reminds you that the Drive website shows only random names.
- **Command: "Compare the open note with Google Drive (read-only)."** Shows the note's size and time on both sides, whether it waits to be pushed, whether Drive's copy is this device's own upload, and whether the content is the same after decrypting. Read-only.

### Changed
- Settings gain two optional fields (`ownUploads`, `syncedFiles`); nothing is needed from older settings and the Drive format is unchanged. Turning encryption on or off clears them.

### Tests
- Simulator tests for two Push-without-pulling in a row, a real conflict in between, a 60-note copied vault, a lost edit older than the last sync, and the Push result; unit tests for the remembered state, the Drive check and the compare report. Each was checked to fail without its fix.

## 3.6.1 - 2026-09-30

### Fixed
- **Settings rows showed only their buttons** (no title, no description). This hit *End-to-end encryption*, *Sync now*, *Version history* and *Diagnostics*: the rows were cleared after the title and text had been written into them. They now keep their title and description.
- Turning encryption on with the second passphrase box left empty now says "Type the passphrase a second time" instead of "The two passphrases are different". The same for changing the passphrase.

### Tests
- A test that a settings row keeps its title, description and buttons, and one for the two passphrase messages.

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
