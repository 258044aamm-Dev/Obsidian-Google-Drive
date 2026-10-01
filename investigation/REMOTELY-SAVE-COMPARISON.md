# Remotely Save vs this fork: encryption on Google Drive (deep analysis)

Date: 2026-10-01. Compared: Remotely Save (`remotely-save/remotely-save`, master, last commit Nov 10 2024) and this fork (3.6.2).

## 0. Method and limits

What I did:
- Read the Remotely Save README, `docs/encryption/*`, `docs/sync_algorithm/v3/intro.md`, `docs/services_connectable_or_not.md`, `pro/README.md` and `docs/remote_services/googledrive/README.md`.
- Cloned the repository and read `src/fsEncrypt.ts`, `src/encryptOpenSSL.ts`, the top of `src/encryptRClone.ts`, and the Google Drive part (`pro/src/fsGoogleDrive.ts`) and the decision logic of `pro/src/sync.ts` (parts, not all 2,000 lines).

What I did NOT do:
- I did not install or run Remotely Save. Nothing below was observed on a real Drive.
- The rclone Crypt internals (scrypt parameters, fixed default salt, 64 KiB chunks, EME names) are from rclone's own documented design and my knowledge of it, not from Remotely Save's pages. Remotely Save's code shows it calls `cipher.key(password, "")`, i.e. with no second salt, which in rclone means the built-in fixed salt.
- The `pro/` folder is under the PolyForm Strict licence ("source available"). I read it to compare behaviour; I copied nothing, and this fork contains none of its code.
- Statements about this fork are from my own code and the simulator, which is not real Obsidian or real Drive.

## 1. Short answer

Yes: Remotely Save encrypts notes before sending them to Google Drive when you set a password. Google Drive sync in it is a paid ("PRO") feature, in beta as of its own docs (June 2024). It is a different design from ours and is stronger in some areas and weaker in others (sections 4 and 5).

## 2. How Remotely Save encrypts

- Encryption is a wrapper (`FakeFsEncrypt`) around whatever remote is selected (S3, Dropbox, WebDAV, Google Drive...). The Drive code itself is unaware of it. Empty password = no encryption.
- Two formats, chosen in settings:

| | rclone Crypt (base64 names) | OpenSSL enc |
|---|---|---|
| Content | XSalsa20-Poly1305 in 64 KiB chunks (authenticated) | AES-256-CBC, **no MAC** |
| Key from password | scrypt, no second salt given, so rclone's **fixed built-in salt** | PBKDF2-SHA-256, **20,000** rounds, random 8-byte salt per file and per name |
| File names | EME encryption of each path segment; **folder tree stays visible**, names are deterministic | Whole path encrypted, base64url, prefix `Salted__` visible (`U2FsdGVkX…`); flat |
| Check that the password is right | Reads the remote listing and tries to decrypt | Same |
| Extras | Can be opened with `rclone mount` (the doc explains how) | Reproducible with the `openssl` command |

- Switching format requires deleting the cloud vault by hand and re-uploading (their own warning).
- The vault name (the base folder) is not encrypted (their Dropbox note says so; the Drive doc says a vault folder is created at the Drive root).
- Google Drive specifics (their doc): scope `drive.file` (sees only files the plugin created); sign-in goes through the Remotely Save website, which says it does not store the credential; you need a Remotely Save PRO account and subscription; two files with the same name can coexist on Drive and "may or may not make the plugin stop working".

## 3. How this fork encrypts (3.6.x)

- Passphrase -> PBKDF2-SHA-256, 600,000 rounds, random 16-byte salt -> key that wraps a **random 256-bit data key**. Subkeys by HKDF. The data key sits on the device as a non-extractable key in IndexedDB.
- Content: `OGDE | version | nonce(12) | ciphertext | tag(16)`, AES-256-GCM, fresh nonce per upload, **associated data = the file's path id** (the file only decrypts at its own path).
- Names: Drive name = a random-looking 22-character path id; the real path is encrypted into hidden properties. Drive folders still mirror the vault tree, with opaque 22-character names (the tree shape is visible to Google). Type is always `application/octet-stream`.
- Changing the passphrase only re-wraps the data key (nothing is re-uploaded). A failed integrity check means the file is never written locally; Pull reports it and carries on with the others.

## 4. Deep comparison of the encryption

| Topic | Remotely Save (rclone) | Remotely Save (OpenSSL) | This fork | Notes |
|---|---|---|---|---|
| Content confidentiality | Strong | Strong | Strong | All use sound ciphers |
| Tamper detection of content | Yes (Poly1305 per chunk) | **No** (CBC without MAC) | Yes (GCM tag) | CBC allows undetected changes |
| Tie content to its path | No (content and name are independent) | No | **Yes** (AAD) | Without a binding, someone with write access to Drive could swap two encrypted files or move one under another name; the plugin cannot tell. Not shown by me for Remotely Save, but follows from the formats |
| Password hardening | scrypt + fixed salt: the same password gives the same key everywhere, so precomputed tables help an attacker | PBKDF2 20k + random salt: cheap to guess | PBKDF2 600k + random salt, then a random data key | A weak password is the weakest part of every option. 600k rounds vs 20k = about 30x more work per guess |
| Change password | Re-encrypt the whole vault (new key = new ciphertext everywhere) | Same | Re-wrap only | Ours is a real practical win |
| Names | Hidden but **deterministic**, tree visible | Hidden, flat, `Salted__` prefix identifies it as encrypted | Hidden, random-looking, tree shape visible (opaque folder names) | The Fork and rclone both leak depth and item counts per folder; only OpenSSL is flat |
| What Google still sees | Number and sizes of files, tree shape, times | Number, sizes, times | Number, sizes (+33 bytes), times, tree shape (opaque names) | Same for everyone: size and time cannot be hidden by these designs |
| Rollback / delete by an attacker | Not detected | Not detected | Not detected | None of the three can; would need a signed manifest |
| Opening files outside the plugin | **Yes** (rclone mount / openssl) | **Yes** | **No** (custom format) | A real point for Remotely Save: your data can be recovered without the plugin. Ours needs the plugin's code (the format is documented in `investigation/E2EE-DESIGN.md`) |
| Large files | Chunked, streamed in workers | Whole file in memory | **Whole file in memory** | Our weakness on phones with big attachments; they warn about 50 MB+ too |
| Failure behaviour | Unknown to me | Unknown to me | Refuse, report, continue, retry | Mine is tested in the simulator only |
| Key safety on device | Password kept in plugin settings (their README says protect `data.json`) | Same | Passphrase never stored; key non-extractable | Ours is better: a stolen `data.json` is not enough |

## 5. The sync design around the encryption (it matters on Drive)

| Topic | Remotely Save | This fork |
|---|---|---|
| Direction | One "sync" does both ways | Manual Pull and Push, separate |
| Auto sync | Scheduled and on-demand | Off by default (your requirement) |
| Change detection on Drive | Lists the whole tree each sync (folder by folder) | Uses Drive's change feed and properties; far fewer calls on 362 files |
| Per-file state | Remembers the last synced state of every file; compares times and (encrypted) size | Since 3.6.2: remembers time and size per note and own uploads; no state before |
| Conflict, free version | **Keep newer or keep larger**: one side's edit is replaced | **Keep both**: the Drive version is saved next to your note as a copy |
| Conflict, paid version | "Smart conflict": merge small Markdown, duplicate large files | Not available (no merge) |
| Safety on mass deletion | Warning based on a threshold | A confirmation window before Push with a mass-delete warning |
| Drive duplicates (two files with one name) | Possible, user must clean up on the website | Detected by the doctor; first Push guard prevents most |
| Version history | Not part of it (Drive's own revisions only) | Restore points after every Push (encrypted too) |
| Cost | Paid feature for Google Drive | Free |
| Google sign-in | Via the Remotely Save website | Via the original plugin's website and server (the refresh token passes through it) |
| Free of the paid cap? | No | Yes |

Remarks:
- "Keep newer" is the largest behavioural difference. If both devices edited a note, Remotely Save's free mode silently keeps one version. This fork never overwrites an unpushed edit and stops a Push that would.
- Their per-file state design is the same idea as the 3.6.2 baseline.
- Their full listing is simple and robust, but it grows linearly with the vault.

## 6. Who can do what (threat model)

| Attacker | Remotely Save rclone | Remotely Save OpenSSL | This fork |
|---|---|---|---|
| Reads your Drive (Google staff, a stolen Google login) | Sees tree, sizes, times; not content or names | Sees count, sizes, times | Sees count, sizes, times and the tree shape (opaque names) |
| Guesses a weak password offline | Easier (fixed salt) | Easiest (20k rounds) | Hardest of the three (600k rounds) |
| Edits an encrypted file on Drive | Detected | **Not detected** | Detected |
| Swaps or moves encrypted files on Drive | Not detected | Not detected | Detected (path bound) |
| Deletes or restores an older version on Drive | Not detected | Not detected | Not detected |
| Steals your device's settings file | Gets the password | Gets the password | Does not get the passphrase or the key in a usable form |
| Compromises the sign-in website/server | Gets a Drive token (their site says it does not keep it) | same | Gets a Drive token (the original server sees the refresh token). Encrypted content stays unreadable |

## 7. Where each is better

Remotely Save is better:
- Works on many clouds, with auto sync, merge of small notes (paid), skipping large files and chosen paths.
- Encrypted data can be read with standard tools (rclone / openssl): recovery without the plugin.
- Large files are streamed (rclone format).
- Mature (8.2k stars, 128 tags) though its master has had no commit since Nov 2024 per the page I read.

This fork is better:
- Stronger password handling and a real passphrase change.
- Content bound to its path; random (non-deterministic) names; tamper detection in the only mode that exists.
- Never overwrites an unpushed edit; manual control; restore points; sync doctor and compare tool.
- No payment; Drive change feed instead of a full listing.

## 8. Gaps in this fork that this analysis exposes (candidates, not done)

1. **Large attachments on phones**: encryption buffers the whole file. Add a size limit warning, or chunked format (a format change; needs a version bump in the file header, which already exists).
2. **No way to read a vault without the plugin**: write a tiny stand-alone decrypt script or document the format in the README so a user can recover data if the plugin disappears.
3. **Skip large files / skip paths** settings (Remotely Save has them).
4. **Rollback detection**: a signed manifest would need a design of its own; not planned.
5. **Sign-in trust**: using your own Google Cloud client (the plugin already has a "custom credentials" path) removes the third-party server from the token flow.
6. Dropped from the list: scheduled auto sync (you want manual only).

## 9. Confidence

- High: what Remotely Save's docs and code say about formats, iterations, fixed-salt call, OpenSSL having no MAC, the Drive scope and PRO status, and the keep-newer/larger policy.
- Medium: the security consequences I drew from those facts (path swapping, offline guessing), and rclone internals from my own knowledge.
- Low/untested: any claim about how either plugin behaves on your real Drive and phone.
