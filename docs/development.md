# Development

This page covers building Damocles from source, the development commands, packaging the extension and the desktop app, and the extension's architecture.

## Building from source

1. Clone the repository.
2. Run `npm install` with Node.js 24.16 or later (`engines.node`; `.npmrc` sets `engine-strict`, so npm refuses an older Node).
3. Run `npm run build`.
4. Press F5 in VS Code to launch the Extension Development Host.

## Commands

```bash
# Install dependencies
npm install

# Build extension and webview
npm run build

# Watch mode for development
npm run dev

# Type check
npm run typecheck

# Run tests
npm test
```

`scripts/smoke-desktop/` drives the dev desktop app with a real model, one step at a time, for manual smoke tests; its README covers the setup.

## Packaging the extension

To create a distributable `.vsix` file:

```bash
npm run build && npm run package
```

This generates `damocles-<version>.vsix`, which can be installed via:

- **VS Code UI**: Extensions → `...` menu → "Install from VSIX..."
- **Command line**: `code --install-extension damocles-<version>.vsix`

## Packaging the desktop app

To build the desktop app installer for the current platform into `dist-desktop/`:

```bash
npm run dist
```

It never publishes. See [Releasing Damocles](release.md) for the release workflow and the other platforms, and [Desktop code signing](desktop-signing.md) for the signing procedure.

For a build with no GitHub release, `npm run dist:local` also builds all eight remote server packages (Docker for the Alpine ones) and copies them into the packaged app's server cache on this computer, so remote installs work whatever the version number: SSH hosts, and containers on them, get the package uploaded from that cache, and WSL distros and local containers copy it. Such a build installs a server only from that cache, so its installer run on another computer, or an app an earlier `npm run dist:local` made, installs on no host; run `npm run dist:local` on the computer that runs the app and install what it makes. A plain `npm run dist` packs whatever dev server manifest is in `dist/desktop/` and fills no cache, so its app installs on no host either, and the packaged app refuses an incomplete manifest.

## Architecture

- **Extension Host** (Node.js): runs the pi agent engine, tools, permissions, and all subsystems
- **Webview** (Vue 3 + Tailwind): chat interface
- **postMessage Bridge**: communication between extension and webview

The rules and failure modes behind each subsystem are in [Invariants](invariants.md).
