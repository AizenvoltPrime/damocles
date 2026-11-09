# Remote development

This page covers opening projects on other machines from the desktop app: supported targets, what runs where, what Damocles sends to a host and changes there, installing the server, WSL, dev containers, the `damocles` command and known limitations.

The desktop app opens projects on other machines: a server over SSH, a WSL distro on Windows, or a dev container. Remote projects sit in the Projects list beside your local ones, each with its host's name and a status dot. Files, the editor, terminals, Search, Quick Open, source control and the agent work on them as on a local project.

## Targets and what runs where

| Target | Reached through | Needs |
| --- | --- | --- |
| Linux x64 or arm64 | SSH | glibc 2.28 or later, `libstdc++` with `GLIBCXX_3.4.25`, Linux 4.18 or later; on NixOS, nix-ld |
| Alpine Linux (musl) x64 or arm64 | SSH | `libstdc++` and `libgcc` installed |
| macOS x64 or arm64 | SSH (Remote Login) | macOS 13.5 or later |
| Windows x64 or arm64 | SSH (OpenSSH Server) | Windows 10 1809 or Windows Server 2019 (build 17763) or later |
| A WSL distro (WSL 1 or WSL 2) | `wsl.exe`, from Damocles on Windows | the Linux or Alpine rows above |
| A dev container | Docker or Podman, on this computer or on an SSH host | `.devcontainer/devcontainer.json` or `.devcontainer.json` in the folder, or a running container to attach to |

Every target needs 300 MB free in its home folder, or in the install folder you set for it. Damocles uses your computer's OpenSSH client (`ssh`) and your `~/.ssh/config`, keys and ssh-agent as they are.

### Connecting

Connect with the Projects header's Connect to host button, File › Connect to Host... (Remote: Connect to Host... in the command palette), or Remote folder... in the Projects add menu. The Connect dialog lists your saved hosts, the aliases in `~/.ssh/config`, your WSL distros and Dev Containers, and takes `user@host[:port]` or a pasted ssh command. A new host gets a name you choose, which Damocles saves in its own host list and never in `~/.ssh/config`. Rename it any time from the host card, a project's menu or Settings › Remote hosts, which also sets its color for the title bar stripe and badges: one of the 5 theme tones, or any color and opacity from the custom swatch's picker.

### What runs where

On a remote project, the agent runs on the target: pi, its tools, checkpoints, hooks, the project's MCP servers, subagents and teams. So do its files, terminals, search and git. Your computer shows the chats and runs what belongs to you: your sign-ins, the agent's browser, voice, your global memories and profile, and the personal MCP servers you mark "Available on remote hosts". Chats are stored on the target, and Damocles keeps a copy of each host's chats on this computer so you can read them while the host is offline and `/stats` can count their spend.

New Terminal asks for the project first and lists every host's projects, so a terminal on any connected host starts from wherever you are; it then lists that host's own shells. Each host has its own default shell: choose it with Select Default Profile..., which asks for the host first. Damocles keeps it on this computer with the host's other settings, so it survives a relaunch and Forget host removes it.

### Dropped connections

A dropped connection shows nothing for 2 seconds. After that the host's dot turns amber, a banner counts down to the next try, and you keep working: saves stay on this computer and upload when the host is back (a file that changed there meanwhile opens in the merge editor), messages wait and send in order, and terminals pause. A changed host key stops the connection until you fix it.

### Quitting with work running

When you quit while remote chats are working, Damocles asks: **Keep running** lets them finish on the host, **Stop agents** stops them. Keep running first refreshes the sign-ins those chats use and sends the host fresh access tokens. If a token runs out before you come back, the chat waits as Sign-in needed and goes on when your computer connects again. Terminals on a host keep running until you close them, kill them from the host card, or no device opens them for 30 days (Settings › Remote hosts › End forgotten terminals, `damocles.desktop.remote.terminalIdleDays`, 0 keeps them).

### Ports and the browser

Ports that programs on the target listen on forward to this computer by themselves (`damocles.desktop.remote.autoForwardPorts`); after 20 automatic forwards on one host, only ports printed in its terminals and the agent's shell forward (`damocles.desktop.remote.autoForwardPortsFallback`). The Ports section lists them with Open in browser, Change local port and Stop forwarding. The agent's browser runs on this computer, with its own profile for each host, and cannot reach this computer's local network unless you turn on that host's "Let the agent's browser reach this computer's local network". Forwarded ports always work.

### Usage and memory in remote chats

`/usage` and the other ways to open subscription usage in a remote chat show this computer's usage, read by Damocles on this computer, also while the host is away. Usage warnings at 80% and 95% come only from turns that settle on this computer, so a remote chat's turns raise none.

A remote chat's memory popup shows two sources side by side: the host's project and session memories and observations, and this computer's notes and global facts, preferences and episodes, which Damocles on this computer lists itself. Pin, Unpin, Forget, Unforget, Delete, New memory (global or note) and the global profile change this computer's memory database directly; the host never sees them, so they work while the host is away, and the host's memories stay as last loaded until it is back. With memory turned off on this computer, the popup says "Memory is off on this computer." and still shows the host's memories; turning memory on or off here updates an open popup.

The agent's ListNotes on a host returns this computer's notes, the same list a local chat gets, with ids of the form `global:<computer>:<id>`. It needs Damocles open on this computer, and a Damocles there new enough to list them. While memory is off on this computer it says "Memory is off on your computer." instead.

## What reaches the target

- **AI sign-ins:** short-lived access tokens, and the API key a run needs, one provider at a time, only when a run on that host asks. Refresh tokens never leave this computer, and tokens and keys stay in the server's memory only. When your computer has no credential for a provider and the host has its own (an environment variable such as `ANTHROPIC_API_KEY`, an AWS profile or instance role, Google application default credentials), the model picker marks that model "{host}'s environment" and `/stats` counts its spend against the host.
- **Git credentials:** only after you allow it. The first time git on a host asks for a credential from your computer's credential manager, Damocles asks Allow once, Always for {host}, or Deny, and warns when the host has a credential helper of its own that would save it there. Only https requests are answered, and the host can never store or erase a credential on this computer. SSH agent forwarding is off until you turn on Forward my SSH agent for that host.
- **Settings:** your permission rules and the settings Damocles reads from your user settings file, never `env`, `apiKeyHelper`, hooks or tokens. They stay in the server's memory.
- **Voice:** the text you dictate, as a prompt. Audio never leaves this computer.
- **Personal MCP servers:** only the ones you mark "Available on remote hosts" in the MCP panel (`damocles.desktop.mcp.remoteAvailable`), by name, description, tool schemas, which tools always load and how long a call may take. They keep running on this computer, and their `env` and headers never cross. With two computers connected to a host, a message uses the servers of the computer that sent it.
- **Global memories:** what a remote chat's searches return while your computer is connected, and your notes when the agent lists them (ListNotes), in pages Damocles checks before they leave this computer. The popup's list and its changes go only between the chat's page and Damocles on this computer, never through the host. A memory the agent saves while you are away waits on the host and arrives once when you reconnect. Memories that wait 30 days for a computer that never reconnects (a reinstall gets a new identity) show on the host's card in Settings > Remote hosts, where another computer can take them with Deliver here or delete them with Discard.

A remote chat never writes your computer's files or changes its settings or sign-ins, except through what it uses on this computer: the global memories it saves, the personal MCP servers above, its browser, whose profile and downloads for that host stay in `~/.damocles/browser-profiles/`, and its pinned-header and Tools switches, which save your user settings here and so change your local chats too, unless a project's settings set them. A Tools switch that the host's own `~/.damocles/settings.json` sets shows disabled, with a link to the host's tab. "Always allow" chosen in a remote chat is saved on that host, and the permission card says "Always allow on {host}". The settings of a remote chat show three tabs: User (your computer), the host's name (its `~/.damocles/settings.json`) and Project.

## Changes Damocles makes on a host

Damocles keeps its files on a target under `~/.damocles`. It changes anything else there only when you ask:

- **Set up passwordless login** (host card or Settings › Remote hosts) creates a key for Damocles alone in `~/.damocles/ssh/` on this computer and adds it to `~/.ssh/authorized_keys` on the host, as ssh-copy-id does, or to `administrators_authorized_keys` for a Windows administrator.
- **Allow background work** shows when a Linux host ends your processes at sign-out. It runs `loginctl enable-linger` for your own account there, and when the host refuses, the card shows the command an admin must run.
- **Remove Damocles server...** deletes what Damocles installed, and, only when you tick their boxes, the key line and the linger it added. Your project files and git history stay.
- **Convert to WSL 2...** and **Rebuild Container...** run only after you confirm what they stop.

Damocles never writes `~/.ssh/config` or `~/.ssh/known_hosts` on this computer (ssh records a host key you accepted), and never a target's `.gitconfig`.

## Installing the server

On the first connection, and after an app update, the target downloads the Damocles server package for its platform from this release on GitHub (`github.com/AizenvoltPrime/damocles/releases`). When the target cannot reach GitHub, Damocles downloads the package on this computer and uploads it over the SSH connection. Either way the target checks the package's SHA-256 against the hash this app carries before it unpacks anything, and a mismatch installs nothing. A WSL distro, and a dev container on this computer, get the package copied from this computer, which downloads it from GitHub first when it does not have it. A dev container on an SSH host gets it from that host, which downloads it from GitHub once.

### A host's install folder

The server goes to `~/.damocles/server` on the target. When the home folder is small or does not allow running programs (mounted `noexec`), the Connect dialog says so and offers Choose install folder; you can also set Settings › Remote hosts › Install folder. Damocles then installs into `<folder>/<your user name>`, creating it for you only, and refuses a folder other users can change. Only the server moves: chats and settings stay in `~/.damocles`. After you change the folder, the next install removes Damocles' own files from the old one, never the folder itself.

## Several devices

Several computers can use one host at once, each signed in over SSH as the same account. They share the host's chats and terminals, and each sees the others listed on the host card. What you open shows on the computer you clicked on: a conversation another computer has open, or the design preview of such a chat, opens on yours as well, and the other computer stays where it is. If it cannot open on yours, for example because this app is older than the server, your computer says so and nothing opens on the other. Each turn uses the AI sign-in of the device that sent the message. When that device is away and its token runs out, the chat shows Sign-in needed on every device, and only a click on "Continue with my sign-in" moves the turn to another device's sign-in.

People who share one server account share everything Damocles keeps on that host: chats, files, terminals, project memories and trust. The operating system gives them the same powers there, so either can read the other's short-lived access tokens. Give each person their own account on the host.

## Removing the server and forgetting a host

To take Damocles off a host, connect to it and choose Remove Damocles server... on its host card or under Settings › Remote hosts › Host actions. The dialog lists what still runs there and stops it. Server versions that another computer sharing that home still uses stay.

Forget host removes the host from this computer: its projects, saved password, copy of its chats, browser profile and port settings. Nothing changes on the host, and the Damocles server stays installed there; the Forget dialog's Remove the server first... takes it off before you forget the host.

## WSL

On Windows, the Connect dialog lists your WSL distros. A distro installs the server from this computer, needs no SSH, and shares the agent, terminals and Files as an SSH host does. WSL 1 works too: it cannot report file changes reliably, so Damocles checks for changes every 5 seconds, and the host card offers Convert to WSL 2..., which runs `wsl.exe --set-version <distro> 2` after you confirm. A local project opened through `\\wsl.localhost\<distro>\...` or `\\wsl$\<distro>\...` offers Reopen in WSL..., and the same command reopens a Windows folder in a distro through `/mnt`, which Damocles also checks every 5 seconds. The project keeps its chats and its trust. SSH agent forwarding does not reach WSL.

## Dev containers

A folder with `.devcontainer/devcontainer.json` or `.devcontainer.json` opens in a container from the Connect dialog's Dev Containers list, on this computer's Docker or an SSH host's, and the agent, terminals and Files run inside it. `damocles.desktop.remote.containerEngine` picks Docker or Podman for a new container; a saved one keeps its engine.

Damocles runs the Dev Containers CLI only in a folder you trust, then lists what the configuration runs on the host and the access it gives the container (`initializeCommand`, mounts, `runArgs`, privileged mode, added capabilities, Features, with privileged mode and the Docker socket marked) and builds only after you confirm. It asks again only when one of those changes. The build log shows in the connect timeline.

A running container can be attached instead. Rebuild Container... asks first and keeps the project's trust, layout and chats, because the container's `~/.damocles` lives in a `damocles-data-<key>` volume that Damocles never removes. Each container has its own Forward my SSH agent switch.

## The damocles command

`damocles` opens files and folders in Damocles from a terminal, on this computer, in a WSL shell, and in the terminals Damocles opens on a host:

```bash
damocles .                              # open this folder
damocles src/app.ts:42                  # open a file at line 42 (src/app.ts:42:7 for a column)
damocles --wait COMMIT_EDITMSG          # return once its tab closes, so git can use it as its editor
damocles --diff a.txt b.txt             # compare two files in a read-only Changes tab
damocles --remote ssh+prod-1 /srv/app   # this computer only: open a folder on a saved host
```

Any file on that machine opens editable, except a file on a network share or a device outside your projects and, on Windows, a path with a part Windows reads differently than it is written, such as a trailing dot or space, a stream or a reserved device name. A file that does not exist yet opens empty and is created when you save; a file whose folder does not exist is refused. A folder that is already a project is selected, and a folder outside your projects asks "Add /srv/other on prod-1 as a project?" first.

`--remote` takes `ssh+` and a saved host's name, its ssh alias or `user@host[:port]`, ignoring case, or `wsl+` and a distro's name, with absolute paths as the host names them. It never connects a host you have not saved: an unknown name opens the Connect dialog with the name typed in. `damocles --help` lists the options, `damocles --version` prints the version, and `damocles` alone starts or shows the app, passing on any switch it does not know, such as `--ozone-platform=wayland`, with a warning. With `--wait` the command also returns, with an error, if Damocles quits or crashes before the tabs close.

In a terminal Damocles opens on a host, `damocles` is already on `PATH` and opens in Damocles on your computer, so `GIT_EDITOR="damocles --wait" git commit` edits the message in a tab. It works while your computer is connected to that host and otherwise says "damocles: Damocles is not connected to this host." In a WSL shell on this computer, which finds the command through your Windows `Path`, `damocles .` opens the folder in that distro. On a host, only the terminals you open get the command; the agent's shell commands, hooks and MCP servers do not, so the agent never opens editors on your screen from there. On this computer and in WSL the command is on your own `PATH`, as VS Code's `code` is, so every program you run there finds it, the agent's shell commands included.

### Putting the command on PATH

On this computer, the command needs its folder on `PATH`:

- **Windows:** the installer adds `<install folder>\resources\bin` to your user `Path`, and uninstalling removes only that entry. Shell Command: Remove 'damocles' command from PATH, in the command palette and the Help menu, takes it out, and updates then leave your `Path` alone; Shell Command: Add 'damocles' command to PATH puts it back. Terminals opened afterwards see the change.
- **macOS:** Shell Command: Install 'damocles' command in PATH, in the command palette and the app menu, links `/usr/local/bin/damocles` to the app, asking for an administrator password when that folder is not writable. Shell Command: Uninstall 'damocles' command from PATH removes the link only when it points into Damocles.
- **Linux:** the deb and rpm packages install `/usr/bin/damocles` as an alternative, and removing the package removes it.

## Links from a host's terminals

A program in a host's terminal that opens a web page, such as `gh auth login` or `xdg-open`, sends the address to your computer through `BROWSER`. Damocles shows a notice, "prod-1 wants to open", with the whole address in a fixed-width font and its host in bold, so a look-alike address stands out. **Open** opens it in your browser and **Copy** copies it; Escape dismisses it without opening. Settings › Remote hosts › "Open links from the host's terminals without asking" skips the notice for that host's terminals. A page the agent opens on its own always asks, whatever that switch says. A link you click yourself, in a host's terminal, a remote chat or an editor tab of a remote file, opens without asking.

Only `http` and `https` addresses of at most 8 KiB open. An address on the host's `localhost` with a port is forwarded to this computer first and opens on the forwarded port, and so is such an address inside the query, as an OAuth `redirect_uri` is. A `redirect_uri` keeps its port, because the sign-in server compares it exactly, so it needs the same port free here; otherwise the link fails with "Port 8085 is in use on this computer. Free it and try again."

## Limitations

- A model provider you set up at a localhost address on your computer cannot be reached from a remote chat, and the model picker marks it "Not reachable from {host}". A provider on your local network works only when the host is on that network too.
- An MCP server configured on the host whose sign-in tokens Damocles keeps on your computer works while the app is closed only until the host's Damocles server stops. Servers that need no sign-in run there with the app closed without that limit.
- The agent's browser tools, your global memories and your personal MCP servers run on your computer, so a remote chat cannot use them while Damocles is closed. Memories the agent saves meanwhile wait on the host.
- Dev container configurations that use Docker Compose cannot be opened in a container yet.
- WSL distros on a Windows machine you reach over SSH are not supported.
