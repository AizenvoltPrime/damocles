/**
 * The packaging-relevant columns of the release matrix.
 *
 * `.github/workflows/release.yml` must keep its own static `strategy.matrix` — the runner image and
 * the Alpine-container switch are resolved by Actions before any JS could run — so it cannot import
 * this. `scripts/__tests__/release-targets.test.ts` parses that workflow and fails when the two
 * drift, which is the only thing standing between a renamed ripgrep package and a silently broken
 * release artifact.
 *
 * `arch`/`libc` are NOT in the workflow: there they are implied by the runner image and the
 * `node:24-alpine` container. A local build picks its own machine, so they have to be stated to be
 * checkable.
 */

export const MIN_VSIX_BYTES = 30_000_000;

export const RELEASE_TARGETS = {
  'win32-x64': { rgPkg: 'ripgrep-win32-x64', rgBin: 'rg.exe' },
  'win32-arm64': { rgPkg: 'ripgrep-win32-arm64', rgBin: 'rg.exe' },
  'darwin-arm64': { rgPkg: 'ripgrep-darwin-arm64', rgBin: 'rg' },
  'linux-x64': { rgPkg: 'ripgrep-linux-x64', rgBin: 'rg', arch: 'x86_64', libc: 'glibc' },
  'linux-arm64': { rgPkg: 'ripgrep-linux-arm64', rgBin: 'rg', arch: 'aarch64', libc: 'glibc' },
  'alpine-x64': { rgPkg: 'ripgrep-linux-x64', rgBin: 'rg', arch: 'x86_64', libc: 'musl' },
  'alpine-arm64': { rgPkg: 'ripgrep-linux-arm64', rgBin: 'rg', arch: 'aarch64', libc: 'musl' },
};

/** Targets a WSL distro can produce — the ones whose `arch`/`libc` a local build can be checked against. */
export const WSL_TARGETS = Object.keys(RELEASE_TARGETS).filter((t) => RELEASE_TARGETS[t].libc);
