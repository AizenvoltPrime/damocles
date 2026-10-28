# Desktop code signing

This document is the procedure for signing the desktop app. It covers Windows signing, the obligations that come with it, and how an Apple Developer ID would be added for macOS later.

## Where things stand

| Platform | Today | Consequence for users |
| --- | --- | --- |
| Windows x64 and arm64 | Releases so far are unsigned. The signing pipeline is in place, and the next release is signed by SignPath Foundation once the Foundation imports the release certificate ("SignPath setup") | Unsigned releases: SmartScreen warns on the first run of the installer ("More info", then "Run anyway"), and electron-updater skips the publisher check because their `app-update.yml` has no `publisherName`. Signed releases accept only an update signed by SignPath Foundation. |
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

SignPath Foundation signs only software built from the project's own source code; upstream open source binaries may ship inside a signed package, unsigned ("Conditions for using the SignPath Foundation certificate", https://signpath.org/terms.html). So only `Damocles.exe`, which electron-builder writes from Electron's binary with Damocles' name, icon and version, `ssh-askpass.exe`, which the desktop build compiles from `resources/askpass/ssh-askpass.cs`, and the installers are signed. Electron's DLLs, `elevate.exe`, `rg.exe` and the koffi and node-pty modules ship as their projects publish them.

### SignPath setup

The SignPath Foundation accepted the project. Its organization "Damocles [OSS]" (ID `567f8646-d332-4f0e-88a9-7f2a21e285d9`) holds:

- Project `damocles`, repository URL `https://github.com/AizenvoltPrime/damocles.git`, with the predefined trusted build system GitHub.com linked.
- The SignPath GitHub App (`https://github.com/apps/signpath`) installed on the account with access to this repository. SignPath's connector reads the workflow run and its artifacts through it; without it every signing request fails with "Failed to retrieve GitHub App token".
- Signing policy `release-signing`: certificate "Release certificate 2026" on SignPath's HSM, submitter the CI user "CI builds", one approval by AizenvoltPrime, trusted build system and origin verification required. The Foundation orders and imports the certificate after it reviews a working test setup; until then the certificate is "CSR pending" and the policy invalid, and a tag run fails at the first signing request, before anything is published.
- Signing policy `test-signing`: the self-signed "Test certificate 2026", submitter "CI builds", no approval, trusted build system and origin verification required, so a test run passes the same origin checks a release does.
- Artifact configurations `app-executables` and `installers` (below).
- The CI user's API token, stored as the GitHub Actions secret `SIGNPATH_API_TOKEN`. The organization ID and the slugs are not secret and live in the workflow.

`win.signtoolOptions.publisherName` in `electron-builder.yml` is `SignPath Foundation`, the common name of the release certificate (see "Obligations").

### Why the Windows release path has to change

- SignPath signs only artifacts a workflow uploads and submits through its action, `signpath/github-action-submit-signing-request`.
- An NSIS installer's inner files cannot be signed after it is packed. The app binaries have to be signed before the installer is built.
- Signing a file after electron-builder has hashed it breaks every Windows update, because `latest-<arch>.yml` still carries the pre signing `sha512` and `size` (electron-builder issue 9538), and electron-updater rejects the download.

One electron-builder behavior shapes every step below: it writes `resources/app-update.yml`, the app's update feed, only in the after-pack step of a build that has an `nsis` target (app-builder-lib `PublishManager`, `onAfterPack`). A `--dir` build and a `--prepackaged` build never write it. An app without that file has no update feed and can never update itself.

### The signing job structure

1. **Each Windows leg of `package-desktop`** builds the `nsis` target, not `--dir`, so the after-pack step writes `resources/app-update.yml` (GitHub provider, `channel: latest-<arch>`, `publisherName: [SignPath Foundation]`) into the unpacked app. The fuses are flipped and the asar integrity hash is embedded in this step, before anything is signed. The leg checks the unpacked app, runs the packaged end-to-end suite against it, checks it is still clean, and uploads it as `unpacked-<target>`. The unsigned installer the build also writes is never uploaded.

2. **The `sign-windows` job** on `windows-latest` waits for `verify`, `package`, `package-desktop`, `e2e-desktop`, the remote suites (`remote-e2e`, `reference-e2e`), and the macOS and Linux install and update tests (`verify-desktop-install`, `desktop-update-test`), every job that does not test the signed files, so a run that fails a check never spends SignPath's yearly artifact quota. A failure in a later job reruns with `gh run rerun --failed`, which keeps the signed artifacts and does not sign again. The job installs with `npm ci --ignore-scripts` (it holds the SignPath token), downloads both unpacked apps into `unsigned/x64` and `unsigned/arm64`, uploads their two `Damocles.exe` files and their two SSH askpass trampolines (`resources/app.asar.unpacked/dist/askpass/ssh-askpass.exe`) as one artifact (`x64/Damocles.exe`, `x64/ssh-askpass.exe`, `arm64/Damocles.exe`, `arm64/ssh-askpass.exe`) and submits it with the `app-executables` configuration. Both requests pass the `package.json` version as the `version` parameter (on a tag, `verify` has checked it equals the tag). A tag push signs with `release-signing`, and a manual run with its `sign` input on signs with `test-signing`. A manual run with `sign` off, the default, skips every SignPath step: the apps stay unsigned, step 4 builds the installers from them, and the feeds electron-builder wrote already describe those installers, so the install and update tests still run on Windows without spending quota. The action waits up to 3600 seconds per request for the approval, and the job's limit is 150 minutes.

3. **It puts the signed executables into the apps and checks them.** The signed `Damocles.exe` and `ssh-askpass.exe` replace the unsigned ones in each app, which becomes `signed/<arch>`. `scripts/verify-desktop-package.mjs` runs again on each, proving signing left the fuse wire, the tree and `app-update.yml` untouched; the job first downloads `verify`'s `fetched-assets` artifact, because the check compares the apps' grammars and wake models with the repository's. `scripts/check-authenticode.ps1` fails unless all four executables, both apps' `Damocles.exe` and `ssh-askpass.exe`, carry a signature from one signer. On a tag it also requires that signer to be a trusted "SignPath Foundation" certificate.

4. **It builds both NSIS installers from the signed directories** with no certificate in the environment and `win.signAndEditExecutable` off, so electron-builder neither edits nor re-signs the signed binaries:

   ```bash
   npx electron-builder --win nsis --x64 --prepackaged signed/x64 --publish never -c.publish.channel=latest-x64 -c.win.signAndEditExecutable=false
   npx electron-builder --win nsis --arm64 --prepackaged signed/arm64 --publish never -c.publish.channel=latest-arm64 -c.win.signAndEditExecutable=false
   ```

   `--prepackaged` does not write `app-update.yml`; the signed directory keeps the one step 1 wrote, because it is not a PE file.

5. **It submits both installers as one artifact** with the `installers` configuration.

6. **It rebuilds the update metadata from the signed installers**: `node scripts/signed-windows-feed.mjs --rewrite dist-desktop x64 arm64` regenerates each `.blockmap` and writes the signed file's `sha512` and `size` into `latest-<arch>.yml`, in the `files` entry and the top level `sha512`, keeping every other field as electron-builder wrote it. It uses electron-builder's `buildBlockMap(file, "gzip", file + ".blockmap")` from `app-builder-lib/out/targets/blockmap/blockmap.js`, an internal module, so electron-builder stays pinned and the path is re-checked when it is bumped.

7. **It checks the result before anything downstream runs**: `check-authenticode.ps1` on both installers and all four executables, so the two requests' signer is one, `signed-windows-feed.mjs --check`, which recomputes `sha512` and `size` of every file each feed names and rebuilds each blockmap to compare it byte for byte, and the release artifact check for `win-x64,win-arm64`. It uploads `desktop-win-x64` and `desktop-win-arm64`.

8. **Downstream jobs use only the signed files.** `verify-desktop-install-windows` (`nsis`) and `desktop-update-test-windows` (`win-arm64`) install the signed installer, with the same steps as their macOS and Linux counterparts, and `attest` and `release` attach and attest the signed installers, blockmaps and feeds; all four need `sign-windows`. The N+1 installer the update test serves stays unsigned, because it is never released, and `scripts/desktop-update-override.mjs` drops `publisherName` from the test install's `app-update.yml`, so that test skips the publisher check; the signed N+1 to N+2 update in "Verifying a signed release" is what covers it.

The NSIS uninstaller stays unsigned. NSIS generates it inside the installer at install time, and a file created locally carries no download mark for SmartScreen to check.

### Artifact configurations

Both configurations take a required `version` parameter, which the workflow sets to the `package.json` version, and enforce it with the product name on every file they sign, so a request signs only a file built for that release (SignPath Foundation's metadata condition). electron-builder writes `ProductName` `Damocles` and `FileVersion` the version into both. `ProductVersion` is the same version in two notations: in `Damocles.exe` it is the four-part Windows form `x.y.z.0` (app-builder-lib `winPackager.js`, `getVersionInWeirdWindowsForm`), in the installer the version itself (`NsisTarget.js`, `computeVersionKey`). A prerelease version (`x.y.z-beta.1`) therefore fails `app-executables`; releases are plain versions.

`app-executables` signs the two `Damocles.exe` files and the two `ssh-askpass.exe` trampolines, which the desktop build compiles from `resources/askpass/ssh-askpass.cs` with the same product name and versions (docs/release.md "Desktop installers"). No other file reaches SignPath, so nothing else can be signed by the Foundation's certificate. The configuration lives in the SignPath project, not in this repository: the two trampoline lines below must be added there before the first release that ships them, or the signing request fails.

```xml
<artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
  <parameters>
    <parameter name="version" required="true" />
  </parameters>
  <zip-file>
    <pe-file-set product-name="Damocles" product-version="${version}.0" file-version="${version}">
      <include path="x64/Damocles.exe" />
      <include path="x64/ssh-askpass.exe" />
      <include path="arm64/Damocles.exe" />
      <include path="arm64/ssh-askpass.exe" />
      <for-each>
        <authenticode-sign />
      </for-each>
    </pe-file-set>
  </zip-file>
</artifact-configuration>
```

`installers` signs the two NSIS installers.

```xml
<artifact-configuration xmlns="http://signpath.io/artifact-configuration/v1">
  <parameters>
    <parameter name="version" required="true" />
  </parameters>
  <zip-file>
    <pe-file-set product-name="Damocles" product-version="${version}" file-version="${version}">
      <include path="Damocles-Setup-${version}-x64.exe" />
      <include path="Damocles-Setup-${version}-arm64.exe" />
      <for-each>
        <authenticode-sign />
      </for-each>
    </pe-file-set>
  </zip-file>
</artifact-configuration>
```

### Test run

Actions > "Create Release from Tag" > Run workflow with "sign" ticked (`gh workflow run release.yml --ref <branch> -f sign=true`) runs the whole workflow from a branch with `test-signing`: every build, test, signing and check job runs, and `attest` and `release` are skipped, so nothing is published. `verify` skips its tag version check. Download `desktop-win-x64` from the run and check `Get-AuthenticodeSignature .\Damocles-Setup-*.exe` names the test certificate (status `UnknownError`, because it chains to no trusted root). Once a run passes, tell the SignPath Foundation the setup is ready, with a link to the run; they review it and import the release certificate.

### Verifying a signed release

- `signtool verify /pa /v` passes on `Damocles.exe`, `resources\app.asar.unpacked\dist\askpass\ssh-askpass.exe` and both installers, and names SignPath Foundation as the publisher.
- Every `latest-*.yml` entry matches its signed file (the check in step 7).
- An update from an unsigned N to a signed N+1 applies. The unsigned N has no `publisherName`, so it accepts the signed installer.
- An update from a signed N+1 to a signed N+2 applies, which proves electron-updater's publisher check passes.
- The obligations below are live on the repository page and the release pages.

## Obligations

- **Roles.** Declare the Authors, Reviewers and Approvers roles publicly in the README's "Code signing policy" section. One maintainer holds all three: AizenvoltPrime (Authors: commit rights; Reviewers: reviews every change before release; Approvers: approves each signing request in SignPath).
- **Code signing policy.** The README section states what is signed, by whom, and carries SignPath's attribution and the privacy statement. Keep this document's text and the README's identical; change both in one commit.
- **Metadata.** Every signed binary carries product name and version metadata, and both artifact configurations enforce them against the release version ("Artifact configurations"). electron-builder writes them into `Damocles.exe` and the installers from `productName` and `package.json` `version`, and `scripts/askpass-trampoline.mjs` writes the same values into `ssh-askpass.exe`.
- **Own code only.** Only files built from this repository are signed ("Applying"). A new executable this repository builds joins `app-executables`; an upstream binary never does.
- **Publisher check.** `win.signtoolOptions.publisherName` in `electron-builder.yml` is set to the certificate's common name (electron-builder 26 has no top level `win.publisherName` key, and electron-updater accepts a common name or a full distinguished name), so electron-updater verifies the Authenticode publisher of every downloaded update before it runs it (`NsisUpdater` reads `publisherName` from the packaged `app-update.yml`).
- **Browser feature disclosure.** The application states the browser feature in the text below.
- **The DevTools port.** `damocles.browser.devToolsPort` defaults to `false`, so the browser opens no unauthenticated debugging endpoint unless the user turns it on.

### Code signing policy text (README)

> Windows releases are signed. Free code signing is provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).
>
> Team roles: Authors, Reviewers and Approvers are all [AizenvoltPrime](https://github.com/AizenvoltPrime), the sole maintainer.
>
> Signed files: `Damocles.exe`, `ssh-askpass.exe` (the SSH password prompt helper, compiled from `resources/askpass/ssh-askpass.cs`) and the Windows installers, each built by this repository's release workflow from a tagged commit. Each signing request is approved by hand. The open source components the app includes (Electron's libraries, ripgrep, koffi, node-pty) ship as their projects publish them and are not signed by this project.

### Privacy statement (README)

> Damocles collects no telemetry, crash reports or analytics. It sends your prompts and files to the model providers you configure, and connects to the MCP servers, web tools and voice services you turn on. With a Claude subscription sign-in, `/usage` also reads your account profile from Anthropic (`api.anthropic.com/api/oauth/profile`). With image generation turned on, `GenerateImage` sends the agent's image prompt to OpenRouter. With a TypeSafe or OpenRouter key set, the memory judges send memory text and your prompt to TypeSafe's Jev classifier, directly or through OpenRouter; with neither and an OpenAI API key, or when you choose it, to OpenAI's Decisions API (GPT-6 Luna). The desktop app also contacts GitHub (github.com and its release download servers) at startup, every 4 hours and after the computer wakes to check for a newer release, and on Windows and Linux to download it; Settings › About › Check for updates automatically turns those checks off, leaving only the checks you ask for. It sends nothing else to any networked system unless you ask it to.

### Browser feature disclosure (application text)

> Damocles has an optional browser feature, off by default (`damocles.browser.enabled` is `false`). When a developer turns it on, it drives the developer's own installed Chrome, on the developer's machine, against sites the developer chooses, for testing web apps and for web research. It uses Patchright, a Playwright fork, over the Chrome DevTools Protocol. It is not a hosted service and does not run without the developer. Its remote debugging port (`damocles.browser.devToolsPort`) is off by default.

## macOS: adding an Apple Developer ID later

Adding a Developer ID is packaging configuration and CI only:

1. Join the Apple Developer Program (individual, 99 USD per year).
2. Create a Developer ID Application certificate and an App Store Connect API key for notarization. Store the certificate (`CSC_LINK`, `CSC_KEY_PASSWORD`) and the API key (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`) as GitHub secrets for the macOS leg.
3. In `electron-builder.yml`, replace `mac.identity: "-"` with the certificate identity, set `hardenedRuntime: true`, add an entitlements file with `com.apple.security.device.audio-input`, add `NSMicrophoneUsageDescription` through `mac.extendInfo`, and turn on notarization.
4. Switch the macOS updater from notice to self update: in `src/desktop/main/updater.ts`, give darwin the Windows and Linux path (`autoDownload`, the restart toast, `autoInstallOnAppQuit`). The zip target and `latest-mac.yml` already exist, so no format change is needed.
5. Show voice on macOS by lifting the capability gate in `src/desktop/local-services/capabilities.ts`.
6. Update the README, the release notes caveats and this document.

Existing ad hoc installs cannot update themselves to the first signed build, because Squirrel.Mac applies only an update whose signature matches the installed app. Those users download the first signed build once by hand.
