# Desktop code signing

This document is the procedure for signing the desktop app. It covers Windows signing, which has not happened yet, the obligations that come with it, and how an Apple Developer ID would be added for macOS later.

## Where things stand

| Platform | Today | Consequence for users |
| --- | --- | --- |
| Windows x64 and arm64 | Unsigned NSIS installers and app binaries | SmartScreen warns on the first run of the installer ("More info", then "Run anyway"). Auto update works; electron-updater skips the publisher check because no `publisherName` is configured. |
| macOS arm64 | Ad hoc signed (`mac.identity: "-"`), hardened runtime off, not notarized | Gatekeeper blocks each new version until the user chooses Open Anyway under System Settings > Privacy & Security. The app does not update itself; it shows a notice that opens the release page. Voice is hidden. |
| Linux x64 and arm64 | Unsigned `.deb` and `.rpm` release assets | None. Release assets downloaded from GitHub need no package signature; the packages are not served from an apt or dnf repository. |

## Windows: SignPath Foundation

SignPath Foundation signs open source projects for free with an HSM backed certificate. It signs only artifacts that a GitHub workflow submits through SignPath's GitHub integration, and a person approves each signing request in SignPath's web UI. Its application requires an artifact that is already released, which is why the first desktop release ships unsigned.

The trade off: SignPath Foundation, not the maintainer, is the publisher Windows shows. If the application is rejected, Windows keeps shipping unsigned. Auto update is unaffected by that outcome; only the SmartScreen warning stays.

### Before applying

1. Turn on two-factor authentication for the GitHub account that owns the repository (GitHub > Settings > Password and authentication).
2. Publish the first desktop release, unsigned, from a `v*` tag, so the application can point at a released artifact.
3. Put the "Code signing policy" section of the README in its final form, using the policy text and privacy statement below, and keep the release notes linking to it. SignPath checks that these are public before it approves.
4. Confirm the privacy statement is still true (see "Privacy statement" below): the app must make no automatic network connection other than the ones it names. Check pi's install telemetry and version check in particular: pi reads `PI_TELEMETRY` and `PI_SKIP_VERSION_CHECK`, and the desktop end-to-end harness turns both off, so confirm that the pi session path Damocles uses never runs either one, or turn them off in the app and say so in the statement.

### Applying

Apply to the SignPath Foundation open source program at https://signpath.org with:

- the repository URL, https://github.com/AizenvoltPrime/damocles, and its MIT license;
- the URL of the first desktop release and its Windows installers;
- the project description from the README;
- the roles (below);
- the browser feature disclosure (below).

Ask in the application whether every PE file in the app may be signed, including third party ones that ship inside it (Electron's own DLLs, `rg.exe` from `@vscode/ripgrep`, the koffi and `@parcel/watcher` `.node` modules, electron-builder's `elevate.exe`). The job structure below assumes yes; if SignPath limits signing to files built from this repository, narrow the artifact configuration to those files and record the decision here.

### After approval

1. Turn on two-factor authentication in SignPath.
2. Install the SignPath GitHub App on the `AizenvoltPrime/damocles` repository.
3. In SignPath, create two artifact configurations, one for the unpacked apps and one for the installers (sketches below), and a signing policy that requires manual approval.
4. Create an API token for a CI submitter user in SignPath.
5. Store these as GitHub Actions secrets (repository Settings > Secrets and variables > Actions): `SIGNPATH_API_TOKEN`, `SIGNPATH_ORGANIZATION_ID`, `SIGNPATH_PROJECT_SLUG`, `SIGNPATH_SIGNING_POLICY_SLUG`. The two artifact configuration slugs are not secret and can live in the workflow.
6. Read the subject of the issued certificate and set `win.signtoolOptions.publisherName` in `electron-builder.yml` to its common name exactly (see "Obligations").

### Why the Windows release path has to change

- SignPath signs only artifacts a workflow uploads and submits through its action, `signpath/github-action-submit-signing-request`, and every request waits for a person to approve it.
- An NSIS installer's inner files cannot be signed after it is packed. The app binaries have to be signed before the installer is built.
- Signing a file after electron-builder has hashed it breaks every Windows update, because `latest-<arch>.yml` still carries the pre signing `sha512` and `size` (electron-builder issue 9538), and electron-updater rejects the download.

The release workflow already builds each Windows architecture as its own leg of the `package-desktop` job with its own update channel (`-c.publish.channel=latest-x64` or `latest-arm64`), and every electron-builder call passes `--publish never`. Each Windows leg builds the app, runs the integrity and fuse checks on the unpacked app, and builds the installer (see docs/release.md, "Desktop installers"). Signing moves the installer build out of the leg into a new `sign-windows` job, after the unpacked apps are signed. No other job changes shape.

One electron-builder behavior shapes every step below: it writes `resources/app-update.yml`, the app's update feed, only in the after-pack step of a build that has an `nsis` target (app-builder-lib `PublishManager`, `onAfterPack`). A `--dir` build and a `--prepackaged` build never write it. An app without that file has no update feed and can never update itself.

### The signing job structure

1. **Each Windows leg of `package-desktop`** keeps its build, test and check steps up to and including the checks on the unpacked app. It builds the `nsis` target, not `--dir`, so the after-pack step writes `resources/app-update.yml` (GitHub provider, `channel: latest-<arch>` and the `publisherName` from `win.signtoolOptions`) into the unpacked app:

   ```bash
   npx electron-builder --win nsis --x64 --publish never -c.publish.channel=latest-x64
   ```

   It uploads `dist-desktop/win-unpacked` (x64) or `dist-desktop/win-arm64-unpacked` (arm64) as an artifact; the unsigned installer this build also writes is discarded. The fuses are flipped and the asar integrity hash is embedded during this step, before anything is signed. The packaged end-to-end run and the artifact check move to `sign-windows`, after the signed installer exists.

2. **A `sign-windows` job** on `windows-latest`, `needs: package-desktop`, downloads both unpacked apps into `x64/` and `arm64/`, uploads them as one artifact with `actions/upload-artifact`, and submits one signing request for it with the "unpacked apps" artifact configuration. That configuration signs every PE file inside: `Damocles.exe`, every `.dll`, every `.node` module, `rg.exe` and `elevate.exe`. One approval. The action downloads the signed zip into an output directory.

3. **The same job builds both NSIS installers from the signed directories** with signing disabled in electron-builder (no `CSC_LINK` or `WIN_CSC_LINK` in the environment) and `win.signAndEditExecutable` off, so electron-builder neither edits nor re-signs the signed binaries:

   ```bash
   npx electron-builder --win nsis --x64 --prepackaged signed/x64 --publish never -c.publish.channel=latest-x64 -c.win.signAndEditExecutable=false
   npx electron-builder --win nsis --arm64 --prepackaged signed/arm64 --publish never -c.publish.channel=latest-arm64 -c.win.signAndEditExecutable=false
   ```

   `--prepackaged` does not write `app-update.yml`; the signed directory keeps the one step 1 wrote, because it is not a PE file and signing leaves it unchanged. Run `scripts/verify-desktop-package.mjs` again on each signed directory to prove signing left the fuse wire and the tree untouched, and the release artifact check (`node scripts/release-targets.mjs --check-desktop-artifacts win-<arch> <dir>`) on the installers.

4. **It submits both installers as one artifact** (`Damocles-Setup-<version>-x64.exe` and `Damocles-Setup-<version>-arm64.exe`) in a second signing request with the "installers" artifact configuration. One approval.

5. **It rewrites the update metadata from the signed installers.** For each architecture it regenerates `Damocles-Setup-<version>-<arch>.exe.blockmap` from the signed installer and writes the signed file's `sha512` (base64) and `size` into `latest-<arch>.yml`, both in the `files` entry and in the top level `sha512`. electron-builder 26.15.7 builds blockmaps in JavaScript: `buildBlockMap(file, "gzip", file + ".blockmap")` from `app-builder-lib/out/targets/blockmap/blockmap.js` writes the blockmap and returns the `sha512` and `size` of the file. That is an internal module, so pin electron-builder and re-check the path when it is bumped.

6. **A check compares every yml entry against the final file before the release job can run.** For every `latest-<arch>.yml` it recomputes `sha512` and `size` of each file the yml names and fails on any difference, and it fails if a blockmap is older than its installer. It also reads each signed directory's `resources/app-update.yml` and fails unless it has `provider: github`, `owner: AizenvoltPrime`, `repo: damocles`, `channel: latest-<arch>` and the expected `publisherName`, since an installer built from a directory without it would never update. It runs as the last step of `sign-windows`, and `release` needs `sign-windows`.

7. **The release job attaches the signed installers, the regenerated blockmaps and the rewritten `latest-x64.yml` and `latest-arm64.yml`** from `sign-windows`, never unsigned ones, and the `attest` job attests those same signed files, so it gains `needs: sign-windows` too. The `nsis` leg of `verify-desktop-install` and the `win-arm64` leg of `desktop-update-test` install the signed installer too, so they gain `needs: sign-windows`. The N+1 installer the update test serves stays unsigned, because it is never released. `scripts/desktop-update-override.mjs` writes no `publisherName` into the test install's `app-update.yml`, so that test skips the publisher check; the signed N+1 to N+2 update in "Verifying a signed release" is what covers it.

The signing wait: the action waits 600 seconds by default, and a human approval often takes longer. Set `wait-for-completion-timeout-in-seconds` well above that (for example 3600) on both requests, and the job's `timeout-minutes` above the sum of both waits plus the build.

The NSIS uninstaller stays unsigned. NSIS generates it inside the installer at install time, and a file created locally carries no download mark for SmartScreen to check.

Artifact configuration sketches (validate them in SignPath's artifact configuration editor, which has the authoritative schema):

```xml
<!-- unpacked apps: both architectures in one zip, every PE file signed -->
<artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
  <zip-file>
    <pe-file-set>
      <include path="x64/Damocles.exe" />
      <include path="arm64/Damocles.exe" />
      <include path="**/*.dll" min-matches="1" max-matches="unbounded" />
      <include path="**/*.node" min-matches="1" max-matches="unbounded" />
      <include path="**/*.exe" min-matches="1" max-matches="unbounded" />
      <for-each>
        <authenticode-sign />
      </for-each>
    </pe-file-set>
  </zip-file>
</artifact-configuration>
```

```xml
<!-- installers: both NSIS installers in one zip -->
<artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
  <zip-file>
    <pe-file path="Damocles-Setup-*-x64.exe">
      <authenticode-sign />
    </pe-file>
    <pe-file path="Damocles-Setup-*-arm64.exe">
      <authenticode-sign />
    </pe-file>
  </zip-file>
</artifact-configuration>
```

### Verifying a signed release

- `signtool verify /pa /v` passes on `Damocles.exe`, its `.node` modules and both installers, and names SignPath Foundation as the publisher.
- Every `latest-*.yml` entry matches its signed file (the check in step 6).
- An update from an unsigned N to a signed N+1 applies. The unsigned N has no `publisherName`, so it accepts the signed installer.
- An update from a signed N+1 to a signed N+2 applies, which proves electron-updater's publisher check passes.
- The obligations below are live on the repository page and the release pages.

## Obligations

- **Roles.** Declare the Authors, Reviewers and Approvers roles publicly in the README's "Code signing policy" section. One maintainer holds all three: AizenvoltPrime (Authors: commit rights; Reviewers: reviews every change before release; Approvers: approves each signing request in SignPath).
- **Code signing policy.** The README section states what is signed, by whom, and carries SignPath's attribution and the privacy statement. Keep this document's text and the README's identical; change both in one commit.
- **Metadata.** Every signed binary carries product name and version metadata. electron-builder writes `ProductName` `Damocles` and the release version into `Damocles.exe` and the installers from `productName` and `package.json` `version`. The signing policy can enforce them; third party files keep their own metadata.
- **Publisher check.** `win.signtoolOptions.publisherName` in `electron-builder.yml` is set to the certificate's common name (electron-builder 26 has no top level `win.publisherName` key, and electron-updater accepts a common name or a full distinguished name), so electron-updater verifies the Authenticode publisher of every downloaded update before it runs it (`NsisUpdater` reads `publisherName` from the packaged `app-update.yml`).
- **Browser feature disclosure.** The application states the browser feature in the text below.
- **The DevTools port.** `damocles.browser.devToolsPort` defaults to `false`, so the browser opens no unauthenticated debugging endpoint unless the user turns it on.

### Code signing policy text (README)

> Windows releases are signed. Free code signing is provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).
>
> Team roles: Authors, Reviewers and Approvers are all [AizenvoltPrime](https://github.com/AizenvoltPrime), the sole maintainer.
>
> Signed files: `Damocles.exe`, the other Windows binaries inside the app and the Windows installers, each built by this repository's release workflow from a tagged commit. Each signing request is approved by hand.

### Privacy statement (README)

> Damocles collects no telemetry, crash reports or analytics. It sends your prompts and files to the model providers you configure, and connects to the MCP servers, web tools and voice services you turn on. The desktop app also contacts GitHub (github.com and its release download servers) at startup to check for a newer release, and on Windows and Linux to download it. It sends nothing else to any networked system unless you ask it to.

### Browser feature disclosure (application text)

> Damocles has an optional browser feature, off by default (`damocles.browser.enabled` is `false`). When a developer turns it on, it drives the developer's own installed Chrome, on the developer's machine, against sites the developer chooses, for testing web apps and for web research. It uses Patchright, a Playwright fork, over the Chrome DevTools Protocol. It is not a hosted service and does not run without the developer. Its remote debugging port (`damocles.browser.devToolsPort`) is off by default.

## macOS: adding an Apple Developer ID later

Adding a Developer ID is packaging configuration and CI only:

1. Join the Apple Developer Program (individual, 99 USD per year).
2. Create a Developer ID Application certificate and an App Store Connect API key for notarization. Store the certificate (`CSC_LINK`, `CSC_KEY_PASSWORD`) and the API key (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`) as GitHub secrets for the macOS leg.
3. In `electron-builder.yml`, replace `mac.identity: "-"` with the certificate identity, set `hardenedRuntime: true`, add an entitlements file with `com.apple.security.device.audio-input`, add `NSMicrophoneUsageDescription` through `mac.extendInfo`, and turn on notarization.
4. Switch the macOS updater from notice to self update: in `src/desktop/main/updater.ts`, give darwin the Windows and Linux path (`autoDownload`, the restart toast, `autoInstallOnAppQuit`). The zip target and `latest-mac.yml` already exist, so no format change is needed.
5. Show voice on macOS by lifting the capability gate in `src/desktop/main/platform/capabilities.ts`.
6. Update the README, the release notes caveats and this document.

Existing ad hoc installs cannot update themselves to the first signed build, because Squirrel.Mac applies only an update whose signature matches the installed app. Those users download the first signed build once by hand.
