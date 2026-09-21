# Releasing Damocles

This document describes how tagged releases turn into per-platform VSIXes and how they reach the Visual Studio Marketplace and the Open VSX Registry.

## Overview

`.github/workflows/release.yml` runs when a tag matching `v*` is pushed. It has three jobs.

1. **`verify`** runs once on `ubuntu-latest` under Node 24. After `npm ci` it checks the `package.json` version against the tag, then runs `npm run typecheck`, `npm test`, `npm run smoke:pi`, and `node scripts/sync-vscodeignore.mjs --check`. All five gates must pass before any packaging starts.
2. **`package`** builds one `.vsix` per VS Code target platform. There are seven targets: `win32-x64`, `win32-arm64`, `darwin-arm64`, `linux-x64`, `linux-arm64`, `alpine-x64`, `alpine-arm64`. There is no `darwin-x64` target, so an Intel Mac gets no artifact from the matrix. The matrix is `fail-fast: true`, so the first failing leg cancels the others. Each leg runs two integrity checks against the VSIX it produced, then uploads it as the artifact `vsix-<target>` with a 7 day retention and `if-no-files-found: error`.
3. **`release`** downloads every artifact into `dist-artifacts/`, creates one GitHub Release with all VSIXes attached, and publishes each VSIX to the Visual Studio Marketplace (gated on `VSCE_PAT`) and to the Open VSX Registry (gated on `OVSX_PAT`).

Each publish step is gated independently. When one secret is unset, that step is skipped without failing the run, and the GitHub Release still carries every VSIX.

Per-platform VSIXes are required because `@vscode/ripgrep` resolves its binary from a per-platform optional dependency (`@vscode/ripgrep-win32-x64`, `@vscode/ripgrep-linux-arm64`, and so on). `npm ci` installs only the one matching the build machine, so a single universal VSIX would carry only the publisher's host binary and would ship no working ripgrep for any other platform. Damocles calls ripgrep for `@` file autocomplete.

## The verify job

The five gates, in workflow order, with the step name the Actions log shows:

| Step name | What it runs |
| --- | --- |
| Verify package.json version matches tag | compares `node -p "require('./package.json').version"` against `${GITHUB_REF_NAME#v}` and exits 1 when they differ |
| Typecheck | `npm run typecheck` |
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

Packaging is plain `npx @vscode/vsce package --target <target> --out "$VSIX_NAME"`, with no `--no-dependencies`. `VSIX_NAME` is `damocles-<target>-<tag>.vsix`. There is no separate `npm run build` step, because `vscode:prepublish` runs `node scripts/sync-vscodeignore.mjs && npm run build` for every `vsce package` invocation.

## How `.vscodeignore` is built

`.vscodeignore` excludes `node_modules/**` and then re-includes an allowlist that `scripts/sync-vscodeignore.mjs` generates between two marker comments. The script derives the allowlist from `EXTENSION_EXTERNALS` in `scripts/extension-externals.mjs`, dropping `vscode` and any `node:` builtin, and walks each remaining package's installed production dependency closure. Packages that declare `os` or `cpu` collapse to a platform-family glob, so `@vscode/ripgrep-win32-x64` becomes `!node_modules/@vscode/ripgrep-*/**` and the generated block stays platform-neutral. Large pure-runtime packages are narrowed further to per-extension globs, and the script throws when a narrowed package contains a file extension that is in neither its keep set nor its reviewed-dead set.

Two consequences for the pipeline:

- The `verify` job runs `node scripts/sync-vscodeignore.mjs --check`, which exits 1 when the committed block differs from what the script would generate. That catches a hand-edited or forgotten `.vscodeignore`. It runs on one platform so it fails fast, before the matrix starts.
- Every matrix leg regenerates the block in place through `vscode:prepublish`, because each build machine installs a different set of optional native packages. Packaging therefore never fails on benign cross-OS closure differences, and the committed file only has to be correct for the platform it was generated on.

SQLite uses Node's built-in `node:sqlite`, so no WASM or native SQLite module is bundled.

## Per-VSIX verification

Every matrix leg runs two integrity steps against the VSIX it just produced. Both names in bold below appear verbatim in `.github/workflows/release.yml` and in the Actions log, so grep for one to find the step.

**Verify VSIX bundles the ripgrep binary** writes `unzip -l "$VSIX_NAME"` to a temp file and fixed-string greps it for the target's ripgrep binary, then applies the size floor:

```bash
rg_expected="extension/node_modules/@vscode/${{ matrix.rgPkg }}/bin/${{ matrix.rgBin }}"
grep -qF "$rg_expected" "$listing" || fail
size=$(wc -c < "$VSIX_NAME")
[ "$size" -ge 30000000 ] || fail
```

**Verify VSIX bundles this target's shell-cleanup asset** greps the same listing for `extension/${{ matrix.nativeAsset }}`. On `win32-x64` and `win32-arm64` that is the koffi native module Damocles uses for job objects, without which a stopped command's background jobs survive. On the other five targets it is `dist/sentinel.js`, without which a closed panel leaves process groups running. Both failure messages print the full VSIX listing before exiting 1.

The ripgrep check proves the target-specific binary is present at the path the runtime resolves. The asset check proves the build produced this target's shell-cleanup asset rather than another target's, which the ripgrep check cannot see because `alpine-x64` and `linux-x64` share a `rgPkg`.

### The size floor

The floor is `30000000` bytes, written as a literal in the "Verify VSIX bundles the ripgrep binary" step and as `MIN_VSIX_BYTES = 30_000_000` in `scripts/release-targets.mjs`. `scripts/__tests__/release-targets.test.ts` extracts the literal from the workflow and asserts it equals `MIN_VSIX_BYTES`, so the two cannot drift.

What the floor catches is one failure class: a VSIX that `vsce` produced with no `node_modules/` at all, from a stray `--no-dependencies` flag or a `.vscodeignore` whose allowlist stopped matching. Such an artifact is a few MB and every content check on it would also fail, but the size check reports it in one number instead of one missing path.

The floor is deliberately slack, not a tight bound. A measurement to anchor it: the locally built `damocles-2.26.0.vsix` is 55,685,876 bytes, from `wc -c < damocles-2.26.0.vsix`, which puts the floor at roughly 54 percent of it. VSIXes are gitignored, so that file is not in a fresh clone and you have to build one to repeat the measurement. That headroom exists because artifact size tracks dependency churn rather than anything Damocles controls, and a pi upgrade can move it in either direction. Measure the artifact you have before raising the floor, and do not set the new value close to that measurement.

## Verifying a VSIX locally

Build on the matching host OS. Cross-install is not supported here, because of both the ripgrep optional dependency and native build tooling such as Rollup.

```bash
npm ci
npx @vscode/vsce package --target <target> --out /tmp/damocles-<target>.vsix
unzip -l /tmp/damocles-<target>.vsix | grep -F "extension/node_modules/@vscode/<rgPkg>/bin/<rgBin>"
unzip -l /tmp/damocles-<target>.vsix | grep -F "extension/<nativeAsset>"
```

Take `<rgPkg>` and `<rgBin>` from `RELEASE_TARGETS` in `scripts/release-targets.mjs`, and `<nativeAsset>` from the workflow matrix entry for the target. There is no `npm run build` line because `vsce package` runs `vscode:prepublish`, which syncs `.vscodeignore` and builds.

For the two Alpine targets, run the same sequence inside `docker run --rm -v $PWD:/work -w /work node:24-alpine sh -c '...'`.

### From Windows, without a matching host

`npm run package:linux-wsl` runs `scripts/package-wsl.mjs`. It copies the tracked working tree into a WSL distro and runs the same `npm ci` and `npx --yes @vscode/vsce package --target <target>` there, then applies the ripgrep path check and the `MIN_VSIX_BYTES` size check to the artifact it copies back to the repo root. It does not run the shell-cleanup asset check; that one stays in the workflow.

It exists because `@vscode/ripgrep` resolves its binary from a per-platform optional dependency, so a Windows `npm install` leaves `rg.exe` and nothing for Linux, and the Unix executable bit cannot survive an NTFS round-trip.

```bash
npm run package:linux-wsl                                        # linux-x64, default distro
npm run package:linux-wsl -- --target linux-arm64 --distro Ubuntu
npm run package:linux-wsl -- --help
```

The supported targets are `WSL_TARGETS`, the `RELEASE_TARGETS` entries that declare an `arch` and a `libc`: `linux-x64`, `linux-arm64`, `alpine-x64`, `alpine-arm64`. The default is `linux-x64`.

Files come from `git ls-files` for the path list and from the working tree for the content, so uncommitted edits are packed, and the two gitignored fetched asset directories are copied too so `fetch:assets` does not re-download them. The build happens in `$HOME/.damocles-vsix-build` inside the distro, which the script deletes once the checks pass.

The distro has to match the target. The script probes `uname -m` and the `ID` field of `/etc/os-release`, and refuses an `alpine-*` target on a glibc distro or a `*-arm64` target on an x64 distro. Neither the ripgrep check nor the size check can see a libc or architecture mismatch, because `alpine-x64` reuses the glibc ripgrep package name, so a mismatched artifact would pass both and then fail to load on the host you meant to test. Use the release workflow for targets your machine cannot build.

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

## Publish failure recovery

Each publish step loops over `dist-artifacts/*.vsix` and calls a `publish_with_retry` shell function. That function retries a failing VSIX up to four times, sleeping 15, 30, and 45 seconds between attempts, and captures the command output to a log. If the log matches `already exists` or `already published` (`conflict` too, on Open VSX), the function prints "Skipping <vsix> - already published" and returns success, so a partial re-run does not fail on targets that already landed. After four failed attempts the function returns 1 and the step fails.

If one target publishes and a later one fails:

- The GitHub Release already has all VSIXes attached. There is nothing to re-upload there.
- Re-running the whole workflow re-runs `verify` and the full `package` matrix, and then fails at "Create GitHub Release", because `gh release create` does not overwrite a Release that already exists for the tag.
- The direct route is to fix the underlying cause, download the artifacts from the Release, and publish the missing targets from a local shell:

  ```bash
  npx @vscode/vsce publish --packagePath damocles-<target>-<version>.vsix --pat "$VSCE_PAT"
  npx ovsx publish damocles-<target>-<version>.vsix -p "$OVSX_PAT"
  ```
