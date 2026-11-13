# Desktop app

This page covers the Damocles desktop app for Windows, macOS and Linux: installing and approving it, updates, the sidebar, settings and notifications, the editor, terminals and source control, and the data it shares with the VS Code extension.

The desktop app is an agentic development environment (ADE): the agent's chat is the center of the window, and the editor, terminals, search and source control sit beside it. It runs the same agent, chat and tools as the extension. In place of VS Code windows, a sidebar lists your projects and the selected project's chats, and the chat you pick fills the window. Remote projects are covered in [Remote development](remote-development.md).

## Install

Download the app from the assets of the [latest release](https://github.com/AizenvoltPrime/damocles/releases/latest). The download table, supported systems and the commands that verify a download are in the README under [Install the desktop app](../README.md#install-the-desktop-app). Other rpm distributions, such as openSUSE with `zypper install`, are not tested.

### Windows SmartScreen

Windows builds are code signed by SignPath Foundation (see the README's [Code signing policy](../README.md#code-signing-policy)). Until the certificate has built a reputation, SmartScreen can still show "Windows protected your PC" the first time you run the installer. Choose **More info**, then **Run anyway**.

### macOS approval

macOS builds are signed ad hoc, not with an Apple Developer ID, so Gatekeeper blocks the first launch of each new version:

1. Open Damocles from Applications once. macOS says it cannot verify the app; close that dialog.
2. Open **System Settings > Privacy & Security**, scroll to the Security section, and choose **Open Anyway** next to the message about Damocles. Confirm with your password or Touch ID.
3. Open Damocles again and choose **Open**.

On macOS 15 and later this is the only way to approve the app; Control-click > Open no longer bypasses Gatekeeper. Repeat it for each new version. Voice is not available on macOS, because an ad hoc signed app gets no microphone input.

macOS builds are tested by CI only. No one tests them by hand. On every release, GitHub's macOS runners run the end-to-end suite, install the app from the dmg on a fresh runner and launch it, and check the update notice.

### Linux packages and the sandbox

Linux ships `.deb` and `.rpm` only; there is no AppImage. Ubuntu 24.04 and later restrict the unprivileged user namespaces that Chromium's sandbox needs, and only an installed package can add the AppArmor profile that allows them. When AppArmor 4.0 or later is present, the package installs the profile `/etc/apparmor.d/damocles` for `/opt/Damocles/damocles` and loads it, and uninstalling removes it. Where user namespaces are unavailable, or restricted and the profile could not be loaded, the package makes Chromium's `chrome-sandbox` helper setuid root instead. The app always runs with the Chromium sandbox on. Do not start it with `--no-sandbox`.

### Corporate proxies and certificates

The desktop app follows the OS proxy settings, including PAC files. It trusts its bundled root certificates and the OS certificate store, so install a corporate CA into the OS store (the Windows certificate store, the macOS System keychain, or your Linux distribution's CA bundle). The packaged app ignores a `NODE_EXTRA_CA_CERTS` it inherits, because Electron removes it along with `NODE_OPTIONS`; on macOS and Linux it is still read when your shell profile sets it, and on Windows it is not read at all. The VS Code extension is not affected. Damocles' own views (chats, HTML previews and design previews) never send a TLS client certificate: a site that asks for one gets none, so a resource that requires one does not load there. Browser tabs run in your system Chrome or Edge and are not covered by this.

### Client certificates in browser tabs

A browser tab cannot show the browser's own certificate picker. A site that asks for a client certificate that one of your certificates fits keeps loading until you choose one. Choose Client Certificate for This Site..., in the View menu and the command palette while a browser tab shows an https page, lists the certificates the site accepts with their issuer and validity. Until you quit Damocles, the browser sends the one you choose to that site without asking. It restarts to apply your choice and reopens your pages. Pages of chats on a remote host are not supported. The choice uses a Chrome setting that Chrome documents for administrators, so a later Chrome version may ignore it.

## Updates

Settings › About shows the version and What's new, the notes of every release, newest first. Help › Check for Updates… checks at once, and the app also checks at startup, every 4 hours and after the computer wakes. Turn off Settings › About › Check for updates automatically (`damocles.desktop.update.checkAutomatically`) to check only when you ask. A pill in the title bar shows a download and then Restart to update.

- **Windows and Linux:** at startup the app checks the latest GitHub release, downloads a newer version in the background and shows a notice with **Restart Now**. If you dismiss it, the update installs when you quit. On Linux, installing asks for an administrator password (a `pkexec` prompt). Each Windows architecture reads its own update feed, the app runs a downloaded Windows installer only when SignPath Foundation signed it, and it never installs an older version.
- **macOS:** the app cannot update itself without a Developer ID signature. At startup it checks for a newer version and shows a notice; **Open Release Page** opens that version's GitHub release page. Download the new dmg there, install it over the old app and approve it again.

## Projects, chats and settings

### Projects

Projects lists each project folder with its git branch, an Untrusted badge (click it to answer the trust question) and how many of its chats are running or waiting for you. Selecting a project opens the chat you last viewed there, or a new chat. Add project opens the folder picker, a folder's Open as project in Files adds that folder as a project of its own, and a project's context menu removes it.

Drag a project, or use Move up and Move down in its context menu or Alt+Up and Alt+Down, to reorder the list; Open Chat in Project, the command palette, the New Terminal picker and its + menu, and Quick Open list projects in the same order; the New Terminal picker and its + menu keep each host's projects together, the hosts in the grouped view's order. The header's View by Host / View as List button switches the list between one list and a group per host (`damocles.desktop.projects.view`).

### Chats

Chats lists the selected project's conversations by Today, Yesterday and Earlier, each with its status, model and tag. Search and the tag filter narrow the list, and a row's buttons or context menu rename, tag or delete a chat; deleting a chat that is running or waiting for you warns first. A new chat with no conversation yet offers only Open and Delete, and if the list cannot load, the section says so and offers Try again.

**Chats in the background.** A chat that is running, waiting for you or holding browser pages or design previews stays loaded while you look at another, so it keeps working and switching back is instant. The three most recently viewed idle chats stay loaded too. An older chat unloads and reloads its history when you select it.

### Settings

Settings opens from the title bar's gear or `Ctrl+,` (`⌘,`).

- Appearance holds the theme (Dark, Light or System, also switched by the title bar's theme button), Reduce motion, Always show section actions (a sidebar section's title buttons otherwise show while you hover or focus it), Reopen where I left off and Restore default layout.
- Application holds the language, whether chats notify you, and the notification sound.

Each section saves where its subtitle says: Workspace to the project's `.damocles/settings.local.json`, This chat to the chat only, and the rest to `~/.damocles/settings.json`. When a file that takes precedence already sets the value, the change is written there so it takes effect, and the row's badge names that file. Workspace saves only for a trusted project; in an untrusted one its rows are disabled with a notice. Workspace also lists the values the project's settings files set for keys that have no row of their own, each with the file it comes from.

### Notifications

Notifications show as cards at the bottom-right of the screen, above other apps, whether or not Damocles is in front, without taking focus: a prompt waiting for you, a chat that finished or paused, a budget stop, and a subscription window crossing 80% or 95%, once per window reset even across restarts. A chat paused by a subscription's rate limit names the limit it reached (the 5-hour session or the weekly limit) and when it resets.

Only the cards take clicks, a card's button takes you to the prompt, chat, team or usage view, and F6 reaches the cards. The title bar's bell lists the run's notifications with Do not disturb, which silences prompts' and chats' cards, sound and flash while the app's own notices still show. The taskbar button (or dock badge) shows the count of new notifications until you open the bell and flashes for a prompt waiting for you, and each card plays a chime you can turn off. The app's own questions, such as trusting a folder, open as a dialog in the window's theme.

### Fonts

The app renders in Geist and Geist Mono, with Greek in Inter, all under the SIL Open Font License 1.1.

## Editor and files

### Editor tabs

Files and diffs open in editor tabs you can edit and save. A file keeps its encoding, BOM and line endings. A file that changes on disk while you edit it shows a conflict bar with Compare, Overwrite and Revert, and a file deleted on disk keeps its tab, struck through, until you save it again. Renaming a file or folder in Files keeps its open tabs and their unsaved text, unsaved text of a deleted file survives a restart, and unsaved work comes back after a restart when "Reopen where I left off" is on. A file over 10 MiB opens after you choose Open Anyway, up to 64 MiB.

A CI job's log opens in a read-only tab of its own from the job list (see [CI](git-hosting.md#ci)); it is not reopened after a restart.

Files the agent opens show in a tab without taking focus; an edit the agent proposes still opens its diff from the permission card. Format on save (Settings › Editor) formats each save with the trusted project's own Prettier, or the built-in formatter for TypeScript, JavaScript and JSON.

### Files section and Quick Open

The Files section lists the selected project and scrolls while a drag is held near its top or bottom edge.

Ctrl+P finds a file in any project, and `:line[:column]` after the name opens it there. An absolute path you type (`C:\x\y.ts:12`, `"C:\Program Files\x\a.ts"`, `/home/u/a.txt`, `~/a.txt`) opens that file editable, on the selected project's host when its paths fit, else on this computer; a typed folder path lists that folder's entries as you type, and Tab completes a name. Ctrl+Shift+P lists every command.

### HTML preview

Right-click an `.html` or `.htm` file in Files, or the tab of an open one, and choose Open preview. The page opens in its own editor tab, "Preview <name>", with no chat involved, in local, WSL, SSH and container projects alike; a click on the file still opens its code. The project's folder is the site's root, so relative and root-absolute links to CSS, scripts, images and `fetch('/data.json')` load, and so do scripts, fonts and APIs from the internet. Saving the page, or a CSS or script file it loaded, reloads the tab, whether you save in the editor or the file changes on disk or on the host. A page that names its own encoding, with `<meta charset>` or a byte order mark, shows in that encoding, and any other page shows as UTF-8. A link to another site opens in your browser when you click it, a link that opens a new tab included. Dot files and folders (`.env`, `.git`, `.ssh` and the like), key and certificate files are never served, also not through a folder link that leads into one. A project on a host previews once the host runs this version's Damocles server. A design's screen (`~/.damocles/designs/<design>/screens/*.html`) is the exception: its tab's Open preview opens the design preview, with its widths, states and markup, in the design chat, which must be open, or its main chat must be.

In a project you have not trusted, the page runs no script, its own inline scripts included, and loads nothing from this computer's own services or your local network, such as a dev server or a router; in your browser it loads from the internet over https only. A banner says "Scripts are off because this folder is not trusted." Trust Folder... trusts the project and reloads the tab with scripts on and with local services reachable. If a project stops being trusted, a page you opened from it in your browser stops working and Open in browser starts again. The toolbar's Reload reloads the page, and Open in browser opens the same page in your system browser, served from this computer at `127.0.0.1`. The link Damocles opens works once and gives that browser a cookie, and a request without the cookie is refused. The port stays open while any preview tab of the project does, and closes with the last one unless the agent's browser in a chat of that project still uses it. The tab's menu also has Open source, Copy path and Reveal in Files.

### Moving and copying files

- Dragging a file into the composer mentions it.
- Dropping files or folders from your file manager onto Files copies them into the folder under the pointer, Ctrl+V (Cmd+V) pastes files copied there after a confirmation, and "Copy files here..." in a folder's menu picks them in the system dialog; a name clash asks Replace, Keep both or Skip.
- Dragging a row onto a folder moves it after a confirmation, holding Ctrl (Option on macOS) copies it instead, and Cut, Copy and Paste in the menu do the same; open tabs and unsaved text follow a moved file.

"Don't ask again" turns either confirmation off (`damocles.desktop.files.confirmDragAndDrop`, `damocles.desktop.files.confirmPasteNative`).

### Search

The Search section matches VS Code's: it finds and replaces text across the project with Match Case, Whole Word, regular expressions, Preserve Case, globs and Search only in Open Editors, shows results as a list or a tree, and opens them in a Search Editor you can save as a `.code-search` file.

### Terminal

Ctrl+` shows or hides the terminal, starting one in the current project when none is open, or in your home folder when no project is. Ctrl+Shift+`, the + button, New Terminal With Profile and the empty panel's New Terminal button ask for the project first: every host's projects as the grouped view lays them out, the hosts in its order under the same headings, starting on the current project so Enter takes it. A project whose host is not connected is listed greyed out with "Not connected", and while no project is reachable the list offers your home folder; if a host disconnects after you picked its project, the next step says so. The next step lists the shells of that project's host, its default first. Shift+Enter or Shift+click on a project starts its host's default shell at once, and Shift+click on + does the same in the current project. The arrow beside + lists each project's shells, naming each project's host when they are on several, and your home folder's while no project is reachable. Each host has its own default shell: Select Default Profile... asks for the host whenever a project of a remote host is open, this computer always among them, and keeps this computer's in `damocles.desktop.terminal.defaultProfile` and a remote host's on this computer with that host's other settings. Terminals in an untrusted project work too.

- A file path in terminal output (`src/app.ts:42:7`, `app.ts(42,7)`, `"app.py", line 42`) opens in the editor at that line on Ctrl+click (Cmd+click), and a folder opens in Files.
- Right-click, Shift+F10 or the menu key opens the terminal menu (Copy, Paste, Select All, Clear, Rename, Change Icon, Change Color, Kill), F2 renames a terminal in place, and pasting several lines asks first.
- With shell integration (PowerShell, bash, Git Bash, zsh, fish), each command gets a mark with its exit code and a menu to rerun, copy or add its output to the chat, a terminal's title shows the running command, and killing a terminal that runs something asks first.

Split a terminal with Ctrl+Shift+5, the Split button in the terminal header or on a list row, or Split Terminal in the terminal menu. Panes sit side by side, each a full terminal with its own shell, title, links and Add to Chat, and the new pane starts in the folder the source shell last reported. A sash resizes them by drag or by arrow keys, Home and End (double-click shares the width again), Unsplit Terminal moves a pane into its own tab, and the list shows a split tab's panes together.

Arrange terminals by dragging a row in the list: a line shows where it lands. Dropped on a row of another tab, the row's whole split tab moves above or below that tab; dropped among its own tab's rows, the pane moves within the tab. Drag a row onto the left or right half of a shown pane to join that split on that side; the half lights up under the pointer, and a split that already has eight panes refuses it. Drop a row below the last one, or on the terminal header, to give it a tab of its own at the end; the header and the list light up together. A drop that would leave the terminal where it is shows no line and does nothing, and a worktree's Setup terminal joins no split: dropping onto or from it shows why. Hovering a row while you drag shows its terminal, so you can reach any tab's panes. Every drag has a keyboard path: Alt+Up and Alt+Down on a focused row (Option on macOS), and Move Up, Move Down, Join Terminals... and Unsplit Terminal in a row's menu. Join Terminals..., also in the command palette and the Terminal menu, lets you check the terminals to join, with a click or, after Down Arrow moves into the list, with Space, and joins them with Enter or OK. The order, the splits, their sizes and the active pane are kept across a relaunch, remote terminals included: a remote terminal holds its place as "Reconnecting" until its host connects. Killing one while it is "Reconnecting" ends it on its host as soon as the host connects, after a relaunch too. Moving a pane within its split shares the split's width equally again.

A terminal can also live in the editor area, as an editor tab beside your files. Move Terminal into Editor Area, in a row's or the single tab's menu, the command palette and the Terminal menu, moves it there; so does dragging its row or tab onto the editor tab strip, where a ghost tab at the end shows where it lands. The same shell keeps running: its output, scrollback, selection and command marks stay as they were, and you can type at once. The tab shows the terminal's icon, color and title, and "Reconnecting" while a remote terminal's host is away. Its menu (right-click, or Shift+F10 on the focused tab) offers Move Terminal into Panel, Rename... (F2), Change Icon..., Change Color... and Kill; dragging the tab onto the terminal list, a pane half or the empty panel brings it back to that place, and dropping it on the terminal header brings it back as its own tab at the end, even with one terminal left in the panel. Closing the tab kills the terminal, asking first as Kill does, and Close Others and Close All include terminal tabs. Kill, Restart, Rename, Copy Last Command and the other terminal commands act on the terminal you last typed in, selected, opened, split, joined with Join Terminals..., moved into or out of the editor, or activated as a tab, in the panel or the editor, and on a worktree's Setup task as soon as it starts; Split, Join Terminals... and the pane commands apply only in the panel, and a worktree's Setup task stays in the panel. With every terminal in the editor, the panel shows New Terminal. A relaunch brings editor terminals back as editor tabs, remote ones "Reconnecting" until their host connects.

Add your own shells under `damocles.desktop.terminal.profiles` in your user settings file (path, args, icon, color), or set a detected shell to `null` to hide it. Settings › Terminal lists your profiles, the detected shells and any entry that was not loaded, with the reason.

### Layout

The chat, editor and terminal panes can be dragged between the main, side and bottom slots, sidebar sections can be dragged by their header or moved from its menu, and the layout persists. F6 and Shift+F6 move focus between the parts: sidebar, editor, chat, terminal and the notification cards. Tab moves focus into the page a browser, design preview or HTML preview tab shows, and F6 or Shift+F6 leaves it, whatever the page does with those keys.

## Source control

The Source control section matches VS Code's: it lists the selected project's git repositories, nested repositories and submodules included, groups their changes as a list or a tree, stages, unstages and discards per file, per group or everything (a discarded working copy goes to the Recycle Bin or Trash first), and opens each change's diff in an editor tab.

- **Committing.** Ctrl+Enter (Cmd+Enter) commits, the menus offer Amend, Signed Off, Commit & Push and Commit & Sync, Up and Down recall earlier messages, and the sparkle button writes a message from the staged diff with the Background model.
- **Syncing.** The sync button beside the branch shows incoming and outgoing commits and runs Sync, or Publish for a new branch. More Actions holds Pull, Push, Fetch, remotes, branches, stashes, tags and worktrees, and the branch button opens Checkout to.... A running fetch, pull, push, sync or clone shows under the section title with a Cancel button.
- **Credentials.** For a GitHub or GitLab server where you have an account, the project's account answers git (see [Git credentials](git-hosting.md#git-credentials)). For any other server, when git needs a username, password, token or SSH key passphrase, the app asks in its own input box and hands the answer only to that git process.
- **Autofetch.** The selected project's repositories fetch in the background every 180 seconds (`damocles.desktop.git.autofetch`).
- **Clone** asks for a URL and a folder and adds the clone as an untrusted project. With a GitHub or GitLab account it lists your repositories instead, by account, with search, and a pasted URL still works (see [Clone from your repositories](git-hosting.md#clone-from-your-repositories)).
- **Publish.** Publish Branch on a repository with no remote opens the Publish dialog when you have a GitHub or GitLab account. Pick the owner (your own namespace, or an organization or group your account can create projects in), type the name (spaces become dashes) and the visibility; Internal shows only where the server has it. The dialog then shows each step: Create, Add as origin and Push as your account, and Cancel works until the push starts (a repository the server already created stays there, which the app tells you). A name the server refuses shakes the field and shows the server's reason, a failed step shows its failure under it, and the project then uses that account (see [Publish to GitHub or GitLab](git-hosting.md#publish-to-github-or-gitlab)). Without an account Publish says the repository has no remote.
- **Fork on a denied push.** When a push is refused and the server confirms your account can read the repository but not push to it, a dialog offers Fork and Push: it forks the repository to your account, renames `origin` to `upstream` (`upstream-2` when `upstream` exists, which the dialog says), adds your fork as `origin` and pushes. Cancel works until the push starts and leaves your remotes as they were. On success the dialog lists the new remotes, and Open Merge Request (Open Pull Request on GitHub) opens the server's page for your branch. A push refused because the remote has commits you lack never offers a fork (see [Fork when you cannot push](git-hosting.md#fork-when-you-cannot-push)).
- **CI.** With a GitHub or GitLab account, a chip beside the branch shows the branch's pipeline, and its job list retries, cancels and opens job logs (see [CI](git-hosting.md#ci)).
- **Links.** With a GitHub or GitLab account, Copy Permalink and Open File on Server in the editor, Open Commit on Server in the Graph and the blame card link the file's lines or the commit on its server, after checking that the commit is pushed (see [Links to a file or commit](git-hosting.md#links-to-a-file-or-commit)).
- **History details.** With a GitHub or GitLab account, each Graph row shows the author's 0.875rem picture before the name (both hide below 17.5rem of row width), and an expanded commit shows it in its meta row. The commit message links `#123`, `!45` (GitLab only) and `owner/repo#12`, each opening on the server in your browser, and the status row under the message shows the pipeline ("Pipeline #4312 passed") and the change that merged the commit ("Merged in !45", on GitHub "Merged in #12"), either one alone when the other is absent. The blame card shows the author's picture over the initial, links in its summary and "Merged in !45" in its meta line, and the inline blame annotation shows the picture before its text. A picture shows the initial on a tint until it arrives, then fades in (at once with reduced motion); a picture that fails keeps the initial. Links and the merged change are reachable with Tab from the focused Graph row, and Enter opens them. With `damocles.desktop.forge.showAvatars` off no pictures show in the Graph, details or annotation, the blame card keeps the initial, and nothing is requested (see [History details](git-hosting.md#history-details)).

The Repositories section lists each repository's branches, stashes, tags and worktrees, with rows that check out, merge, rebase, compare, delete, apply a stash or open a worktree as a project.

The Graph section, below Source control, draws the repository's history as lanes with branch, remote, tag and base badges and the Incoming and Outgoing Changes, shows Auto, All or the branches and tags you pick, and offers checkout, branch, tag, cherry pick, compare and copy on each commit; clicking a commit lists its files.

A conflicted file opens in a three-way merge editor, a file's Timeline lists the commits that changed it, and inline blame names the commit behind the cursor line. Review Changes opens what a chat changed as a diff tab whose line comments go back to that chat.

**Worktree chats.** Run in a new worktree, in the Chats section's New menu, gives a chat its own branch and copy of the project, optionally with your uncommitted changes and the ignored files `.worktreeinclude` lists. It runs the setup commands in the project's `.damocles/worktree.json` (`setup`, or `setupWindows` and `setupUnix`) once you confirm them, and while the chat is selected Files, Search, Source control and the Graph show that copy. The isolation rules are in [Worktree isolation](worktree-isolation.md).

Git runs only in a trusted project, and a repository above the project folder opens only after you answer Yes or Always. Settings › Source control holds the `damocles.desktop.git.*` settings, with VS Code's defaults.

## Data shared with the extension

The desktop app and the extension share one data home, `~/.damocles`: conversations and their checkpoints, memory, Compass indexes, usage stats, pi sign-ins (Claude and OpenAI), MCP servers in `~/.damocles/mcp.json`, and the settings files (`~/.damocles/settings.json` and a project's `.damocles/settings.json` and `.damocles/settings.local.json`). A conversation started in VS Code continues in the desktop app on the same folder. A conversation can be open in only one app at a time.

Only these stay in the desktop app's own data folder (`%APPDATA%\damocles` on Windows, `~/Library/Application Support/damocles` on macOS, `~/.config/damocles` on Linux):

- the loaded chats and their browser pages (`panels.json`), the window's size, position and sidebar layout (`window-layout.json`), and `state/`
- the folder trust list (`trusted-folders.json`)
- the project list (`projects.json`)
- the remote hosts you saved, with their projects, trust and the sidebar's order (`remote-hosts.json`), the remote terminals and chats to reopen (`remote-state.json`), the server packages it downloaded for your hosts (`server-cache/`), and each host's copy of its chats (`remote/`)
- encrypted secrets (`secrets.json`, encrypted with the OS keychain; without a reachable keyring the app keeps secrets for the session only and says so; see [Desktop credential storage](../README.md#desktop-credential-storage))
- logs (`logs/`)

Uninstalling the app leaves `~/.damocles` in place, because the extension uses it too.

## Trust and secrets are per app

Neither app can read the other's trust list or encrypted secrets:

- **Trust:** the desktop app asks you to trust each project folder, by exact path. Trusting a folder in VS Code does not trust it in the desktop app, and trusting a parent folder does not trust its subfolders.
- **Secrets:** MCP OAuth tokens and the keys you save in Settings are stored per app. Sign in to an OAuth MCP server and enter those keys once in each app. pi sign-ins live in `~/.damocles` and are shared.

How the desktop app encrypts the secrets you save is described in the README under [Desktop credential storage](../README.md#desktop-credential-storage).
