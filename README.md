# SGSql

## Build the macOS app

SGSql is bundled as a macOS application using Tauri. The database sidecar is a Rust binary (`src-tauri/sidecar`, built on axum + sqlx) compiled with Cargo and included in the application bundle.

### Prerequisites

Install the Xcode command-line tools:

```bash
xcode-select --install
```

Install Rust, then add the Apple Silicon macOS target:

```bash
rustup target add aarch64-apple-darwin
```

Install the project dependencies:

```bash
bun install
```

Create a stable local code-signing identity (one-time, see [Code signing](#code-signing) below):

```bash
./scripts/setup-codesign-identity.sh
```

## Run in development

Compile and sign the database sidecar before the first development run, or whenever its source changes:

```bash
bun run sidecar:build
```

Start the Tauri development application:

```bash
bun run tauri dev
```

Tauri starts the Vite development server automatically and launches the desktop application. Frontend changes are applied through Vite hot reload; Rust changes cause the Tauri application to rebuild.

To run the sidecar directly while developing it, use two terminals:

```bash
# Terminal 1
bun run sidecar:dev
```

```bash
# Terminal 2
bun run tauri dev
```

The development application detects the sidecar on port `45821` and uses it instead of starting the compiled binary. Stop both processes when finished.

### Create the application bundle

Compile the database sidecar first, then build the Tauri application:

```bash
bun run sidecar:build
bun run tauri build
```

The generated bundles are written to:

```text
src-tauri/target/release/bundle/macos/SGSql.app
src-tauri/target/release/bundle/dmg/SGSql_0.1.0_aarch64.dmg
```

Verify the completed application bundle before sharing it:

```bash
codesign --verify --deep --strict --verbose=2 \
  src-tauri/target/release/bundle/macos/SGSql.app
```

### Architecture support

The current sidecar build produces `dbsidecar-aarch64-apple-darwin`, so the packaged application supports Apple Silicon Macs only. Intel or universal macOS builds require additional sidecar binaries for their respective targets.

### Code signing

The app and sidecar are signed with a **stable, self-signed** code-signing
identity (`SGSql Developer`) rather than ad-hoc (`-`) signing.

Ad-hoc signatures are a hash of the binary itself, so they change on every
build. macOS Keychain access-control lists are bound to the app's signature,
so an ad-hoc-signed app looks like a *different, untrusted app* after every
rebuild — this is why Keychain used to prompt for the store password on every
new release. A self-signed identity keeps the same signature across builds
(same certificate, same key), so the Keychain entry keeps matching and the
app is not re-prompted.

Run this once per machine to generate and install the identity:

```bash
./scripts/setup-codesign-identity.sh
```

This does **not** make Gatekeeper trust the app on other people's Macs —
self-signed certificates aren't in Apple's trust chain. Downloaded builds
still show an "unidentified developer" warning on first launch. Avoiding that
warning requires a paid Apple Developer ID Application certificate and
notarization; swap `signingIdentity` in `src-tauri/tauri.conf.json` for your
Developer ID identity and add a notarization step if/when you enroll.

### Distribution

Self-signed builds can be used for development and trusted internal testing.
A downloaded build still requires the user to approve it once in macOS
Privacy & Security (right-click → Open). To distribute the application
without that manual approval, code-sign and notarize it with an Apple
Developer ID certificate instead of the self-signed one described above.

## Releases and auto-update

Tagged pushes (`vX.Y.Z`) trigger [`.github/workflows/release.yml`](.github/workflows/release.yml),
which builds the sidecar and the signed `.app`/`.dmg`, then publishes them as
a draft GitHub Release along with `latest.json` — the manifest the in-app
updater polls. No separate update server or website is needed; the updater's
endpoint in `src-tauri/tauri.conf.json` points straight at
`https://github.com/stalingino/sgsql/releases/latest/download/latest.json`.

To cut a release:

1. Bump `version` in `package.json` and `src-tauri/tauri.conf.json`.
2. Commit, then tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. Wait for the workflow to finish, review the draft release, publish it.

Update artifacts are signed with a separate Tauri updater keypair (unrelated
to the macOS code-signing identity above) so the app can verify downloaded
updates weren't tampered with. The public key is already embedded in
`tauri.conf.json`. The private key lives at `~/.tauri/sgsql-updater.key`
(generated locally, **not committed**) — for CI to sign releases, add these
repository secrets under Settings → Secrets and variables → Actions:

| Secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | contents of `~/.tauri/sgsql-updater.key` |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | contents of `~/.tauri/sgsql-updater.key.password` |
| `APPLE_CODESIGN_P12_BASE64` | `base64 -i sgsql-codesign.p12` (export via `security export`, see `setup-codesign-identity.sh` output) |
| `APPLE_CODESIGN_P12_PASSWORD` | the password used when exporting the `.p12` |

Back up `~/.tauri/sgsql-updater.key` and its password somewhere safe outside
the repo — losing it means future releases can no longer be verified by
apps that already trust the current public key, breaking auto-update for
existing users.

In the app, users can check for updates manually from Settings → Updates, or
you can wire `checkForUpdate()` from `src/lib/updater.ts` into a startup
check.
