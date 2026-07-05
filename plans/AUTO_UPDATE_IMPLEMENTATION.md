# Auto-Update Implementation Plan

This document outlines the steps needed to implement auto-updates for OpenWhisperer using Tauri v2's updater plugin.

## Overview

Tauri's updater plugin uses Ed25519 cryptographic signatures to verify update authenticity. Updates are distributed via a `latest.json` manifest file that points to signed installers.

---

## Phase 1: Install Dependencies

### Backend (Rust)

Add to `src-tauri/Cargo.toml`:

```toml
[target."cfg(not(any(target_os = \"android\", target_os = \"ios\")))".dependencies]
tauri-plugin-updater = "2"
```

### Frontend (JavaScript)

```bash
npm install @tauri-apps/plugin-updater @tauri-apps/plugin-process
```

Note: `@tauri-apps/plugin-dialog` is already installed.

---

## Phase 2: Generate Signing Keys

Generate an Ed25519 keypair for update verification:

```bash
npm run tauri signer generate -- -w ~/.tauri/open-whisperer.key
```

This creates:
- `~/.tauri/open-whisperer.key` - **Private key** (keep secure, never commit)
- `~/.tauri/open-whisperer.key.pub` - **Public key** (embed in config)

### Security Requirements

- Add `*.key` to `.gitignore`
- Store private key in a password manager or GitHub Secrets
- Optionally protect with password via `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

---

## Phase 3: Configuration

### Update `src-tauri/tauri.conf.json`

Add to the `bundle` section:

```json
{
  "bundle": {
    "createUpdaterArtifacts": true
  }
}
```

Add to the `plugins` section:

```json
{
  "plugins": {
    "updater": {
      "pubkey": "PASTE_PUBLIC_KEY_CONTENT_HERE",
      "endpoints": [
        "https://github.com/USERNAME/open-whisperer/releases/latest/download/latest.json"
      ],
      "windows": {
        "installMode": "passive"
      }
    }
  }
}
```

### Configuration Options

| Option | Description |
|--------|-------------|
| `pubkey` | Raw content from `.key.pub` file (not a file path) |
| `endpoints` | Array of URLs to check for updates |
| `installMode` | `"passive"` (progress bar), `"basicUi"` (basic UI), `"quiet"` (silent) |

### Dynamic Variables in Endpoints

- `{{target}}` - OS target (e.g., `windows-x86_64`)
- `{{arch}}` - Architecture (e.g., `x86_64`)
- `{{current_version}}` - Current app version

---

## Phase 4: Backend Integration

### Update `src-tauri/src/lib.rs`

Register the updater plugin:

```rust
// Add to the tauri::Builder chain
.plugin(tauri_plugin_updater::Builder::new().build())
```

### Optional: Auto-check on Startup

```rust
use tauri_plugin_updater::UpdaterExt;

// In the .setup() closure
.setup(|app| {
    let handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        match handle.updater().check().await {
            Ok(Some(update)) => {
                println!("Update available: {}", update.version);
            }
            Ok(None) => {
                println!("No update available");
            }
            Err(e) => {
                eprintln!("Update check failed: {}", e);
            }
        }
    });
    Ok(())
})
```

---

## Phase 5: Frontend Integration

### Create `src/lib/utils/updater.ts`

```typescript
import { check } from "@tauri-apps/plugin-updater";
import { ask, message } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";

export interface UpdateInfo {
  version: string;
  currentVersion: string;
  body?: string;
  date?: string;
}

export async function checkForUpdates(silent = false): Promise<UpdateInfo | null> {
  try {
    const update = await check();

    if (!update?.available) {
      if (!silent) {
        await message("You're running the latest version!", {
          title: "No Updates Available",
          kind: "info"
        });
      }
      return null;
    }

    return {
      version: update.version,
      currentVersion: update.currentVersion,
      body: update.body,
      date: update.date
    };
  } catch (error) {
    console.error("Update check failed:", error);
    if (!silent) {
      await message(`Failed to check for updates: ${error}`, {
        title: "Update Error",
        kind: "error"
      });
    }
    return null;
  }
}

export async function promptAndInstallUpdate(update: UpdateInfo): Promise<boolean> {
  const shouldUpdate = await ask(
    `Version ${update.version} is available!\n\n${update.body || ""}`,
    {
      title: "Update Available",
      kind: "info",
      okLabel: "Update Now",
      cancelLabel: "Later"
    }
  );

  if (!shouldUpdate) {
    return false;
  }

  try {
    const updateObj = await check();
    if (updateObj?.available) {
      await updateObj.downloadAndInstall((progress) => {
        // Optional: Track download progress
        if (progress.event === "Started") {
          console.log(`Downloading update: ${progress.data.contentLength} bytes`);
        } else if (progress.event === "Progress") {
          console.log(`Downloaded: ${progress.data.chunkLength} bytes`);
        } else if (progress.event === "Finished") {
          console.log("Download complete");
        }
      });
      await relaunch();
      return true;
    }
  } catch (error) {
    console.error("Update installation failed:", error);
    await message(`Failed to install update: ${error}`, {
      title: "Update Error",
      kind: "error"
    });
  }

  return false;
}

export async function checkAndPromptForUpdates(silent = false): Promise<void> {
  const update = await checkForUpdates(silent);
  if (update) {
    await promptAndInstallUpdate(update);
  }
}
```

### Integration Points

1. **App Startup** - Check silently in `src/routes/+page.svelte`:
   ```typescript
   import { checkAndPromptForUpdates } from "$lib/utils/updater";

   onMount(() => {
     // Check for updates silently on startup
     checkAndPromptForUpdates(true);
   });
   ```

2. **Settings Page** - Add manual check button in `src/routes/settings/+page.svelte`:
   ```svelte
   <button onclick={() => checkAndPromptForUpdates(false)}>
     Check for Updates
   </button>
   ```

3. **Periodic Checks** - Optional interval checking:
   ```typescript
   // Check every 24 hours
   setInterval(() => checkAndPromptForUpdates(true), 24 * 60 * 60 * 1000);
   ```

---

## Phase 6: Update Manifest Format

The `latest.json` file describes available updates:

```json
{
  "version": "1.0.0",
  "notes": "Release notes in markdown format",
  "pub_date": "2025-12-03T10:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "CONTENTS_OF_SIG_FILE",
      "url": "https://github.com/USER/REPO/releases/download/v1.0.0/open-whisperer_1.0.0_x64-setup.nsis.zip"
    }
  }
}
```

### Required Fields

| Field | Description |
|-------|-------------|
| `version` | Semver version string |
| `platforms[target].url` | Download URL for the installer |
| `platforms[target].signature` | Contents of the `.sig` file |

### Optional Fields

| Field | Description |
|-------|-------------|
| `notes` | Release notes (supports markdown) |
| `pub_date` | ISO 8601 timestamp |

---

## Phase 7: Build Process

### Environment Variables

Set before building:

**PowerShell:**
```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = "C:\Users\USERNAME\.tauri\open-whisperer.key"
# Or paste the key content directly:
# $env:TAURI_SIGNING_PRIVATE_KEY = "dW50cnVzdGVkIGNvbW1lbnQ6..."

$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""  # If key is password-protected
```

**CMD:**
```cmd
set TAURI_SIGNING_PRIVATE_KEY=C:\Users\USERNAME\.tauri\open-whisperer.key
```

### Build Command

```bash
npm run tauri:build
```

### Build Output

Located in `src-tauri/target/release/bundle/`:
- `nsis/open-whisperer_X.X.X_x64-setup.exe`
- `nsis/open-whisperer_X.X.X_x64-setup.exe.sig` (signature file)
- `nsis/open-whisperer_X.X.X_x64-setup.nsis.zip` (for updater)
- `nsis/open-whisperer_X.X.X_x64-setup.nsis.zip.sig`

---

## Phase 8: GitHub Releases Distribution

### Manual Release Process

1. Update version in `package.json` and `src-tauri/Cargo.toml`
2. Build with signing keys set
3. Create GitHub release with tag `vX.X.X`
4. Upload:
   - `open-whisperer_X.X.X_x64-setup.nsis.zip`
   - `open-whisperer_X.X.X_x64-setup.nsis.zip.sig`
   - `latest.json` (created manually or via script)

### Automated Release with GitHub Actions

Create `.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

jobs:
  release:
    permissions:
      contents: write
    runs-on: windows-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'

      - name: Setup Rust
        uses: dtolnay/rust-toolchain@stable

      - name: Rust cache
        uses: swatinem/rust-cache@v2
        with:
          workspaces: './src-tauri -> target'

      - name: Install dependencies
        run: npm ci

      - name: Install sidecar dependencies
        run: npm run sidecar:install

      - name: Build sidecar
        run: npm run sidecar:build

      - name: Build Tauri app
        uses: tauri-apps/tauri-action@v0
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
          TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
        with:
          tagName: v__VERSION__
          releaseName: 'OpenWhisperer v__VERSION__'
          releaseBody: 'See the assets to download and install this version.'
          releaseDraft: true
          prerelease: false
          includeUpdaterJson: true
```

### Required GitHub Secrets

Add these in repository Settings > Secrets and variables > Actions:

| Secret | Value |
|--------|-------|
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of `.key` file or path |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password if key is protected (can be empty) |

---

## Phase 9: Windows Code Signing (Optional)

### Why Code Sign?

- **Update signing** (Ed25519) - Verifies updates came from you
- **Windows code signing** (certificate) - Removes SmartScreen warnings

### Certificate Options

| Type | Cost | SmartScreen | Requirements |
|------|------|-------------|--------------|
| None | Free | Warning on first run | None |
| OV Certificate | ~$100-200/yr | Warning until reputation builds | Identity verification |
| EV Certificate | ~$400+/yr | No warnings | HSM hardware token |

### Configuration

Add to `src-tauri/tauri.conf.json`:

```json
{
  "bundle": {
    "windows": {
      "certificateThumbprint": "YOUR_CERT_THUMBPRINT",
      "digestAlgorithm": "sha256",
      "timestampUrl": "http://timestamp.digicert.com"
    }
  }
}
```

### Environment Variables for CI

```yaml
env:
  TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
  # For code signing (if using):
  WINDOWS_CERTIFICATE: ${{ secrets.WINDOWS_CERTIFICATE }}
  WINDOWS_CERTIFICATE_PASSWORD: ${{ secrets.WINDOWS_CERTIFICATE_PASSWORD }}
```

---

## Phase 10: Testing

### Local Testing

1. Build version `0.1.0` and install
2. Update version to `0.2.0` in config files
3. Build version `0.2.0` with signing
4. Create local `latest.json` pointing to the new build
5. Serve `latest.json` locally (e.g., `npx serve`)
6. Temporarily update endpoint to `http://localhost:3000/latest.json`
7. Add `"dangerousInsecureTransportProtocol": true` to updater config
8. Run version `0.1.0` and trigger update check

### Checklist

- [ ] Signing keys generated and stored securely
- [ ] Public key added to `tauri.conf.json`
- [ ] Plugin dependencies installed (Rust + JS)
- [ ] Plugin registered in `lib.rs`
- [ ] Frontend update utilities created
- [ ] Update check integrated into app
- [ ] GitHub Actions workflow created
- [ ] GitHub Secrets configured
- [ ] Test update from older version
- [ ] Verify signature verification works
- [ ] Test with invalid signature (should fail)

---

## Troubleshooting

### Common Issues

**"Signature verification failed"**
- Ensure the signature in `latest.json` matches the `.sig` file contents
- Verify the public key in config matches the private key used for signing

**"No update available" when there should be**
- Check version comparison (must be semver, new version must be higher)
- Verify endpoint URL is accessible
- Check `latest.json` format and platform keys

**"Failed to download update"**
- Verify URL in `latest.json` is correct and accessible
- Check for CORS issues if using custom server
- Ensure the file extension matches expected format

**Build doesn't produce `.sig` files**
- Ensure `TAURI_SIGNING_PRIVATE_KEY` environment variable is set
- Verify `createUpdaterArtifacts: true` in bundle config

---

## Resources

- [Tauri v2 Updater Plugin Documentation](https://v2.tauri.app/plugin/updater/)
- [GitHub Release Distribution](https://v2.tauri.app/distribute/pipelines/github/)
- [Windows Code Signing](https://v2.tauri.app/distribute/sign/windows/)
- [tauri-apps/tauri-action](https://github.com/tauri-apps/tauri-action)

---

## Summary

Implementation order:
1. Generate signing keys
2. Install dependencies
3. Configure `tauri.conf.json`
4. Register plugin in Rust
5. Create frontend utilities
6. Add UI integration (settings button, startup check)
7. Set up GitHub Actions
8. Configure GitHub Secrets
9. Test with a release
10. (Optional) Add Windows code signing
