# macOS release CI notes (v1.3.3 investigation, 2026-07-14/15)

## Original symptom
Locally-built app icon switched with macOS dark/light mode correctly.
GitHub Actions-built app only ever showed the light icon.

## Root cause #1: CI runner too old for the Liquid Glass icon (fixed)
`src-tauri/src/macos_icon.rs` skips its manual dark/light Dock-icon swap on
macOS 26+, trusting the native `Assets.car` compiled from
`icons/AppIcon.icon` (an Xcode 26 "Icon Composer" catalog) to handle
light/dark/tinted rendering itself. The release workflow was pinned to
`runs-on: macos-14`, whose Xcode (15/16) can't compile that catalog at all,
so the shipped `.app` never got a native `Assets.car` with a dark variant —
and since end users run macOS 26, the manual fallback correctly no-op'd,
leaving the app stuck on the light icon.

**Fix:** switched `runs-on` to `macos-26` (GA on GitHub-hosted runners since
Feb 2026).

## Root cause #2: `actool` version bugs on the `macos-26` runner (unresolved on CI)
Bumping to `macos-26` did not fix the release — bundling started failing at
`Failed to create app Assets.car: \`failed to run actool\``, with no further
detail (tauri-bundler only logs the spawned actool's stdout/stderr at
`debug` level, invisible in normal `tauri-action` output).

Chased through ~6 CI cycles:
- `tauri-bundler`'s `create_assets_car_file()` (crates/tauri-bundler/src/bundle/macos/icon.rs
  in tauri-apps/tauri) spawns a **bare** `Command::new("actool")` — not
  `xcrun actool` — with a fixed arg list including
  `--minimum-deployment-target 26.0` and `--platform macosx`, against a
  copy of `icons/AppIcon.icon` under a fresh `tempfile::tempdir()`.
- Ruled out via standalone reproduction (identical args, run directly in a
  workflow step): PATH resolution, missing `DEVELOPER_DIR`, the per-file
  `copy_dir` semantics, and `$TMPDIR` vs `$RUNNER_TEMP` — all succeeded
  standalone, yet the real build kept failing identically.
- Adding `-vv` to `tauri build` finally surfaced the real actool output:
  **`macos-26`'s default actool is 26.5**, and it crashes with an
  Objective-C exception —
  `-[__NSPlaceholderArray initWithObjects:count:]: attempt to insert nil
  object from objects[0]` — deep in `AssetCatalogFoundation`
  (`selectCatalogIconComposerItemsFromCollection:...`) while parsing this
  repo's `icon.json`. This looks like a genuine Apple regression in actool
  26.5 for this Icon Composer JSON shape (possibly a race in its background
  compile queue — the crash only reproduced when actool ran right after ~5
  minutes of CPU-saturating parallel `cargo build`, never in a fresh
  standalone repro).
- Local builds use Xcode 26.3's actool (confirmed via `xcrun actool
  --version`) and never hit this crash.
- The `macos-26` runner image ships Xcode 26.0 through 26.6 side-by-side
  (`/Applications/Xcode_26.{0,0.1,1,1.1,2,2.0,3,3.0,4,4.1,5,5.0,6,6.0}.app`).
  Pinning to 26.3 via `sudo xcode-select -s /Applications/Xcode_26.3.app`
  avoided the crash — but then actool failed differently:
  `actool did not generate Assets.car file`, with a notice:
  `The operation couldn't be completed. Bad file descriptor`.
  This only happens when actool is invoked from deep inside the real build's
  process tree (`tauri-action` → node → bun → cargo-built `tauri` binary →
  actool); every standalone repro at every version tested succeeded. Looks
  like an FD-inheritance quirk specific to that nested spawn chain, not
  something a workflow-level env tweak fixes.

**Status:** not resolved on CI. Decision (2026-07-15): stop chasing actool
bugs in the runner environment for now; build and sign macOS releases
**locally** instead, where the full pipeline (including `Assets.car`
compilation) already works reliably, and upload artifacts to GitHub
manually. Revisit CI-based Liquid Glass icon builds later — worth checking
whether a subsequent actool point release (26.7+) fixes both issues before
trying again.

## Updater signing key rotation (2026-07-15)
The original updater key (`~/.tauri/sgsql-updater.key`, pubkey ending
`...E0Ar3OZ6i0MEG5iBDj5o=`) has a password that was never recorded anywhere
retrievable — not in this repo, not in a password manager, and GitHub
Actions secrets are write-only (no API/CLI can read a secret's value back
once set, confirmed via `gh secret list`, which only returns names).

Generated a replacement keypair and updated
`plugins.updater.pubkey` in `src-tauri/tauri.conf.json` accordingly:
- Private key: `~/.tauri/sgsql-updater-v2.key` (password in
  `updater-key-secret.local` at the repo root, gitignored via the existing
  `*.local` pattern — never commit this).
- Old orphaned key kept at `~/.tauri/sgsql-updater.key` for reference only;
  it can no longer sign anything usable.

**Consequence:** any install on v1.3.2 or earlier trusts the old public key
baked into its binary and will silently fail signature verification on
future auto-update checks. Only fresh downloads of v1.3.3+ (which embed the
new pubkey) will auto-update correctly going forward. If this matters,
existing users need a manual reinstall from v1.3.3+.

## v1.3.3 release
Built and signed locally (`bun run tauri build --target aarch64-apple-darwin`
with `TAURI_SIGNING_PRIVATE_KEY`/`_PASSWORD` from the new key). Artifacts
uploaded to a **draft** GitHub release under tag `v1.3.3`:
`SGSql_1.3.3_aarch64.dmg`, `SGSql_aarch64.app.tar.gz` (+ `.sig`), and a
hand-built `latest.json` matching tauri-action's asset naming/URL
conventions from prior releases (checked against v1.3.2's actual
`latest.json` for the exact schema). Left as a draft for manual review
before publishing.

## Where things are for local releases
- Updater signing key: `~/.tauri/sgsql-updater.key` (minisign, password
  protected — password not stored in the repo or shell history; must be
  supplied at sign time via `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`).
- Code signing identity: `SGSql Developer` (local keychain), matches
  `bundle.macOS.signingIdentity` in `src-tauri/tauri.conf.json`.
- `.github/workflows/release.yml` still targets `macos-26` +
  `sudo xcode-select -s /Applications/Xcode_26.3.app`; left in place in case
  CI releases are revisited later, but not currently relied upon.
