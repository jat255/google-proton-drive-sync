# google-proton-drive-sync

Bidirectional sync between a Google Drive folder and a Proton Drive folder.

> **Warning:** This tool is vibe coded for personal use. It has not been audited, thoroughly tested, or hardened for production. Use at your own risk -- always keep independent backups of important files.

## Prerequisites

- Node.js 20+
- [`proton-drive-cli`](../proton-drive-cli) installed and logged in (`proton-drive login`)
- A Google Cloud project with the Drive API enabled

## Setup

### 1. Google Cloud credentials

1. Go to [Google Cloud Console](https://console.cloud.google.com) and create or select a project.
2. Enable the **Google Drive API** (APIs & Services → Enable APIs → search "Drive API").
3. Go to **APIs & Services → OAuth consent screen**:
   - Choose **External**, fill in the app name (e.g. "Proton Drive Sync").
   - Under **Test users**, add the Gmail address you'll be syncing from.
     - If you skip this step, the auth flow will return `Error 403: access_denied`.
4. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**:
   - Application type: **Desktop app**.
   - Add `http://localhost:3000` as an authorized redirect URI.
   - Download the JSON and save it to `~/.config/gdrive-proton-sync/credentials.json`.

### 2. Config file

Copy the example config and fill in your values:

```bash
cp config.example.json config.json
```

| Field | Description |
|-------|-------------|
| `gdriveFolderId` | The folder ID from the GDrive URL: `.../folders/<ID>` |
| `protonFolderPath` | Proton Drive path to sync into, e.g. `Sync/GoogleDrive` |
| `googleCredentialsPath` | Path to the OAuth credentials JSON (default shown) |
| `googleTokenPath` | Where the auth token will be saved after `auth` (default shown) |
| `statePath` | Where sync state is persisted between runs (default shown) |

### 3. Install the global CLI

```bash
npm install
npm link
```

This installs `gdrive-proton-sync` as a global command.

### 4. Authenticate with Google

```bash
gdrive-proton-sync auth
```

This opens a browser for OAuth consent. After approving, the token is saved automatically and you won't need to repeat this unless the token is revoked.

To authenticate with a different Proton account than the one already logged in via `proton-drive login`:

```bash
gdrive-proton-sync auth-proton
```

### 5. Run a sync

```bash
gdrive-proton-sync sync                   # sync both sides
gdrive-proton-sync sync --dry-run         # preview changes without applying
gdrive-proton-sync sync --delete          # also propagate deletions across sides
gdrive-proton-sync sync --dry-run --delete  # preview with deletion propagation
gdrive-proton-sync download               # download local copies of both drives
gdrive-proton-sync download -o ~/Backups  # download to a custom directory
```

## Sync behavior

- **New file on either side** → copied to the other side.
- **File changed on one side** (detected by size difference vs. last sync) → copied to the other side.
- **Conflict** (both sides changed since last sync) → Proton Drive wins. The GDrive file is renamed to `name.conflict-backup-<timestamp>.ext` before being overwritten.
- **Deletion** → only propagated when `--delete` is passed. Without it, deleted files are left on the surviving side.
- **Google Workspace files** (Docs, Sheets, Slides, etc.) are synced as `.url` shortcut files that open the document in the browser when clicked.

Sync state is stored in `~/.config/gdrive-proton-sync/state.json`. Deleting this file will cause the next run to treat all files as new (GDrive wins on any size conflict).
