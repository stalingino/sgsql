# SG SQL

## Build the macOS app

SG SQL is bundled as a macOS application using Tauri. The database sidecar is compiled with Bun and included in the application bundle.

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

## Run in development

Compile and ad-hoc sign the database sidecar before the first development run, or whenever its source changes:

```bash
bun run sidecar:build
```

Start the Tauri development application:

```bash
bun run tauri dev
```

Tauri starts the Vite development server automatically and launches the desktop application. Frontend changes are applied through Vite hot reload; Rust changes cause the Tauri application to rebuild.

To run the TypeScript sidecar directly while developing it, use two terminals:

```bash
# Terminal 1
bun run sidecar/index.ts
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
src-tauri/target/release/bundle/macos/sgsql.app
src-tauri/target/release/bundle/dmg/sgsql_0.1.0_aarch64.dmg
```

### Architecture support

The current sidecar build produces `dbsidecar-aarch64-apple-darwin`, so the packaged application supports Apple Silicon Macs only. Intel or universal macOS builds require additional sidecar binaries for their respective targets.

### Distribution

Local unsigned builds can be used for development and testing. To distribute the application to other users without macOS security warnings, code-sign and notarize the application with an Apple Developer certificate.
