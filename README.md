# Google Drive Sync

This is an unofficial sync plugin for Obsidian, specifically for Google Drive.

## Update Notice

If you are updating your plugin from 2.x.x to 3.x.x, the plugin now fixes Google Drive file paths automatically the first time it syncs — no manual step is needed. This repairs Obsidian's understanding of Google Drive's file system, which could be inconsistent after the 2.x.x deleted-file handling issue. The "Fix Google Drive paths" command remains available if you ever need to run it manually.

## Manual sync (fork 3.2.0)

This fork is **manual by default**. Nothing is pulled or pushed unless you ask for it:

- **Pull** (cloud icon in the ribbon, the `Pull from Google Drive` command, or the **Pull** button in the plugin settings) brings Drive's state to this device: new and changed files are downloaded, and files or folders deleted or moved on Drive are removed here.
- **Push** (sync icon in the ribbon, the `Push to Google Drive` command, or the **Push** button in settings) sends this device's changes to Drive.
- **Sync doctor** (command or settings button) compares this device with Drive and shows what a Pull or Push would do. It only reads; it never changes anything.
- `Pull when Obsidian starts` and `Automatically push changes` are both **off** by default.

Fixes in 3.2.0 compared with 3.1.x:

- Folders deleted or moved on another device are now removed on a Pull. Before, empty "ghost" folders stayed behind and the next Push put them back on Drive.
- A folder that still holds local-only notes is never deleted by a Pull; those notes are kept and uploaded on the next Push. Notes you edited on this device inside a folder that was deleted on Drive are kept too and uploaded again.
- A folder deleted on Drive is removed together with its unedited, already-synced contents, even if Drive only reports the folder itself.
- If a Pull is interrupted, the next Pull still knows which local files Drive had deleted, so they are not uploaded again.
- The plugin's own folder (`main.js`, `manifest.json`, `data.json`) is never synced. `data.json` holds your tokens and pending operations, and overwriting it or deleting it from another device could break sync.
- The one-time path migration only adds information; it no longer replaces the saved id map.
- Deleting a file that is already gone on Drive (HTTP 404) counts as success instead of failing the whole Push.

Upgrading from 3.1.x: it is safe to install over the existing plugin folder on one device at a time. The Drive metadata format has not changed, so devices on 3.1.1 and 3.2.0 can share one Drive vault. Back up your vault first.

## What is new in 3.4.1: Push no longer pulls

Until now (as in the original plugin) every Push began with a hidden Pull, which could download, overwrite or delete files on this device without you pressing Pull. That is gone:

- **Push only looks.** Before uploading, Push asks Google Drive whether anything changed since this device last synced. If so, it **stops and changes nothing**, on this device or on Drive, and tells you: *Press Pull first, then Push.*
- **Pull is the only thing that changes files on this device** (besides restoring from version history, which says so).
- The Push window has a third button, **Push without pulling**. It uploads your changes even though Drive has newer changes that you have not pulled, **unless an item changed on both sides** (same note, a note inside a folder that was deleted or moved on Drive, a folder you deleted that got a new file on Drive, and similar). Those are refused and listed; Pull first so both versions are kept.
- After a Push without pulling the sync position is **not** moved forward, so the next Pull still brings in everything you skipped. That Pull may re-download files you just uploaded (same content); nothing is lost. If you edit such a note between the two, you may get a `(Drive YYYY-MM-DD)` copy of your own upload; delete it.
- The original plugin still pulls before it pushes. Devices on the original plugin are not affected, and the Drive format has not changed.

## What is new in 3.4.0: version history for the whole vault

After **every successful Push** the plugin saves a small **restore point** on Google Drive: a list of every file in the vault with its Google Drive id and version. Google Drive itself keeps the older versions of files (and deleted files in its Trash) for about 30 days, so a restore point is enough to take the whole vault back to that moment. Your notes are not stored a second time.

- **Where:** a folder named `<vault name> - Obsidian Google Drive history (do not edit)` at the top level of My Drive, next to (not inside) the vault folder. Do not delete or edit it. Other devices, and the original plugin, never treat it as vault content.
- **Settings:** *Save a restore point after every Push* (on by default) and *Keep restore points for (days)* (1 to 30, default 10). Older restore points are deleted after each Push; the newest is always kept. More than 30 days makes no sense, because Drive forgets old versions after about that long.
- **Commands:** `Create a restore point now (version history)` and `Restore the whole vault to an earlier restore point (version history)` (also buttons under *Version history* in the settings).

### How a restore works

1. The restore only starts when this device has nothing waiting to be pushed, and **Automatically push changes** is off. It then runs a normal **Pull**, so the device is level with Drive.
2. You choose a restore point and see what would change: files that go back to their old content, deleted files that come back, and files created since then that are removed (through Obsidian's own *Deleted files* setting). Files whose old version Drive no longer has are listed and left alone.
3. Before anything changes, a restore point of the current state is saved. **To undo a restore, restore that point.**
4. The restore changes **this device only**. Nothing is uploaded. Look through the vault, then press **Push**: its confirmation lists everything that will change on Drive, with the red warning for large deletions.

The checkbox *Also restore settings and plugin files* (on by default) covers the files in the configuration folder that this plugin syncs (settings files and the files of your other plugins). Themes and snippets are not synced by this plugin, so they cannot be restored. This plugin's own folder is never touched. Restart Obsidian after restoring settings or plugins.

### Limits to know about

- Only Pushes made from devices running this fork create restore points. Restore points are per Push, not per edit. (Obsidian's core *File recovery* plugin is a useful extra for per-note snapshots on one device.)
- Restore points and old versions are kept by Google Drive for about 30 days at most. If the option *Move deleted files to Google Drive Trash* is off, a file deleted from Drive is gone for good and cannot be brought back.
- Old file versions and trashed files use Google Drive storage until Drive removes them.
- If something cannot be downloaded, the restore reports it and carries on with the rest. Push what was done, then run the restore again.
- Restoring plugin files can surprise those plugins: restart Obsidian, and use the checkbox to leave them out if unsure.
- I could not test this against a real Google Drive. Try it on a copy of the vault with its own Drive folder first.

## What is new in 3.3.0

3.3.0 is built on 3.2.0 (manual Pull and Push) and adds three safety features. Nothing else about how Pull and Push work has changed.

### Deleted files go to the Google Drive Trash

When you Push a deletion, the file or folder is **moved to the Google Drive Trash** instead of being deleted forever. This is controlled by **Settings > Google Drive Sync > Move deleted files to the Google Drive Trash** and is **on by default**.

- In Google Drive, open **Trash** to restore something. Drive empties its Trash after about 30 days.
- A Pull on your other devices notices trashed files and removes them there, like any other deletion.
- Trashed files still count toward your Google Drive storage until the Trash is emptied.
- **Every device that syncs the vault must run this fork (3.3.0 or newer).** A device still on the original plugin does not see trashed files as deleted and would keep them (and could upload them again). If you must keep such a device, turn the setting off.
- Restoring a file from the Drive Trash brings it back in Drive. Whether other devices then download it on the next Pull depends on Google Drive; if it does not show up, edit or re-save the note on the device that still has it and Push.
- Turn the setting off to go back to permanent deletion (the behaviour of 3.2.0 and the original plugin).

### Changed on Drive and on this device: both versions are kept

Before 3.3.0 the local version silently replaced the Drive version. Now, if a **note** was changed on Drive *and* also changed on this device (not pushed yet), a Pull:

- keeps this device's version in place, and
- saves the Drive version next to it as `Note (Drive YYYY-MM-DD).md` (`-2`, `-3`, ... if needed), then uploads that copy on your next Push.

Nothing is overwritten and nothing is lost. Review the copy, merge what you need, and delete it. A Pull shows a notice when it made a copy (search your vault for `(Drive `). If both versions are identical, no copy is made. Running the same Pull twice does not make a second copy. This applies to notes only, not to settings or plugin files.

If a device's clock is wrong, you can get a copy that you did not need (harmless, just delete it). The **Sync doctor** now warns when a clock is more than a minute off Google's.

### Warnings

- **Push confirmation:** if a Push would delete more than 20 items, or more than 25% of the items on Drive, a red warning appears above the list. You can still Cancel, or undo single entries with the trash button.
- **Sync doctor:** also reports the clock difference from Google, warns if Obsidian's **Deleted files** option is **Permanently delete** (a Pull that removes files here could then not be undone), and shows whether Drive deletions go to the Trash.

### Installing with BRAT

In the BRAT plugin choose **Add Beta plugin** and enter `258044aamm-Dev/Obsidian-Google-Drive`. Install on your phone first, then the desktop, before either of them Pushes. The plugin id is unchanged, so this installs over the existing plugin and keeps your settings and Drive link. Back up your vault first.

## Disclaimer

- This is **not** the [official sync service](https://obsidian.md/sync) provided by Obsidian
- This plugin communicates with external servers, namely the Google Drive API and [https://ogd.richardxiong.com](https://ogd.richardxiong.com)
    - The details of this communication are explained at the bottom of the notes section
    - The code for this website can be found [here](https://github.com/RichardX366/obsidian-google-drive-website)
    - While the website repository uses NextJS edge requests for token refreshing/acquisition, in order to save on costs, I am routing the API requests through a server whose code can be found [here](https://github.com/RichardX366/obsidian-google-drive-server)
        - This does essentially the same thing as the website, but just bare bones.

## Caution

**ALWAYS backup your vault before using this plugin.**

## Features

- Syncing both ways (from Obsidian to Google Drive and back)
- Cross-device support
- Obsidian iOS app support
- Conflicts keep both versions: your local note stays and the Drive version is saved as a copy (3.3.0)
- Multiple vaults per Google account
- Configuration syncing

## New Devices

- If you've already been using this plugin and want to start using it on a new device, then follow these instructions:
    1. Open Google Drive and download the entire Obsidian folder to your new device
    2. Move the Obsidian folder to the location where you want your vault to be
    3. Open Obsidian and set the vault location to the folder you just moved
- If you activate the plugin on a new device without downloading the Obsidian folder from Google Drive, the plugin will start downloading from Google Drive as per a typical sync, which could take an extremely long amount of time depending on the number of notes in Google Drive, but it would still work (we suggest the above method instead)

## Notes

- Do **NOT** manually upload files into the generated Obsidian Google Drive folder or use some other method of Google Drive sync
    - Our plugin cannot see these files, and it will likely break functionality, potentially causing data loss
    - Instead, use this plugin on any device you wish to sync the vault between
- Do **NOT** manually change files outside of the Obsidian app
    - Our plugin tracks file changes through the Obsidian API, and if you change files outside of the app, the plugin will not be able to track these changes
- If you ever encounter the following situation or vice versa, SYNC after you delete/rename it and before you rename/create the file/folder with the exact same path (this error arises from our plugin seeing a file convert into a folder or vice versa) (this doesn't apply for file to file or folder to folder):
    - You have a file that has NO file extension already synced (most files have a file extension so you usually don't have to worry about this)
    - You delete it/rename it
    - You rename/create a folder with the exact same path
- When activating this plugin on a new vault, make sure the vault is empty
    - If you have files that you want to sync to Google Drive from before the plugin, move them to another vault, delete them from the current vault, activate the plugin, and copy them back in **THROUGH THE OBSIDIAN APP**
- We suggest only editing Obsidian notes on one device at a time to avoid conflicts and syncing before editing on another device
    - Our plugin does have code to handle conflicts, but it might not be perfect or as the user expects, so try to avoid them
- Make sure to sync with an adequate internet connection
    - Closing the app or losing connection while syncing could lead to data corruption
- The plugin does NOT have a conflict-resolution screen
    - If a note changed on Drive and on this device, the local version stays and the Drive version is saved as `Note (Drive YYYY-MM-DD).md` for you to review (3.3.0). Settings and plugin files still use local file prioritization
- Do **NOT** change the Obsidian configuration folder
    - If you really want to, make a new vault, change the folder, enable the plugin, and copy your files over (you can move the contents of .obsidian to the new folder through file explorer)
- Vault files and configuration files selected for syncing are stored in Google Drive. They are sent directly between the user's device and the Google Drive API
- By default, the plugin accesses [https://ogd.richardxiong.com](https://ogd.richardxiong.com) to convert the refresh token into an access token (while hiding the client secret) and to check internet connectivity with a simple ping request. Vault contents are not sent to this service
- You can configure a self-hosted access token endpoint in the plugin settings. The refresh token and any optional client ID and client secret are sent to the configured endpoint

## Setup

Note: Instructions are also on this plugin's homepage with images at [https://ogd.richardxiong.com](https://ogd.richardxiong.com)

1. Visit this plugin's homepage at [https://ogd.richardxiong.com](https://ogd.richardxiong.com)
2. Click `Sign In` at the top right and log in with your Google account
3. Copy the refresh token that appears after logging in
4. Enable the Google Drive Sync plugin in Obsidian
5. Paste the refresh token into the plugin settings in Obsidian
6. Reload the Obsidian app

## Use

- After setup, sync manually: Pull before you start editing on a device and Push when you are done
    - Pull is from Google Drive TO Obsidian, not the other way around (pulling cloud files)
    - You can make it pull automatically when Obsidian opens by turning on `Pull when Obsidian starts` in the plugin settings (off by default)
    - The plugin prioritizes unsynced local changes except for local file deletions (cloud file creation/modification will overwrite local deletion)
    - You can pull by running the `Pull from Google Drive` command
    - Pulling new plugins/configurations may require a restart of Obsidian
- To sync local changes to Google Drive, click the sync (Push) button on the ribbon or run the `Push to Google Drive` command from the command palette
    - While you do not have to sync before you close Obsidian, we suggest doing so to ensure that Google Drive is up to date and no conflicts occur
    - Push never pulls. It only checks Google Drive first: if Drive has changes this device has not pulled, Push stops and tells you to Pull first (see 3.4.1)
- You can enable `Automatically push changes` in the plugin settings to push one minute after the most recent local file change. This setting is disabled by default
- Not sure what a Pull or Push would do? Run `Sync doctor (read-only check of this device vs Google Drive)`; it lists files deleted on Drive, files only on Drive, new local files, duplicate paths and pending operations
- `Fix Google Drive paths` is an advanced repair: it rebuilds the saved id map from Drive and clears pending operations. Run `Sync doctor` first; files that were deleted on Drive but still exist locally are then no longer recognised as deleted, so delete them by hand instead of pushing
- If you want to set your local vault state to the Google Drive state, run the `Reset local vault to Google Drive` command
- If you mess with the vault's files while Obsidian is closed, try to revert any of the changes you made

## Multiple Vaults

- The Google Drive folder that gets created upon setup is the root folder for the vault and is tagged with the vault name
    - It is named the same as your vault name, has a matching description, and stores the vault name internally
    - After the folder is created, you can move it anywhere within the same Google Drive account without affecting syncing
    - You can also rename or color the folder in Google Drive without affecting syncing
    - Each file in the vault is also tagged with the vault name inside Google Drive's properties
- Each vault is connected to the Google Drive folder that has the same tag/internal name
    - If you want multiple devices to sync to the same vault, the vault names must match
- You can have multiple vaults per Google account by having local vaults with different names
    - Do NOT rename local vaults that you are syncing to Google Drive
    - Instead, make a new vault, sync it, and transfer your files over
    - We will not add any implementation to automate this process because it inherently messes with other synced devices

Privacy Policy: [https://ogd.richardxiong.com/privacy](https://ogd.richardxiong.com/privacy)
