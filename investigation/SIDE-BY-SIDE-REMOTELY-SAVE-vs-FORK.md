# Remotely Save vs this fork 3.6.2: side by side, one topic at a time

Date: 2026-10-01. "RS" = Remotely Save (master, last commit Nov 10 2024). "Fork" = this plugin, 3.6.2.

Evidence labels: **[doc]** their documentation, **[code]** I read it in their source, **[mine]** my own code or simulator, **[know]** my general knowledge of rclone/Drive, **[?]** not verified. Nothing here was run on a real Drive. I did not copy code from RS (its `pro/` folder is PolyForm Strict).

---

## A. Encryption

### A1. How it is switched on
| RS | Fork |
|---|---|
| A password in settings; empty = plain. Wraps any remote (one wrapper class, so every cloud gets it) **[code]** | A button with passphrase + confirmation; creates a **new** encrypted vault folder next to the plain one **[mine]** |
| Same Drive folder is reused; switching on later means files get re-uploaded in the new form **[doc]** | Old plain vault stays untouched; desktop first, other devices join with the same passphrase **[mine]** |
**Verdict:** Fork is safer to switch (nothing existing is rewritten); RS is simpler.

### A2. Formats offered
| RS | Fork |
|---|---|
| Two: rclone Crypt (base64 names), OpenSSL enc **[doc]** | One custom format `OGDE`, versioned **[mine]** |
| Switching between them: delete the cloud vault by hand and re-sync **[doc]** | Version byte allows a future format; no second format today |
**Verdict:** RS gives choice and standard formats; Fork gives one tested design.

### A3. Password → key
| RS rclone | RS OpenSSL | Fork |
|---|---|---|
| scrypt; called with an empty second salt, so rclone's **fixed built-in salt** **[code]** + **[know]** | PBKDF2-SHA-256, **20,000** rounds, random 8-byte salt per file and per name **[code]** | PBKDF2-SHA-256, **600,000** rounds, random 16-byte salt, once per vault **[mine]** |
| Same password = same key on every vault in the world; precomputed guessing helps an attacker **[know]** | Cheap per guess | Random salt; about 30x the work of RS OpenSSL per guess |
**Verdict:** Fork is stronger. A weak password is still the weakest point for all three.

### A4. Key hierarchy
| RS | Fork |
|---|---|
| Password-derived key encrypts data directly **[code]** | Passphrase unlocks a key-encryption key that wraps a **random 256-bit data key**; subkeys by HKDF **[mine]** |
**Verdict:** Fork's layer is what makes A9 (change passphrase) cheap.

### A5. File content cipher
| RS rclone | RS OpenSSL | Fork |
|---|---|---|
| XSalsa20-Poly1305, 64 KiB chunks **[doc]** | AES-256-CBC **[code]** | AES-256-GCM, fresh 12-byte nonce each upload **[mine]** |
**Verdict:** All strong for secrecy.

### A6. Detecting tampering
| RS rclone | RS OpenSSL | Fork |
|---|---|---|
| Yes, per chunk **[know]** | **No** (CBC, no MAC) **[code]** | Yes, GCM tag; a failing file is never written, Pull reports it and continues **[mine]** |
**Verdict:** RS OpenSSL is the weak one.

### A7. Binding content to its path
| RS | Fork |
|---|---|
| None: name and content are encrypted separately **[know]** | Path id is the GCM associated data: a file only decrypts at its own path **[mine]** |
| A person with write access to Drive could swap or rename two encrypted files unnoticed **[?, follows from the format]** | Swapped/moved files fail the check **[mine, sim]** |
**Verdict:** Fork stronger.

### A8. File and folder names
| RS rclone | RS OpenSSL | Fork |
|---|---|---|
| Encrypted per path segment (EME); **same name → same ciphertext; folder tree visible** **[doc]** | Whole path encrypted, base64url, visible `Salted__` prefix; flat; folders are 0-byte objects that can be guessed on S3 **[doc]** | 22-character random-looking id per file **and per folder**, real path encrypted in properties; **Drive folders still mirror the vault tree (E2EE-DESIGN decision D4), only their names are opaque**; one generic file type **[mine]** |
**Verdict (corrected in 3.6.3):** names are hidden in all three. Fork ≈ RS rclone on structure: Google sees the folder depth and how many items each folder holds. Only RS OpenSSL is flat. Fork is ahead on name randomness (not deterministic) and on one generic file type, but NOT on hiding the tree. File count, sizes and times are visible in every design.

> Correction: earlier versions of this document said the Fork hides the folder tree / is flat. That was wrong.

### A9. Changing the password
| RS | Fork |
|---|---|
| New key means new ciphertext everywhere; must re-upload the vault **[know]** | Re-wrap the data key; no file is re-uploaded; other devices keep working **[mine]** |
**Verdict:** Fork much better.

### A10. Where the secret lives on the device
| RS | Fork |
|---|---|
| Password stored in the plugin's settings file; they tell you to protect `data.json` **[doc]** | Passphrase never stored; data key is a non-extractable key in the app's IndexedDB **[mine]** |
**Verdict:** Fork better. (Neither protects against malware running as you.)

### A11. Wrong or missing key
| RS | Fork |
|---|---|
| Checks the password by trying to decrypt the remote listing **[code]** | Device with no key syncs nothing; Pull/Push refuse with a message **[mine, sim]** |
**Verdict:** equal intent.

### A12. Reading data without the plugin
| RS | Fork |
|---|---|
| **Yes**: `rclone mount` (base64 names setting) or the `openssl` command **[doc]** | **No**: custom format; only documented in `investigation/E2EE-DESIGN.md` **[mine]** |
**Verdict:** RS clearly better. If this plugin disappears, your encrypted vault needs our code. Candidate fix: a standalone decrypt script.

### A13. Big files
| RS | Fork |
|---|---|
| rclone format chunked in workers; "skip large files" setting; their README warns about 50 MB+ on mobile **[doc/code]** | Whole file read into memory, encrypted whole, sent in one request **[mine]** |
**Verdict:** RS better. Phones with big attachments are a risk for us.

### A14. What Google still learns
Same in all designs: **number of files, sizes, modified times**. RS rclone and the Fork both show the folder tree shape (depth, items per folder) with opaque names; RS OpenSSL is flat. Fork file sizes are +33 bytes.

### A15. Attacks nobody stops
Deleting a file, or putting an older (valid) version back on Drive, is **not detected by any of the three** (needs a signed list; not built here).

---

## B. The sync engine around it

### B1. When it runs
| RS | Fork |
|---|---|
| Manual button, **scheduled auto sync**, on-start delay, **sync on save** **[code: settings]** | **Manual only** (your rule): Pull and Push separate, no startup pull, no auto-push by default **[mine]** |
**Verdict:** Different goals. Yours is deliberate.

### B2. Direction
| RS | Fork |
|---|---|
| Bidirectional, or incremental push-only / pull-only (with or without deletes) **[code]** | Pull = only action that changes local files; Push never pulls; optional "Push without pulling" **[mine]** |
**Verdict:** similar ideas; ours enforces the split with a guard.

### B3. Finding changes on Drive
| RS | Fork |
|---|---|
| Lists the whole Drive tree each sync (folder by folder) **[code]** | Drive **changes feed** plus file properties; only changed items **[mine]** |
**Verdict:** Fork cheaper per sync on large vaults; RS simpler to reason about.

### B4. Remembering the last synced state
| RS | Fork |
|---|---|
| Per-file previous-sync record (mtime, encrypted size); three-way compare local / previous / remote **[code]** | Pending list from Obsidian events; since 3.6.2 per-note `{mtime,size}` baseline and own-upload times **[mine]** |
**Verdict:** RS's model is more complete (it needs no events). Fork added the baseline but still depends on events for new edits.

### B5. Modified time on Drive
| RS | Fork |
|---|---|
| Uploads with the file's own mtime (and creation time) **[code]** | Uploads with *push time*; a pulled file gets Drive's time as its local mtime **[mine]** |
**Verdict:** RS keeps times truthful across devices; ours changes your files' mtime on Pull.

### B6. The very first sync, same path on both sides, different content
| RS | Fork |
|---|---|
| No previous record + both exist and differ: **keep newer** (or larger), the other side is overwritten; paid "smart conflict" can merge small Markdown **[code]** | Pull with no pending edit on that device: **Drive wins and overwrites local**. With a pending edit: local kept, Drive's copy saved beside it. Push before Pull: stops **[mine, code read today]** |
**Verdict:** Both can lose a file. Ours loses it only if the local edit was never recorded; RS loses the older one. See gap G1.

### B7. Conflicts later (same note edited on both)
| RS | Fork |
|---|---|
| Free: keep newer or keep larger; the loser is replaced. Paid: merge or duplicate **[doc/code]** | Never overwrite an unpushed edit; save the Drive version as `Note (Drive date).md`; Push stops until you Pull **[mine]** |
**Verdict:** Fork safer; RS can merge (paid).

### B8. Edited on one side, deleted on the other
| RS | Fork |
|---|---|
| Local edited + remote deleted: **push local** (keep the file) **[code]** | Same for Pull; deleted-here + edited-on-Drive stops the Push **[mine]** |
**Verdict:** equal.

### B9. Deletions
| RS | Fork |
|---|---|
| Computed from the previous-sync record ("true deletion"); on Drive: **trash** (PATCH trashed) **[code]**; choose where local deletions go **[code]** | From events and the saved id map; to Drive Trash by default (setting) **[mine]** |
**Verdict:** equal on Drive; RS's deletion logic does not depend on events.

### B10. Protection against a mass change
| RS | Fork |
|---|---|
| Aborts if modified+deleted files reach a percentage of all files (default **50 %**, adjustable) **[code]** | A confirmation window before Push with a mass-delete warning; the guard stops on overlap **[mine]** |
**Verdict:** RS automatic; ours manual confirmation.

### B11. Filters
| RS | Fork |
|---|---|
| Skip files over a size; ignore paths and "only these paths" (regex); sync the config folder on/off; bookmarks option **[code]** | None of these; settings folder files are always included (no toggle); no skip-large option **[mine]** |
**Verdict:** RS better. Candidate fix.

### B12. Uploads
| RS | Fork |
|---|---|
| Multipart up to 5 MB, **resumable** above **[code]** | Multipart for every size; no resume **[mine]** |
**Verdict:** RS better for large files. Google's guidance is multipart for small files.

### B13. Duplicate names on Drive
| RS | Fork |
|---|---|
| Admits same-name files may break it; a "clear duplicate files" tool exists in pro **[doc/code]** | Detected by Sync doctor; Push guard and first-sync rules prevent most **[mine]** |
**Verdict:** both exposed; ours reports it.

### B14. History and recovery
| RS | Fork |
|---|---|
| Relies on Drive revisions; not part of the plugin **[?]** | Restore point after every Push (retention days), restore window, encrypted too **[mine]** |
**Verdict:** Fork better.

### B15. Diagnosing problems
| RS | Fork |
|---|---|
| Logs / debug mode **[code]** | Sync doctor (read-only), compare-note command, Push result that checks Drive, diagnostics export **[mine]** |
**Verdict:** Fork better for "did it really reach Drive?".

### B16. Sign-in and cost
| RS | Fork |
|---|---|
| Google Drive needs a PRO subscription and an RS online account; sign-in via RS website **[doc]** | Free; sign-in via the original plugin's website/server, which sees the refresh token (custom credentials possible) **[mine]** |
**Verdict:** your choice of trust; both use scope `drive.file`.

### B17. What each can see on Drive
Both use `drive.file`: only files created by the plugin. So neither can adopt a vault folder you uploaded by hand **[doc]**.

### B18. Mobile
| RS | Fork |
|---|---|
| Supported; large files >= 50 MB are a known problem; concurrency setting **[doc/code]** | Supported (manual); whole-file encryption in memory **[mine]** |

### B19. Maturity
| RS | Fork |
|---|---|
| 8.2k stars, 128 tags, 881 commits; master quiet since Nov 2024 as shown **[page]**; source-available licence for pro | Small fork; 3.6.2 released today; tested in a simulator only **[mine]** |

---

## C. Scoreboard (who is ahead per topic)

| Area | Ahead |
|---|---|
| Password hardening, change of password, key storage | **Fork** |
| Tamper and path-swap detection | **Fork** |
| Hidden folder tree | **No winner**: RS OpenSSL is flat; Fork and RS rclone show the tree shape |
| Never overwriting unpushed edits, manual safety, restore points, diagnostics | **Fork** |
| Cost (Drive sync) | **Fork** |
| Recovery without the plugin | **RS** |
| Large files (chunking, resumable upload, skip size) | **RS** |
| Filters (ignore paths, only paths, config toggle) | **RS** |
| Auto sync and merge of notes | **RS** (not wanted for auto sync) |
| State model independent of events, mtime fidelity | **RS** |
| Automatic mass-change abort | **RS** |
| Number of supported clouds | **RS** |

## D. Gaps this comparison exposes in the fork (not done)

- **G1 Pull trusts the pending list.** A local edit whose event was missed can be overwritten by Pull. The 3.6.2 baseline could protect it: if a note differs from its baseline, keep it and save Drive's version as a copy. Also fixes B6 for most cases.
- **G2 No standalone decryption** (A12).
- **G3 Large files** (A13, B12): size warning/limit, resumable upload, or chunked format.
- **G4 Filters** (B11): skip large files, ignore paths, config toggle.
- **G5 Truthful mtimes** (B5): upload the file's own mtime.
- **G6 Config files** are chosen by mtime > last sync, so they re-upload after a Push-without-pull until a Pull.
- **G7 Automatic mass-change abort** (B10).

## E. Confidence
High on RS docs and the code I read (encryption wrapper, PBKDF2 20k, no MAC, fixed-salt call, keep-newer/larger, protect percentage, resumable above 5 MB, trash on delete). Medium on security consequences and rclone internals. Not verified on any real Drive or phone.
