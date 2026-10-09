# Releasing Damocles

This document describes how one tag turns into per-platform VSIXes and desktop installers, and how they reach GitHub Releases, the Visual Studio Marketplace and the Open VSX Registry.

## Overview

`.github/workflows/release.yml` runs when a tag matching `v*` is pushed. It has eight jobs.

```
verify ─┬─ package (7 VSIX legs) ─────────────────────────────────────┐
        ├─ e2e-desktop (13 shards) ───────────────────────────────────┤
        └─ package-desktop (5 installer legs) ─┬─ verify-desktop-install (4 legs) ─┼─ attest ─ release
                                               └─ desktop-update-test (3 legs) ────┘
```

1. **`verify`** runs once on `ubuntu-latest` under Node 24. After `npm ci` it checks the `package.json` version against the tag, then runs `npm run typecheck`, `npm run lint`, `npm test`, `npm run smoke:pi`, and `node scripts/sync-vscodeignore.mjs --check`. All six gates must pass before any packaging starts.
2. **`package`** builds one `.vsix` per VS Code target platform. There are seven targets: `win32-x64`, `win32-arm64`, `darwin-arm64`, `linux-x64`, `linux-arm64`, `alpine-x64`, `alpine-arm64`. There is no `darwin-x64` target, so an Intel Mac gets no artifact from the matrix. The matrix is `fail-fast: true`, so the first failing leg cancels the others. Each leg runs three integrity checks against the VSIX it produced, then uploads it as the artifact `vsix-<target>` with a 7 day retention and `if-no-files-found: error`.
3. **`package-desktop`** builds the desktop installers, one leg per target: Windows x64 and arm64 (NSIS), macOS arm64 (dmg and zip), Linux x64 and arm64 (deb and rpm). Each leg packages, checks the package's contents and Electron fuses, runs the end-to-end suite against the packaged app, and uploads the leg's installers, blockmaps and `latest*.yml` as `desktop-<target>`. The matrix is `fail-fast: false`, so a failing leg does not cancel the others and one run reports every platform's result; `release` still needs every leg. See "Desktop installers" below.
4. **`e2e-desktop`** runs the dev end-to-end suite on the same five targets and runners, in parallel with `package-desktop`, split into Playwright shards. See "Desktop end-to-end suite".
5. **`verify-desktop-install`** installs those installers on fresh runners and launches them. See "Install verification".
6. **`desktop-update-test`** installs version N and updates it to a locally served N+1. See "Update tests".
7. **`attest`** downloads the same artifacts and creates a GitHub build provenance attestation for every file the release attaches. See "Provenance and checksums".
8. **`release`** runs only when every job above passed. It downloads the `vsix-*` and `desktop-*` artifacts into `dist-artifacts/`, checks that all seven VSIXes and every desktop artifact are there, writes `SHA256SUMS` over them, creates one GitHub Release with all of them and `SHA256SUMS` attached, and publishes each VSIX to the Visual Studio Marketplace (gated on `VSCE_PAT`) and to the Open VSX Registry (gated on `OVSX_PAT`).

Each publish step is gated independently. When one secret is unset, that step is skipped without failing the run, and the GitHub Release still carries every VSIX and installer.

The workflow's `GITHUB_TOKEN` is read-only (`permissions: contents: read`), and every checkout sets `persist-credentials: false`, so no build step, and no dependency install script, can push or move a tag. Two jobs widen the token for themselves only: `attest` gets `id-token: write` and `attestations: write`, and `release` gets `contents: write`, which `gh release create` uses through `GH_TOKEN: ${{ github.token }}`. No personal access token is involved: the only secrets are `VSCE_PAT` and `OVSX_PAT`, and only `release` reads them. A `PAT` repository secret left from earlier releases is no longer read; delete it. No desktop job reads a secret. Every `uses:` is pinned to a full commit SHA with its version in a trailing comment, Dependabot's `github-actions` updates keep those pins current, and `scripts/__tests__/release-targets.test.ts` fails on a tag or branch pin.

Per-platform VSIXes are required because `@vscode/ripgrep` resolves its binary from a per-platform optional dependency (`@vscode/ripgrep-win32-x64`, `@vscode/ripgrep-linux-arm64`, and so on). `npm ci` installs only the one matching the build machine, so a single universal VSIX would carry only the publisher's host binary and would ship no working ripgrep for any other platform. Damocles calls ripgrep for `@` file autocomplete.

## The verify job

The six gates, in workflow order, with the step name the Actions log shows:

| Step name | What it runs |
| --- | --- |
| Verify package.json version matches tag | compares `node -p "require('./package.json').version"` against `${GITHUB_REF_NAME#v}` and exits 1 when they differ |
| Typecheck | `npm run typecheck` |
| Lint | `npm run lint`, which also enforces that core code never imports `vscode` or `electron` |
| Test | `npm test` |
| Smoke test pi runtime contract | `npm run smoke:pi` |
| Verify .vscodeignore allowlist is in sync | `node scripts/sync-vscodeignore.mjs --check` |

`npm run smoke:pi` runs `scripts/pi-smoke.mjs`, which imports pi for real with no auth and no network. It asserts that every pi subpath the extension resolves is reachable from the installed `node_modules`, that `ModelRuntime.prototype.completeSimple` is a function, and that an agent dir seeded with `compaction.enabled=false` yields a session with auto-compaction off. The script exits 2 below Node 22, which is why the job pins Node 24.

`node scripts/sync-vscodeignore.mjs --check` is a staleness gate on the committed `.vscodeignore`. It is described under "How `.vscodeignore` is built" below.

## How the matrix works

`scripts/release-targets.mjs` owns the packaging-relevant columns. `RELEASE_TARGETS` maps each target key to its `rgPkg` and `rgBin`, and the Linux and Alpine entries also carry `arch` and `libc`. Read that file for the per-target values rather than a table here, which would rot.

Actions resolves `strategy.matrix` before any JavaScript could run, so the workflow cannot import that module and keeps its own static copy of the same data. `scripts/__tests__/release-targets.test.ts` parses the workflow and fails when the two disagree on the target set, on any `rgPkg` or `rgBin`, on the size floor, or on which targets are containerised. That test is the only thing standing between a renamed ripgrep package and a silently broken release artifact, and `npm test` in the `verify` job runs it.

The shape of the matrix:

- Each target runs on a runner whose OS and CPU architecture match it, so `npm ci` picks the host-matching optional dependencies natively. No cross-install flags, and no per-OS special cases for native build tooling such as `@rollup/rollup-*` or `@swc/core-*`.
- `alpine-x64` and `alpine-arm64` run on `ubuntu-latest` and `ubuntu-24.04-arm` respectively, but build inside a `node:24-alpine` Docker container mounted on the host workspace. The container installs `git python3 make g++ libc6-compat` with `apk`, copies `/work` to `/build`, runs `npm ci` and `vsce package` there, and copies the VSIX back to the host, which uploads it. Building against musl libc in the container is what makes the artifact loadable on an Alpine host.
- The workflow matrix carries four columns the targets file does not: `runner`, `alpineContainer`, `nativeAsset`, and `nativeReason`. `nativeAsset` is the koffi `.node` binary on the two `win32` targets and `dist/sentinel.js` on the other five.

Packaging is plain `npm run package -- --target <target> --out "$VSIX_NAME"`, with no `--no-dependencies`. The `package` script runs `vsce package`. `@vscode/vsce` and `ovsx` are exact-pinned devDependencies, so every packaging and publishing step runs the version in `package-lock.json`. The `release` job installs them with `npm ci --ignore-scripts` and calls `node_modules/.bin/vsce` and `node_modules/.bin/ovsx`, so no install script runs in the job that holds `VSCE_PAT` and `OVSX_PAT`. `VSIX_NAME` is `damocles-<target>-<tag>.vsix`. There is no separate `npm run build` step, because `vscode:prepublish` runs `node scripts/sync-vscodeignore.mjs && npm run build` for every `vsce package` invocation.

## How `.vscodeignore` is built

`.vscodeignore` excludes `node_modules/**` and then re-includes an allowlist that `scripts/sync-vscodeignore.mjs` generates between two marker comments. The script derives the allowlist from `EXTENSION_EXTERNALS` in `scripts/extension-externals.mjs`, dropping `vscode` and any `node:` builtin, and walks each remaining package's installed production dependency closure, skipping the optional peers `UNREACHABLE_OPTIONAL_PEERS` names because no shipped code loads them. Packages that declare `os` or `cpu` collapse to a platform-family glob, so `@vscode/ripgrep-win32-x64` becomes `!node_modules/@vscode/ripgrep-*/**` and the generated block stays platform-neutral. Large pure-runtime packages are narrowed further to per-extension globs plus their license and notice files (`isLicenseFile`), which MIT and Apache-2.0 require to ship with every copy, and the script throws when a narrowed package contains a file extension that is in neither its keep set nor its reviewed-dead set.

Two consequences for the pipeline:

- The `verify` job runs `node scripts/sync-vscodeignore.mjs --check`, which exits 1 when the committed block differs from what the script would generate. That catches a hand-edited or forgotten `.vscodeignore`. It runs on one platform so it fails fast, before the matrix starts.
- Every matrix leg regenerates the block in place through `vscode:prepublish`, because each build machine installs a different set of optional native packages. Packaging therefore never fails on benign cross-OS closure differences, and the committed file only has to be correct for the platform it was generated on.

SQLite uses Node's built-in `node:sqlite`, so no WASM or native SQLite module is bundled.

### Keeping the desktop app out of the VSIX

The desktop app shares the repository, so the VSIX must exclude its build output, packaging config, end-to-end suite and dependencies. Two checks enforce this:

- `DESKTOP_EXCLUDE_RULES` in `scripts/sync-vscodeignore.mjs` lists the `.vscodeignore` lines that do it: the Monaco editor (`dist/webview/assets/monaco-*`), `dist/desktop/**`, `dist/desktop-shell/**`, `dist-desktop/**` (electron-builder output), `e2e/**`, `dist/e2e*/**` (Playwright output and the second-process helper), `build/**` (the AppArmor profile and package scripts), `types/**` (typecheck-only stubs), `electron-builder.yml`, `playwright.desktop.config.ts`, `vite.shell.config.ts` and `**/*.log`. `--check` exits 1 when a rule is missing, or when a negation other than the generated `!node_modules/` block or a root file name such as `!README.md` could re-include one of these files, because vsce keeps any file a negation matches.
- `DESKTOP_ONLY_PACKAGES` and `DESKTOP_ONLY_PACKAGE_PREFIXES` name the packages only the desktop app uses: `electron`, `electron-updater`, `@parcel/watcher` and its `@parcel/watcher-*` prebuilds, `undici`, `monaco-editor`, `@playwright/test`, `playwright`, `playwright-core`, `electron-builder`, `app-builder-lib`, `app-builder-bin`, `dmg-builder` and every `@electron/*` package. Generating the allowlist throws when one of them enters the extension's dependency closure.

Both rule lists also drive `--check-vsix-listing <file>`, which reads a built VSIX's `unzip -Z1` listing and exits 1 on any entry they match. The `package` job runs it on every VSIX, so the check sees what vsce actually packed, not only what `.vscodeignore` says. To run it locally:

```bash
npm run package -- --target win32-x64 --out /tmp/damocles.vsix
unzip -Z1 /tmp/damocles.vsix > /tmp/listing.txt
node scripts/sync-vscodeignore.mjs --check-vsix-listing /tmp/listing.txt
```

## Per-VSIX verification

Every matrix leg runs three integrity steps against the VSIX it just produced. The names in bold below appear verbatim in `.github/workflows/release.yml` and in the Actions log, so grep for one to find the step.

**Verify VSIX bundles the ripgrep binary** writes `unzip -l "$VSIX_NAME"` to a temp file and fixed-string greps it for the target's ripgrep binary, then applies the size floor:

```bash
rg_expected="extension/node_modules/@vscode/${{ matrix.rgPkg }}/bin/${{ matrix.rgBin }}"
grep -qF "$rg_expected" "$listing" || fail
size=$(wc -c < "$VSIX_NAME")
[ "$size" -ge 30000000 ] || fail
```

**Verify VSIX bundles this target's shell-cleanup asset** greps the same listing for `extension/${{ matrix.nativeAsset }}`. On `win32-x64` and `win32-arm64` that is the koffi native module Damocles uses for job objects, without which a stopped command's background jobs survive. On the other five targets it is `dist/sentinel.js`, without which a closed panel leaves process groups running. Both failure messages print the full VSIX listing before exiting 1.

**Verify VSIX carries no desktop-only file** runs `node scripts/sync-vscodeignore.mjs --check-vsix-listing` on the VSIX listing (see "Keeping the desktop app out of the VSIX"). The Alpine legs run it on the host's preinstalled Node, which is enough because the listing mode reads no `node_modules`.

The ripgrep check proves the target-specific binary is present at the path the runtime resolves. The asset check proves the build produced this target's shell-cleanup asset rather than another target's, which the ripgrep check cannot see because `alpine-x64` and `linux-x64` share a `rgPkg`.

### The size floor

The floor is `30000000` bytes, written as a literal in the "Verify VSIX bundles the ripgrep binary" step and as `MIN_VSIX_BYTES = 30_000_000` in `scripts/release-targets.mjs`. `scripts/__tests__/release-targets.test.ts` extracts the literal from the workflow and asserts it equals `MIN_VSIX_BYTES`, so the two cannot drift.

What the floor catches is one failure class: a VSIX that `vsce` produced with no `node_modules/` at all, from a stray `--no-dependencies` flag or a `.vscodeignore` whose allowlist stopped matching. Such an artifact is a few MB and every content check on it would also fail, but the size check reports it in one number instead of one missing path.

The floor is deliberately slack, not a tight bound. A measurement to anchor it: the locally built `damocles-2.26.0.vsix` is 55,685,876 bytes, from `wc -c < damocles-2.26.0.vsix`, which puts the floor at roughly 54 percent of it. VSIXes are gitignored, so that file is not in a fresh clone and you have to build one to repeat the measurement. That headroom exists because artifact size tracks dependency churn rather than anything Damocles controls, and a pi upgrade can move it in either direction. Measure the artifact you have before raising the floor, and do not set the new value close to that measurement.

## Verifying a VSIX locally

Build on the matching host OS. Cross-install is not supported here, because of both the ripgrep optional dependency and native build tooling such as Rollup.

```bash
npm ci
npm run package -- --target <target> --out /tmp/damocles-<target>.vsix
unzip -l /tmp/damocles-<target>.vsix | grep -F "extension/node_modules/@vscode/<rgPkg>/bin/<rgBin>"
unzip -l /tmp/damocles-<target>.vsix | grep -F "extension/<nativeAsset>"
```

Take `<rgPkg>` and `<rgBin>` from `RELEASE_TARGETS` in `scripts/release-targets.mjs`, and `<nativeAsset>` from the workflow matrix entry for the target. There is no `npm run build` line because `vsce package` runs `vscode:prepublish`, which syncs `.vscodeignore` and builds.

For the two Alpine targets, run the same sequence inside `docker run --rm -v $PWD:/work -w /work node:24-alpine sh -c '...'`.

### From Windows, without a matching host

`npm run package:linux-wsl` runs `scripts/package-wsl.mjs`. It copies the tracked working tree into a WSL distro and runs the same `npm ci` and `npm run package -- --target <target>` there, then applies the ripgrep path check and the `MIN_VSIX_BYTES` size check to the artifact it copies back to the repo root. It does not run the shell-cleanup asset check; that one stays in the workflow.

It exists because `@vscode/ripgrep` resolves its binary from a per-platform optional dependency, so a Windows `npm install` leaves `rg.exe` and nothing for Linux, and the Unix executable bit cannot survive an NTFS round-trip.

```bash
npm run package:linux-wsl                                        # linux-x64, default distro
npm run package:linux-wsl -- --target linux-arm64 --distro Ubuntu
npm run package:linux-wsl -- --help
```

The supported targets are `WSL_TARGETS`, the `RELEASE_TARGETS` entries that declare an `arch` and a `libc`: `linux-x64`, `linux-arm64`, `alpine-x64`, `alpine-arm64`. The default is `linux-x64`.

Files come from `git ls-files` for the path list and from the working tree for the content, so uncommitted edits are packed, and the two gitignored fetched asset directories are copied too so `fetch:assets` does not re-download them. The build happens in `$HOME/.damocles-vsix-build` inside the distro, which the script deletes once the checks pass.

The distro has to match the target. The script probes `uname -m` and the `ID` field of `/etc/os-release`, and refuses an `alpine-*` target on a glibc distro or a `*-arm64` target on an x64 distro. Neither the ripgrep check nor the size check can see a libc or architecture mismatch, because `alpine-x64` reuses the glibc ripgrep package name, so a mismatched artifact would pass both and then fail to load on the host you meant to test. Use the release workflow for targets your machine cannot build.

## Desktop installers

`package-desktop` has one leg per desktop target, each on the runner its VSIX counterpart uses, so `npm ci` installs that platform's native prebuilds (ripgrep, koffi, `@parcel/watcher`) natively. `DESKTOP_TARGETS` in `scripts/release-targets.mjs` holds each leg's runner, platform, arch, Windows channel, packaged app path and artifact names, and `scripts/__tests__/release-targets.test.ts` fails when the workflow matrix, that module or `electron-builder.yml` disagree.

| Leg | Runner | Artifacts (`<v>` is the version) |
| --- | --- | --- |
| `win-x64` | `windows-latest` | `Damocles-Setup-<v>-x64.exe`, its `.blockmap`, `latest-x64.yml` |
| `win-arm64` | `windows-11-arm` | `Damocles-Setup-<v>-arm64.exe`, its `.blockmap`, `latest-arm64.yml` |
| `mac-arm64` | `macos-latest` | `Damocles-<v>-arm64.dmg`, `Damocles-<v>-arm64.zip`, their `.blockmap`s, `latest-mac.yml` |
| `linux-x64` | `ubuntu-latest` | `damocles_<v>_amd64.deb`, `damocles-<v>.x86_64.rpm`, `latest-linux.yml` |
| `linux-arm64` | `ubuntu-24.04-arm` | `damocles_<v>_arm64.deb`, `damocles-<v>.aarch64.rpm`, `latest-linux-arm64.yml` |

Each leg runs, in order:

1. Linux only: `apt-get install rpm xvfb`. electron-builder needs `rpmbuild` for the rpm target, and the packaged-app suite runs under `xvfb-run`.
2. `npm ci`.
3. `npm run build` and `npm run build:desktop`.
4. electron-builder, always with `--publish never`. Without it electron-builder publishes by itself when it detects a CI tag build, and races the `release` job. Every call also names its targets (`nsis`, `dmg zip`, `deb rpm`), because the `arch` lists in `electron-builder.yml` would otherwise add architectures the runner cannot build.
   - Windows: **Build unpacked Windows app** runs `electron-builder --win nsis --<arch>`, and **Build Windows installer from the unpacked app** later runs `electron-builder --win nsis --<arch> --prepackaged <unpacked dir>`, which replaces the first installer and its `latest-<arch>.yml`. The checks below run on the unpacked app in between, so the released installer is built from the exact tree that passed them. Windows signing (docs/desktop-signing.md) slots in at the same point. The first step must name the `nsis` target rather than `--dir`: electron-builder writes `resources/app-update.yml`, the installed app's update feed, only after packing for an NSIS target, and `--prepackaged` skips packing.
   - macOS and Linux: **Build macOS and Linux installers** builds the installers in one step and leaves the unpacked app beside them.
   - Windows update channel: both Windows builds pass `-c.publish.channel=latest-<arch>`. Without it both arches would write `latest.yml` and one would overwrite the other in the release. The app requests the same channel (`latest-${process.arch}`). macOS and Linux keep electron-updater's default feed names, which already differ per arch.
5. **Verify desktop package integrity and fuses**: `node scripts/verify-desktop-package.mjs --platform <os> --arch <arch> --app <unpacked app>`. It checks the ripgrep binary for the platform, every grammar `.wasm`, the Python voice package with its wake models, the scripts main runs in another process or thread (`compass-worker.js`, `usage-stats-worker.js`, `quick-open-worker.js`, `sentinel.js`, `formatter-host.js`, `pty-host.js`), koffi on Windows, the `@parcel/watcher` prebuild on macOS and Linux and its absence on Windows, node-pty's prebuild for the target alone with no debug symbols or native sources (`spawn-helper` mode 0755, and `codesign -v` on each native binary on macOS), the bash, zsh and fish shell integration scripts with LF line endings, the packed `dist/desktop/CHANGELOG.md`, which must equal the repo's and hold the version's `## [x.y.z] - ` section, and the license notices (`LICENSE` and `THIRD-PARTY-NOTICES.md` in `app.asar`, Monaco's `ThirdPartyNotices.txt` in the resources directory), then reads the Electron fuses back from the built binary with `@electron/fuses` and fails unless they match docs/invariants.md exactly: `runAsNode` on, `enableCookieEncryption` on, `enableEmbeddedAsarIntegrityValidation` on, `onlyLoadAppFromAsar` on, `enableNodeOptionsEnvironmentVariable` off, `enableNodeCliInspectArguments` off, `grantFileProtocolExtraPrivileges` off.
6. **End-to-end suite against the packaged app**: `npm run test:desktop:packaged` with `DAMOCLES_E2E_PACKAGED_APP` set to the packaged executable. The test harness reads that variable; the app never does. Linux makes the packaged app's `chrome-sandbox` root-owned and setuid first, for the reason in "Desktop end-to-end suite".
   On Windows, **Verify the tested Windows app is still clean** then runs the integrity check again, because the installer step packs the directory the suite just ran from, and the check fails on runtime leftovers such as `__pycache__` in the Python package.
7. **Verify this leg's release artifacts**: `node scripts/release-targets.mjs --check-desktop-artifacts <target> dist-desktop` fails when an artifact in `DESKTOP_TARGETS` is missing or electron-builder wrote one under a name the module does not list.
8. The `win-arm64`, `mac-arm64` and `linux-x64` legs build version N+1 for the update test (see "Update tests") into `dist-desktop/next`.
9. Upload `desktop-<target>`: only installers, blockmaps and `latest*.yml`. The unpacked app, `builder-debug.yml` and `builder-effective-config.yaml` never leave the runner. On failure the packaged-app suite's Playwright report uploads as `e2e-report-<target>`, from `dist/e2e-report/packaged` and `dist/e2e-results/packaged`.

## Desktop end-to-end suite

`e2e-desktop` runs the dev suite, `npm run test:desktop`, on the five desktop targets and the runners their `package-desktop` legs use. It needs only `verify`, so it runs beside `package-desktop` instead of before its packaging, and `attest` and `release` need it, so a failing test still blocks publishing. Playwright's `--shard=<n>/<total>` splits each target's tests across runners: three shards on Windows and macOS, two on Linux, 13 jobs in all. The matrix is `fail-fast: false`, so every shard reports all its failures. `scripts/__tests__/release-targets.test.ts` fails when the job's targets, runners or shard counts drift from `DESKTOP_TARGETS` or `package-desktop` runs the dev suite again.

Each shard runs, in order:

1. Linux only: `apt-get install xvfb openbox`.
2. `npm ci`, then **Download the Electron binary**: `npx --no install-electron`. The `electron` package has no install script and downloads its binary the first time something requires it, so without this step the setuid step below finds no `node_modules/electron/dist`, and two Playwright workers race to download the binary. The step is idempotent. The `verify`, `package` and `package-desktop` jobs never download the binary.
3. Linux only: Ubuntu 24.04 restricts unprivileged user namespaces for binaries without an AppArmor profile, so the step makes `node_modules/electron/dist/chrome-sandbox` root-owned and setuid, which lets Chromium use its setuid sandbox helper. The sandbox stays on: nothing in CI passes `--no-sandbox` or relaxes the kernel setting.
4. **Desktop end-to-end suite**: `npm run test:desktop -- --shard=<n>/<total>`. The script fetches the assets and builds the webview and the desktop app (main, preloads, workers and sentinel) itself, so the job has no separate build step; the suite never loads the extension bundle. On Linux it runs under `xvfb-run` on a 1920x1080 screen with the openbox window manager, because minimizing a window needs a window manager and the pane specs size the window to 1400x900. On Linux and macOS the suite runs one worker, here and in the packaged-app suite (`workers` in `playwright.desktop.config.ts`). On both, a session gives keyboard focus to one window of one app, and each test's app takes it when its window opens, so a parallel worker would take it from a test that is pressing keys: native key presses reach the menu only in the key window, and `toBeFocused` needs `document.hasFocus()`. On macOS the suite's `pressKeys` posts each key, modifiers included, to the app's process through the window server with `CGEventPostToPid` through koffi (`e2e/desktop/support/mac-key-event.ts`), so it takes the path a physical key takes. An event from `webContents.sendInputEvent` has no `NSEvent`, and Electron's macOS path hands only an `NSEvent` to the application menu, so such a key never reaches a menu accelerator or an Edit menu role. An `NSEvent` posted with `-[NSApplication postEvent:atStart:]` skips the window server, and with a non-editable element focused a menu key equivalent with Shift held never fires from it. On Windows the suite's global setup first builds Windows PowerShell 5.1's module analysis cache, and every test's hermetic home starts with a copy (`WINDOWS_POWERSHELL_CACHE` in `e2e/desktop/support/hermetic.ts`): without it, a Windows PowerShell terminal's first cmdlet analyses every module on the runner's module path first, which takes longer than a test waits.
5. On failure the shard's Playwright report uploads as `e2e-report-<target>-<n>`, from `dist/e2e-report/dev` and `dist/e2e-results/dev`.

## Install verification

`verify-desktop-install` downloads installers from `package-desktop` onto fresh runners with no checkout and installs them as a user would. Each leg checks for a real OS window rather than driving the app, so it needs no `npm ci` and opens no debugging port.

| Leg | Runner | What it checks |
| --- | --- | --- |
| `deb` | `ubuntu-24.04` | `apt-get install` of the x64 deb; `resources/app-update.yml` names the GitHub feed and `resources/package-type` says `deb`, which is how electron-updater picks its installer; when AppArmor is active, the `damocles` profile is loaded; the app launches under `xvfb-run` with a hermetic `HOME` and shows a window (`xwininfo`); no Damocles process has `--no-sandbox` in its arguments; a renderer exists, runs under seccomp-bpf (`Seccomp: 2`) and in its own pid namespace, which only a sandboxed renderer does; when AppArmor is active it is also in its own user namespace, which proves the profile enabled Chromium's user namespace sandbox rather than the setuid fallback; the log has no sandbox failure. |
| `rpm` | `ubuntu-24.04`, in a `fedora:latest` container (the current Fedora release) | the rpm's scripts mention AppArmor; `dnf install` succeeds on Fedora, which has no AppArmor, so the scripts do not fail the install without it; the executable, `app.asar`, `app.asar.unpacked`, an `app-update.yml` naming the GitHub feed, a `package-type` of `rpm` and the AppArmor profile are installed; `dnf remove` leaves no `/opt/Damocles`. |
| `dmg` | `macos-latest` | mounts the dmg, copies `Damocles.app` to `/Applications`, verifies its ad hoc signature with `codesign` and that `Contents/Resources/app-update.yml` names the GitHub feed, launches it with `open`, and waits for a Damocles window through `CGWindowListCopyWindowInfo`, which reports window owners without accessibility or screen recording permission. |
| `nsis` | `windows-latest` | the x64 installer with `/S` installs per user (its uninstall entry is under HKCU and its install location under `%LOCALAPPDATA%`); `resources\app-update.yml` names the GitHub feed on channel `latest-x64`; `Damocles.exe` shows a main window; the silent uninstaller removes the app and leaves a marker file in `~/.damocles` in place. |

## Update tests

`desktop-update-test` checks the update path end to end with the driver `e2e/desktop/update/drive-update.mjs`:

- The job installs only the driver's own dependencies: `e2e/desktop/update/package.json` lists `playwright-core` alone, pinned in its lockfile. The repository's full `npm ci` takes 11 to 17 minutes on `windows-11-arm`.
- The N+1 build is the same tree as the release build, with the version overridden: `electron-builder ... --publish never -c.extraMetadata.version=<N+1> -c.directories.output=dist-desktop/next`, where N+1 is the package.json version without its prerelease part and with the patch number raised by one. Windows also passes its channel. It uploads as `update-feed-<target>` and is never attached to the release.
- The driver installs N, serves the N+1 directory on `127.0.0.1` only, and rewrites the installed test app's `resources/app-update.yml` to point at that feed. The production app reads no environment variable or flag for its feed, so only a test that can already write into the install directory can redirect it.
- `win-arm64` (`windows-11-arm`): N installs per user, downloads N+1 in the background, restarts through the "Restart Now" prompt, and the driver checks that the installed version is N+1 and that the app relaunched. The installer starts the relaunched app through its shortcut, outside the test's profile, so the driver looks for a new browser process of the install.
- `linux-x64` (`ubuntu-24.04`, under `xvfb-run -a`): the same flow with the deb. `app.relaunch()` keeps the app's arguments, so the driver finds the relaunched N+1's start line in the same log. `--grant-pkexec` adds a polkit rule so electron-updater's `pkexec` elevation needs no password, and removes it afterwards. The rule covers only `/bin/bash` for the runner user, and the driver refuses the flag unless `GITHUB_ACTIONS=true`.
- The driver refuses to run where Damocles is already installed (an HKCU uninstall entry on Windows, an installed `damocles` package on Linux). Each leg is a fresh runner, so this holds in CI; on your own machine, run it only where no Damocles is installed. When it finishes, pass or fail, it uninstalls what it installed: the silent per-user uninstaller on Windows, `apt-get remove damocles` on Linux. The macOS copy lives in the work directory and is never installed.
- `mac-arm64` (`macos-latest`): the app shows the new-version notice, its action opens `https://github.com/AizenvoltPrime/damocles/releases/tag/v<N+1>`, and the driver checks the log line that records the URL.

Windows x64 is not in CI: its N to N+1 update is the manual check in "Tagging a release".

## Provenance and checksums

Windows installers are not code signed yet, macOS builds are signed ad hoc and Linux packages are unsigned, and the `sha512` in each `latest*.yml` protects only the auto-update path. Two things let a user check a manual download:

- **Attestations.** The `attest` job runs `actions/attest-build-provenance` over the same `dist-artifacts/` globs that "Create GitHub Release" attaches, and `release-targets.test.ts` fails when the two lists differ. It is its own job because `id-token: write` lets any step in the job mint the OIDC token that signs attestations: `attest` downloads the artifacts and runs that one action, with no secret, no checkout and no package install. The build jobs run dependency install scripts and the `release` job runs vsce and ovsx, so neither gets the permission.
- **`SHA256SUMS`.** "Create GitHub Release" writes the SHA-256 of every attached file, by bare file name, and attaches `SHA256SUMS` too.

To verify a download, in the folder it was saved to:

```bash
sha256sum -c SHA256SUMS --ignore-missing
gh attestation verify <file> --repo AizenvoltPrime/damocles
```

`SHA256SUMS` itself carries no attestation: the attestation of each file is the provenance check, and the sums are the integrity check for users without the `gh` CLI. The release notes and the README repeat both commands.

## Marketplace publishing, `VSCE_PAT`

The publish step reads the secret into `env.VSCE_PAT` and is gated by `if: env.VSCE_PAT != ''`. When the secret is unset, VSIXes still attach to the GitHub Release and only the Marketplace push is skipped.

To enable Marketplace publishing:

1. Sign in to [Azure DevOps](https://dev.azure.com/) with the account tied to the `Aizenvolt` Marketplace publisher, or as an organization member who has access.
2. Open User Settings > Personal Access Tokens > New Token.
3. Configure the token:
   - Organization: All accessible organizations.
   - Expiration: 12 months or less. Set a calendar reminder to rotate before expiry.
   - Scopes: Custom defined > Marketplace > Manage. Do not grant `Code`, `Packaging`, or any other scope.
4. Copy the generated token value. It is shown only once.
5. In the GitHub repo, go to Settings > Secrets and variables > Actions > New repository secret and save it as `VSCE_PAT`.

## Open VSX publishing, `OVSX_PAT`

Open VSX is the open-source registry used by editors that cannot legally ship the proprietary Microsoft Marketplace integration, among them VSCodium, Cursor, Windsurf, Gitpod, and Eclipse Theia. Publishing to both registries keeps Damocles installable on all of them.

The publish step reads the secret into `env.OVSX_PAT` and is gated by `if: env.OVSX_PAT != ''`. When the secret is unset, the Open VSX push is skipped and the other steps run unchanged.

To enable Open VSX publishing:

1. Create or sign in to an account at [open-vsx.org](https://open-vsx.org/) using the same GitHub identity that owns the extension's source repository.
2. The first time you publish, create a matching namespace, `Aizenvolt`, following the [publishing docs](https://github.com/eclipse/openvsx/wiki/Publishing-Extensions#how-to-publish-an-extension). Namespace creation and claiming are one-time steps.
3. Open User Settings (avatar) > Tokens > Generate New Token. Give it a descriptive name such as `damocles-ci` and an expiry.
4. Copy the generated token value. It is shown only once.
5. In the GitHub repo, go to Settings > Secrets and variables > Actions > New repository secret and save it as `OVSX_PAT`.

`ovsx` reads the same `--target <platform>` field that `vsce` embeds in the VSIX manifest, so per-platform VSIXes produced by the matrix upload correctly without additional flags.

## Tagging a release

1. Bump `package.json` `version` to match the intended tag. The `verify` job's "Verify package.json version matches tag" step fails the run when they disagree.
2. Add a `## [x.y.z] - YYYY-MM-DD` section to `CHANGELOG.md`. The `release` job's "Extract changelog section" step scans `CHANGELOG.md` for a line starting with `## ` that contains `[x.y.z]`, and takes every line after it up to the next `## ` heading as the GitHub Release body. A missing or empty section fails the job, so the entry has to exist before the tag is pushed.
3. Commit the version bump and the changelog section together with the work they describe, using a conventional-commit subject that names the change. The workflow reads nothing from the commit; `gh release create` titles the Release with the tag name.
4. Tag and push:

   ```bash
   git tag vx.y.z
   git push origin vx.y.z
   ```

5. Watch the workflow in Actions. On success, check the [VS Marketplace listing](https://marketplace.visualstudio.com/items?itemName=Aizenvolt.damocles) and the [Open VSX listing](https://open-vsx.org/extension/Aizenvolt/damocles) serve per-platform VSIXes, and install at least one on Windows, macOS, and Linux to confirm activation.
6. Check the GitHub Release lists the seven VSIXes, the five legs' installers, their blockmaps, five feed files (`latest-x64.yml`, `latest-arm64.yml`, `latest-mac.yml`, `latest-linux.yml`, `latest-linux-arm64.yml`) and `SHA256SUMS`, and that its notes end with the "Desktop app" caveats the "Extract changelog section" step appends. Spot-check one download as described in "Provenance and checksums".
7. Windows x64 update, by hand, because CI covers only arm64: with the previous release installed, start it, wait for the "Restart Now" prompt, restart, and check Settings > Apps shows the new version.

### Dry run on a prerelease tag

The `release` job creates a real GitHub Release and publishes to both registries, so do the first desktop run in a fork, where neither publish secret exists:

1. Fork `AizenvoltPrime/damocles` on GitHub and enable Actions in the fork (Actions tab > "I understand my workflows, go ahead and enable them"). The fork must be public, because the `windows-11-arm` and `ubuntu-24.04-arm` runners are free only for public repositories.
2. Do not add `VSCE_PAT` or `OVSX_PAT` to the fork; without them both publish steps are skipped. "Create GitHub Release" needs no secret, because it uses the job's own `GITHUB_TOKEN`, so the dry run creates a release in the fork.
3. On a branch in the fork, set `package.json` `version` to a prerelease such as `2.37.0-rc.1`, add a `## [2.37.0-rc.1] - YYYY-MM-DD` section to `CHANGELOG.md`, commit, and push:

   ```bash
   git remote add fork https://github.com/<you>/damocles.git
   git push fork HEAD:dry-run
   git tag v2.37.0-rc.1
   git push fork v2.37.0-rc.1
   ```

4. Every job must pass. The fork gets a release whose assets you can check against step 6 above, with attestations under the fork's name (`gh attestation verify <file> --repo <you>/damocles`).
5. Delete the local tag afterwards (`git tag -d v2.37.0-rc.1`) so it is never pushed to `origin`, and delete the fork's release.

## Publish failure recovery

Each publish step loops over `dist-artifacts/*.vsix` and calls a `publish_with_retry` shell function. That function retries a failing VSIX up to four times, sleeping 15, 30, and 45 seconds between attempts, and captures the command output to a log. If the log matches `already exists` or `already published` (`conflict` too, on Open VSX), the function prints "Skipping <vsix> - already published" and returns success, so a partial re-run does not fail on targets that already landed. After four failed attempts the function returns 1 and the step fails.

If one target publishes and a later one fails:

- The GitHub Release already has all VSIXes attached. There is nothing to re-upload there.
- Re-running the whole workflow re-runs `verify` and the full `package` matrix, and then fails at "Create GitHub Release", because `gh release create` does not overwrite a Release that already exists for the tag.
- The direct route is to fix the underlying cause, download the artifacts from the Release, and publish the missing targets from a local shell:

  ```bash
  npm ci --ignore-scripts
  node_modules/.bin/vsce publish --packagePath damocles-<target>-<version>.vsix --pat "$VSCE_PAT"
  node_modules/.bin/ovsx publish damocles-<target>-<version>.vsix -p "$OVSX_PAT"
  ```
