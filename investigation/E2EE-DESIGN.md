# End-to-end encryption: design (for approval, nothing is implemented yet)

*Status: proposal. No source file has been changed. Written against fork 3.5.2 and the code as it is today.*

**Your decisions so far:** encrypt file contents **and** file/folder names · start a **new** encrypted Drive vault next to the current one (no in-place conversion) · the passphrase stays on each device after you type it once · design first, then you approve.

---

## 1. What "end-to-end" means here, and what it does not

**Goal:** Google (and anyone who gets into your Google account or the Drive files) sees only random-looking bytes and random names. Only a device that knows your passphrase can read the vault.

**Protects against**
- Google, or someone with access to your Google account, reading your notes, attachments, settings or plugin files.
- Someone reading the Drive web page, the Drive search index, file previews, or old file versions and the Trash.

**Does NOT protect against** (be clear about these)
- A weak passphrase. The key material needed to brute-force it (salt, wrapped key) is stored on Drive. Use 5 or more random words, or a password-manager string.
- Someone who controls an unlocked device, or who can read the app data of a device.
- Metadata Google still sees: **how many** files and folders there are, the **shape of the folder tree** (how many items in each folder), **roughly how big** each file is (content size + 28 bytes), and **when** files change (Drive's own timestamps; the sync logic needs them).
- A malicious server that **deletes** a file or **serves an older version** of it. Tampering with content is detected (see 4.3); removal and rollback are not.
- Forgetting the passphrase: the encrypted Drive vault cannot be recovered without it (your devices still hold plain copies, so you could start a new encrypted vault from one of them).

Google's own client-side encryption is for Workspace accounts only, so it is not an option for a personal account.

---

## 2. Findings: where Drive is touched today

| Area | How it works now | Consequence for encryption |
|---|---|---|
| **Path / identity** | Every Drive file carries its **plain path** in custom properties `path`, `path2`, ... (`splitPath` / `unSplitPath`, 100-byte pieces) and is found with `properties has {key='path' and value=...}` | Needs a searchable but unreadable path id, plus a readable-only-with-key copy of the path |
| **Names** | Drive `name` = plain file or folder name; Drive folders mirror the vault tree (`parents`) | Names become opaque; keep the tree (see decision D4) |
| **Vault id** | Every file and query carries `vault = <plain vault name>`; the root folder is found by `obsidian = vault` | Use a different `vault` value for the encrypted vault, so the original plugin never sees it (and cannot write into it) |
| **Content** | `uploadFile` / `updateFile` send the raw `Blob`; `getFile(id).arrayBuffer()` is called in about 10 places (Pull, Push undo and merge, Reset, missed-edit check, conflict copy) | One place to encrypt and one to decrypt, inside `getDriveClient` |
| **Listings and changes** | `searchFiles`, `paginateFiles`, `getChanges` return `properties` that the rest of the code feeds to `unSplitPath` (about 20 call sites) | Decode at the boundary so that Pull, Push, Doctor and Reset **see plain paths as today** and stay unchanged |
| **Version history (3.4.0)** | `history.ts` talks to Drive **directly** (not through `getDriveClient`): a history folder named after the vault, `history = <vault name>` property, and a restore-point file that lists every path with md5, size and revision id; old file versions are fetched with `revisions/{id}?alt=media` | Needs its own small change: opaque folder name and tag, restore-point file encrypted, revisions decrypted |
| **Comparisons** | `sameBytes(local, driveContent)` in Pull (keep-both conflicts), conflict copies and the missed-edit check | Fine if Drive content is decrypted first; ciphertext cannot be compared (random nonce) |
| **Own plugin folder** | `isOwnPluginPath` keeps `.obsidian/plugins/google-drive-sync/` out of every sync | The encryption key and settings never get uploaded |

The big point: **only three places talk to Drive** (`drive.ts`, `history.ts` and a few `requestUrl` calls in `requests.ts`). That is what makes a clean layer possible.

---

## 3. Options compared

| # | Option | Pros | Cons | Verdict |
|---|---|---|---|---|
| A | **Encryption layer inside the Drive client** (encode and decode at the boundary; Pull, Push, Doctor, Reset unchanged) | Smallest blast radius; the whole existing simulator suite can be re-run with encryption on; no new dependencies (WebCrypto only) | Touches `drive.ts` and `history.ts` carefully | **Recommended** |
| B | Encrypt only contents, keep names and paths plain | Simplest | Google still reads names and structure. You chose names too | Rejected by you |
| C | Flatten Drive (every item directly in the root) to hide the tree shape | Hides the structure | A Drive folder's descendants are no longer trashed or removed with it, which Pull and the folder-deletion logic rely on. Far riskier | Rejected for now (D4) |
| D | Pack the whole vault into one encrypted archive | Hides everything | No incremental sync, no per-file history, conflicts become whole-vault | Rejected |
| E | Use an external tool (rclone crypt, Cryptomator) | Mature | Not usable from inside Obsidian on the phone; a different product | Rejected |

---

## 4. Proposed design (option A)

### 4.1 Cryptography (WebCrypto only, available on desktop and on iOS/Android Obsidian)

- **Key hierarchy**
  1. **Passphrase** → **KEK** with **PBKDF2-HMAC-SHA-256**, 600,000 iterations, random 16-byte salt (OWASP 2023 figure; about 0.3 to 1 second on a phone, done once per device).
  2. A random 256-bit **DEK** (data key), created when the encrypted vault is created. It is stored **wrapped** (AES-GCM) by the KEK. *Changing the passphrase re-wraps the DEK only; no file has to be re-uploaded.*
  3. From the DEK, **HKDF-SHA-256** derives separate subkeys: content key, path-encryption key, path-id key. No key is used for two purposes.
- **File content:** `AES-256-GCM`, fresh random 96-bit nonce per upload. Stored as `"OGDE" | version(1) | nonce(12) | ciphertext | tag(16)`. The AAD (authenticated extra data) is the file's path id, so a server cannot move one file's ciphertext to another path without detection. Whole-file encryption (the plugin already loads whole files into memory).
- **Path id** (searchable): `base64url(HMAC-SHA-256(path-id key, path))` cut to 22 characters (128 bits). Deterministic, so the existing "find the file at this path" queries keep working; unreadable without the key.
- **Real path** (for Pull): the path encrypted with AES-GCM, base64url, cut into the same kind of pieces as today (`e1`, `e2`, ...), each piece under Drive's 124-byte property limit.
- **Names:** the Drive `name` of every file and folder is its path id (opaque, stable, sortable for paging). `mimeType` of files is always `application/octet-stream`. `description` is left empty.
- **Key check:** the vault header stores a small constant encrypted with the derived keys. A device checks it **before any read or write**; a wrong passphrase stops with a clear message and touches nothing.

### 4.2 Where the key lives on a device (D1)

You chose "type it once per device and keep it there". I propose the refinement of storing the derived keys as **non-extractable `CryptoKey` objects in the device's IndexedDB**, not in `data.json`:
- `data.json` sits **inside the vault folder**, so a copied vault (or a vault kept in another cloud) would carry the key with it. IndexedDB is per device and outside the vault.
- The raw key bytes cannot be read back out, even by script on the same device.
- Cost: if Obsidian's app data is cleared, you type the passphrase again (you would on a new device anyway).

### 4.3 Integrity and failure behaviour

- Any file that fails the GCM check (corrupted, tampered, wrong path, wrong key) is **never written** to the vault. Pull reports the file, keeps going with the rest, and does not move the sync position past it.
- Nothing is uploaded unless the key check succeeded in this session.
- Existing safety nets (mass-delete warning, Trash, keep-both conflicts, restore points, Push never pulls) stay exactly as they are, because they run on plain paths above the layer.

### 4.4 Vault header, new devices and compatibility

- The encrypted vault has its **own root folder**, tagged `vault = <SHA-256 of the vault name>` (no plain name) and `e2ee = 1`, holding: salt, iteration count, wrapped DEK, key-check blob, format version. The **original plugin looks for `vault = <plain name>`, so it can never see, read or overwrite the encrypted vault**, and cannot be confused by it.
- Your current plain Drive vault is **not touched**. When you are happy, delete it yourself in Drive (and empty the Trash: old versions of plain files stay there for about 30 days).
- Switching a device to encryption is a **new link**, not a conversion: it resets that device's saved Drive ids, sync position and pending list, marks the local files for upload, and keeps the vault files as they are. A device that is not switched keeps using the plain Drive vault. The README will say: **switch the phone first (Pull from the encrypted vault), then the desktop pushes.**
- The README's "download the vault folder from Drive" fallback for a new device **does not work** for an encrypted vault. The only way in is the plugin plus the passphrase.

### 4.5 Version history

- History folder and restore-point tag use the opaque vault id; the folder name is generic.
- The restore-point file (it lists every path) is encrypted with the same scheme.
- Restoring fetches the old revision (ciphertext), decrypts it, and checks the AAD. Old revisions are as unreadable to Google as current files.

### 4.6 What the user sees

- Settings: **Encryption** section: *Use end-to-end encryption for this vault* (off by default), passphrase fields, strength hint, **Change passphrase**, status line. A warning before first enabling: *If you lose the passphrase the encrypted Drive vault cannot be recovered.*
- **Sync doctor** gains lines: encryption on/off, key check result, number of Drive files that fail to decrypt.
- **Status bar** and **menu** are unchanged.
- Drive's own web preview and search no longer work on encrypted files (by design).

### 4.7 Code plan (small, contained steps)

1. `helpers/crypto.ts`: pure functions (KDF, wrap, HKDF, encrypt/decrypt, path id, path codec). No Obsidian imports. Unit tests with known-answer vectors.
2. `helpers/e2ee-store.ts`: IndexedDB key store; header read/write; unlock.
3. `helpers/drive.ts`: when encryption is on, `getDriveClient` encodes outgoing content, properties, names and queries, and decodes incoming listings, changes and downloads. **When encryption is off the code path is byte for byte what it is today.**
4. `helpers/history.ts`: the small changes from 4.5.
5. Settings UI and doctor lines; the "new link" reset; README and CHANGELOG.
6. Release as **3.6.0** (new opt-in feature; format of the plain vault unchanged).

### 4.8 How it will be proved (before you run it on real data)

1. **The existing simulator suite runs a second time with encryption on**, as it already does for Trash and for version history: every Pull, Push, conflict, folder-deletion, history and doctor scenario must give the **same results**. That is about 380 checks.
2. **"Nothing readable on Drive" test:** after a full two-device session, dump everything the fake Drive holds (names, properties, descriptions, file bytes, every revision, the restore-point file, the trash) and assert that **no note text, no file or folder name, no path fragment and no vault name appears anywhere**.
3. Wrong passphrase: no request after the key check writes anything.
4. Tampering: flip a byte, swap two files' contents, replay an old version under another path; each is refused and nothing reaches the vault.
5. Two devices with one passphrase converge; a device with another passphrase is refused.
6. Long and Unicode paths (property size limit), rename, folder delete, empty folders, large file, config and plugin files.
7. Known-answer test vectors for the crypto, and a check that the same plaintext encrypts to different bytes each time.
8. Mutation checks on the new code, as before.

**Cannot be proved here:** behaviour against real Google Drive and real Obsidian (phone WebView speed, IndexedDB on iOS). You would test on a vault copy with its own encrypted Drive vault first; the plain vault stays untouched meanwhile.

---

## 5. Decisions needing your approval

| # | Decision | Recommended | Alternative |
|---|---|---|---|
| D1 | Where the key stays on a device | Non-extractable key in IndexedDB | `data.json` (simpler, but travels with a copied vault) |
| D2 | Passphrase handling | Passphrase wraps a random data key, so it can be changed later without re-uploading | Key derived straight from the passphrase (simpler, cannot change it) |
| D3 | Key derivation | PBKDF2-SHA-256, 600,000 iterations (native, fast on phones) | Argon2id (stronger against GPUs, needs a WASM library and more memory on phones) |
| D4 | Hide the folder tree shape | No: keep the Drive folder tree with opaque names | Flatten (hides the tree, but breaks folder delete and trash semantics) |
| D5 | Bind each ciphertext to its path | Yes (catches swapped files) | No (a rename could reuse the blob, but the plugin re-uploads on rename anyway) |
| D6 | Weak passphrase | Require at least 12 characters and show a strength hint | No minimum |
| D7 | Optional **recovery key** (random, shown once, can also unlock) | Not in the first release | Include it now |
| D8 | Version number | 3.6.0, opt-in, off by default | 4.0.0 |
