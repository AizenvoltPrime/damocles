# Releasing Damocles

This document describes how tagged releases turn into per-platform VSIXes and how they reach the Visual Studio Marketplace.

## Overview

`.github/workflows/release.yml` runs when a tag matching `v*` is pushed. It has three jobs:

1. **`verify`** — runs once on `ubuntu-latest`: validates that `package.json` version matches the tag, then runs `npm run typecheck` and `npm test`. Must pass before any packaging starts.
2. **`package` matrix** — builds one `.vsix` per VS Code target platform (`win32-x64`, `win32-arm64`, `darwin-x64`, `darwin-arm64`, `linux-x64`, `linux-arm64`, `alpine-x64`, `alpine-arm64`) on a runner whose OS and CPU architecture match the target. Each job verifies the resulting VSIX bundles the correct target sidecar and exceeds a minimum size threshold.
3. **`release` aggregator** — downloads every artifact, creates a single GitHub Release with all VSIXes attached, and (if the relevant secret is set) publishes every VSIX to:
   - the **Visual Studio Marketplace** (gated on `VSCE_PAT`), used by upstream VS Code.
   - the **Open VSX Registry** (gated on `OVSX_PAT`), used by VSCodium, Cursor, Windsurf, Gitpod, Theia, and other non-Microsoft-brand VS Code-compatible editors.

Each publish step is independent — if one secret is unset, its publish is skipped without failing the run, and the GitHub Release still receives every VSIX.

Per-platform VSIXes are required because `@anthropic-ai/claude-agent-sdk` ships the Claude Code runtime as a native binary via per-platform optional dependencies (`@anthropic-ai/claude-agent-sdk-{platform}-{arch}(-musl)?`). A single universal VSIX would only contain the publisher's host binary and would be broken for every other platform.

## How the matrix works

Each target runs on a matching-OS+arch runner. `npm ci` then picks the host-matching optional dependencies natively — no cross-install flags, no per-OS edge cases for native build tools (`@rollup/rollup-*`, `@swc/core-*`, etc.):

| Target            | Runner              | Sidecar package                                    |
| ----------------- | ------------------- | -------------------------------------------------- |
| `win32-x64`       | `windows-latest`    | `claude-agent-sdk-win32-x64`                       |
| `win32-arm64`     | `windows-11-arm`    | `claude-agent-sdk-win32-arm64`                     |
| `darwin-x64`      | `macos-13`          | `claude-agent-sdk-darwin-x64`                      |
| `darwin-arm64`    | `macos-latest`      | `claude-agent-sdk-darwin-arm64`                    |
| `linux-x64`       | `ubuntu-latest`     | `claude-agent-sdk-linux-x64`                       |
| `linux-arm64`     | `ubuntu-24.04-arm`  | `claude-agent-sdk-linux-arm64`                     |
| `alpine-x64`      | `ubuntu-latest` (in `node:24-alpine` container) | `claude-agent-sdk-linux-x64-musl`   |
| `alpine-arm64`    | `ubuntu-24.04-arm` (in `node:24-alpine` container) | `claude-agent-sdk-linux-arm64-musl` |

Alpine targets run `npm ci && npm run build && vsce package` inside a `node:24-alpine` Docker container mounted on the host's workspace, so the musl-linked sidecar is installed against musl libc. The host then uploads the resulting VSIX as an artifact.

Packaging uses plain `npx @vscode/vsce package --target <target>` — no `--no-dependencies`. `.vscodeignore` whitelists only the runtime sidecars we ship (`@anthropic-ai/**`, `zod`, `web-tree-sitter`, the pi packages), so build-only dev dependencies are excluded while the platform sidecar stays in the VSIX. (SQLite now uses Node's built-in `node:sqlite` — no bundled WASM/native module.)

## Per-VSIX verification

Every matrix entry runs the same integrity check:

```bash
expected="extension/node_modules/@anthropic-ai/<sidecar>/<binary>"
unzip -l "$VSIX_NAME" | grep -qF "$expected" || fail
[ "$(wc -c < "$VSIX_NAME")" -ge 30000000 ] || fail  # ~30 MB floor
```

The first check proves the target-specific sidecar is present at the path the runtime loader expects. The size floor catches a class of silent failures where `vsce` produces a VSIX with no `node_modules/` at all (e.g. a stray `--no-dependencies` flag or a wrong `.vscodeignore` rule) — a correctly produced VSIX is 60-100 MB because the native Claude binary alone is ~50 MB.

## Verifying a VSIX locally

Build on the matching host OS (cross-install is not supported for this project because of native build tools like Rollup):

```bash
npm ci
npm run build
npx @vscode/vsce package --target <target> --out /tmp/damocles-<target>.vsix
unzip -l /tmp/damocles-<target>.vsix | grep -i claude
```

For Linux-musl, run the same sequence inside `docker run --rm -v $PWD:/work -w /work node:24-alpine sh -c '...'`.

## Marketplace publishing — `VSCE_PAT`

The publish step is gated by `if: ${{ secrets.VSCE_PAT != '' }}`. When the secret is unset, VSIXes still attach to the GitHub Release — only the Marketplace push is skipped.

To enable Marketplace publishing:

1. Sign in to [Azure DevOps](https://dev.azure.com/) with the account tied to the `Aizenvolt` Marketplace publisher (or an organization member who has access).
2. Open **User Settings → Personal Access Tokens → New Token**.
3. Configure the token:
   - **Organization**: All accessible organizations
   - **Expiration**: choose a sensible cadence (≤ 12 months); set a calendar reminder to rotate before expiry.
   - **Scopes**: **Custom defined** → **Marketplace** → ✔ **Manage**. Do not grant `Code`, `Packaging`, or any other scope.
4. Copy the generated token value (it is shown only once).
5. In the GitHub repo, go to **Settings → Secrets and variables → Actions → New repository secret** and save it as `VSCE_PAT`.

## Open VSX publishing — `OVSX_PAT`

Open VSX is the open-source registry used by editors that cannot legally ship the proprietary Microsoft Marketplace integration — VSCodium, Cursor, Windsurf, Gitpod, Eclipse Theia, and others. Publishing to both registries keeps Damocles installable everywhere.

The publish step is gated by `if: ${{ secrets.OVSX_PAT != '' }}`. When the secret is unset, the Open VSX push is skipped; other steps run unchanged.

To enable Open VSX publishing:

1. Create or sign in to an account at [open-vsx.org](https://open-vsx.org/) using the same GitHub identity that owns the extension's source repository.
2. The first time you publish, you must also create a matching **namespace** (e.g. `Aizenvolt`) — follow the [publishing docs](https://github.com/eclipse/openvsx/wiki/Publishing-Extensions#how-to-publish-an-extension). Namespace creation and claiming are one-time steps.
3. Open **User Settings (avatar) → Tokens → Generate New Token**. Give it a descriptive name like `damocles-ci` and a sensible expiry.
4. Copy the generated token value (it is shown only once).
5. In the GitHub repo, go to **Settings → Secrets and variables → Actions → New repository secret** and save it as `OVSX_PAT`.

`ovsx` reads the same `--target <platform>` field that `vsce` embeds in the VSIX manifest, so per-platform VSIXes produced by the matrix upload correctly without additional flags.

## Tagging a release

1. Bump `package.json` `version` to match the intended tag (the workflow fails loudly if they disagree).
2. Update `CHANGELOG.md` with a `## [x.y.z] - YYYY-MM-DD` section.
3. Commit with a `feat(release): <title>` subject — the workflow extracts the title from this commit.
4. Tag and push:

   ```bash
   git tag vx.y.z
   git push origin vx.y.z
   ```

5. Watch the workflow in **Actions**. On success, verify per-platform VSIXes are served correctly on both the [VS Marketplace listing](https://marketplace.visualstudio.com/items?itemName=Aizenvolt.damocles) and the [Open VSX listing](https://open-vsx.org/extension/Aizenvolt/damocles), and install at least one on each major OS (Windows, macOS, Linux) to confirm activation.

## Publish failure recovery

Each publish loop runs sequentially and fails the workflow on the first error. If one target publishes and a later one fails:

- The GitHub Release already has all VSIXes attached — nothing to re-upload there.
- Re-publishing the same version of an already-published target returns a 409 on both registries; neither marketplace will double-publish.
- To resume, either fix the underlying cause and re-run the workflow (downloads are deterministic per tag), or run the publish commands locally for the missing targets using artifacts downloaded from the Release:

  ```bash
  npx @vscode/vsce publish --packagePath damocles-<target>-<version>.vsix --pat "$VSCE_PAT"
  npx ovsx publish damocles-<target>-<version>.vsix -p "$OVSX_PAT"
  ```
