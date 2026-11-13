# Git hosting accounts

The desktop app signs in to GitHub and GitLab servers, picks the account each project uses and gives git its credentials from that account. This page covers the accounts, adding servers, signing in and out, the account a project uses, git credentials, the agent's shells and registering an OAuth app on your own server. The VS Code extension has no Git hosting accounts.

## Where accounts are kept

Accounts live on this computer only. Damocles Core on this computer holds every token; it keeps them in the desktop secret store (`safeStorage`), and the server and account lists in `<userData>/forge/` (`servers.json`, `accounts.json`, `bindings.json`, readable by your user only). Refresh tokens and client secrets never leave this computer. Git on a remote host gets an access token as the answer to one credential request at a time, and the host's Damocles server keeps it in memory for 8 hours after that answer, only to mask it in what the agent reads. In a remote chat's settings the Git hosting group shows on the User tab only.

Tokens go only to the server they belong to. Damocles never puts a token in an environment variable, a command line, a git remote URL, a log or a chat; git gets one only as the answer to its credential request.

## Servers

Settings › Models & accounts › Git hosting lists github.com and gitlab.com, then the servers you added. Add server takes:

- **Server URL**: `https://` and the server's address, for example `https://gitlab.indigital.gr`. A GitLab server may sit under a path such as `https://example.com/gitlab`. Damocles refuses plain `http://`, a user name or password, and a query or fragment in the address, and says what to change.
- **Kind**: GitHub (GitHub Enterprise Server, or a `<tenant>.ghe.com` tenant) or GitLab (self-managed).
- **OAuth app client id (optional)**: the Application ID of an OAuth app you registered on that server, which turns on Browser and Device code sign-in. Without it, the server offers token sign-in only.
- **Client secret** (GitHub servers): the OAuth app's secret, which browser sign-in needs. It is kept in the encrypted secret store, never in `servers.json`. Changing the client id in Edit server without entering a new secret removes the stored one, since it belongs to the other app. The field is emptied each time you save, so after a save Damocles refuses, enter the secret again.
- **Other git hosts (optional)**: hosts your repositories use when they differ from the web address, such as `git.indigital.gr`. A host you type here applies at once.

When you sign in to a server you added, Damocles reads the clone addresses of one of your projects there. A host they name that is not yet one of the server's git hosts, and that no other server in the list uses, waits in Edit server, under Hosts found in clone addresses, for you to confirm it. Until you confirm it, Damocles does not answer git's credential requests for that host and does not match remotes on it to the server. Confirm adds it to Other git hosts; Dismiss drops it, and Damocles does not propose it again.

A self-managed GitLab shows its version beside its name. Damocles supports GitLab 16.1 and later, and refuses a sign-in by any route to an older one. Device code sign-in on a self-managed GitLab needs GitLab 17.1 or later; on an older server Damocles says the server does not offer it.

## Signing in

Add account on a server opens the sign-in panel with three routes:

- **Browser**: Damocles opens your system browser on the server's sign-in page and receives the result on a free port of this computer (`127.0.0.1`). GitHub asks which account to use, so a second account on the same server is a second sign-in.
- **Device code**: Damocles shows a code, copies it and opens the server's device page, where you enter it. The panel counts down until the code expires.
- **Token**: Open the token page creates a personal access token with the scopes shown, then paste it into the Personal access token field. GitLab needs the `api` scope (a group or project access token also needs `write_repository`); a classic GitHub token needs `repo`. A token without them is refused with the scope it lacks. With a token, "Agent shells may use this account" starts off, because the agent could read the token.

Browser and device sign-ins on github.com and gitlab.com need the OAuth apps a Damocles release carries. A build without them offers token sign-in only, and says so on the disabled options. A build with the GitHub client id but not its secret offers device code and token sign-in on github.com, and the Browser option says the secret is missing.

Tokens from Browser and Device code expire (GitHub after 8 hours, GitLab after 2 hours) and Damocles refreshes them shortly before. If a server refuses the refresh, the account shows Sign in again.

## Managing an account

Manage on an account line shows when you signed in, the "Agent shells may use this account" switch, Sign in again, and Sign out. Sign in again, and Add account signing in as an account you already have, keep the switch as you set it. Sign out asks first and says how many projects use the account and of how many remote hosts it is the default account. It revokes the token on the server, then removes the token, the account and those choices from this computer. When the server cannot revoke the token (a personal access token, or a server that refuses), Damocles still signs out and shows a notice with a link to the page where you revoke it yourself. When Damocles cannot save a sign-out or the switch (for example when `accounts.json` does not parse), Manage says why, and the switch shows the saved value again.

GitHub organizations can keep a token out:

- **"Authorize Damocles for <org>"**: the organization uses SAML single sign-on. The action opens GitHub's page to authorize the token for it.
- **"<org> has not approved Damocles"**: the organization restricts OAuth apps. The action opens the app's page on GitHub, where you can request approval from an owner.

Damocles checks this when you sign in and when Settings opens, at most once an hour. `damocles.desktop.forge.showAvatars` (on by default) turns account pictures off, so no picture host such as Gravatar is asked for one.

## The account a project uses

Each project uses one account per server, shown by the account chip in the Source Control header. Damocles picks it in this order:

1. The account you chose for the project.
2. The host's default account, for a project on a remote host (see "Default accounts on a remote host").
3. Your only account on that server.
4. The user name in the remote's URL, such as `https://alice@gitlab.com/...`, or git's `credential.username` for that URL. Placeholder names such as `oauth2`, `git` and `x-access-token` do not count.
5. The one account that can push to the repository, else the one that can read it. Damocles asks each account's own server, all at once, and remembers the answers for an hour.
6. You choose.

The chip marks an account Damocles picked as "auto". Where the header has no room for "Choose account", "Sign in" or "Git's own credentials" whole, the chip shows only its icon, and its tooltip names the state. Its menu lists the server's accounts with their push access, or "SSO required" and "not approved by the organization" for an account a GitHub organization refuses, "Use Git's own credentials", "Sign in to <server>…" and "Open Git hosting settings". Only an account you choose is saved; an automatic pick is worked out again each time, so it follows your accounts and access. A project with no remote, or whose remotes are all on servers Damocles does not know, shows no chip. When Damocles cannot reach a server to check access, Source Control says so with Try again, except for an account that must sign in again, which the chip already shows.

Remotes are matched by host and path. An SSH alias from your `~/.ssh/config`, such as `git@gl-work:grp/proj.git` or `git@github_work:team/app.git` where the alias stands for gitlab.com or github.com, is resolved with the SSH command git itself uses for the repository (`GIT_SSH_COMMAND`, else the repository's `core.sshCommand`, else `GIT_SSH`, else `ssh`), asked with `-G`, which reads your SSH configuration and connects nowhere. A command that does not take `-G`, such as PuTTY's plink, leaves the remote matched to no server. This runs only in a trusted project, and for a remote project on the host itself. Two GitLab servers on one host under different paths, such as `https://example.com/a` and `https://example.com/b`, are told apart by the path. On a separate git host, such as `https://git.example.com/team/app.git` for a server at `https://example.com/gitlab`, the path may leave the server's path out.

### Asked once

When nothing above decides, Damocles asks once when you start your own Push, Pull, Fetch, Publish Branch or Clone, before git runs, and never for the agent's git or autofetch. If the access check finds exactly one account that can push within a second, Damocles uses it without asking. The dialog lists each account with its push access ("owner" or "admin" on the best match; "SSO required" or "not approved by the organization" for an account a GitHub organization refuses), "Use Git's own credentials" and "Sign in with another account…". Digits 1 to 4 pick a row, arrows move, Enter confirms. Escape, a click outside and "Sign in with another account…" cancel, and the git operation does not run. Your choice is saved for the project; for a clone, it is saved for the new project once you add it.

### Use Git's own credentials

"Use Git's own credentials" tells Damocles to stay out of that project and server: git keeps using your credential manager, SSH keys or whatever else you set up. Choose it in the chip's menu or the dialog. On a server with no account, it also takes that server off the project's chip, and the chip goes once no server is left on it.

### Default accounts on a remote host

Settings › Remote hosts › Default accounts on <host> sets, per server, the account that projects on that host use unless you chose another for a project. A project's own choice wins. The defaults stay on this computer, like every account choice.

### Where choices are kept and forgotten

Choices and host defaults are kept in `<userData>/forge/bindings.json` on this computer only. Removing a project forgets its choices, Forget host forgets that host's defaults and the choices of its projects (while the engine is stopped, the next time it starts), and signing out forgets every choice and default that names the account.

## Git credentials

For every server where you have an account, git gets its credentials from the account the project uses: Source Control's push, pull, fetch and clone, autofetch, your integrated terminals and the agent's shells, on this computer and on remote hosts. Damocles does this for each git call and each terminal it starts, through git's own configuration variables; it never writes your `.gitconfig`. For those servers only Damocles' helper answers, so your own credential manager is not asked and stores nothing. Every other server keeps your own credential helpers, SSH keys and settings.

- **GitLab** gets the user name `oauth2` for an account signed in with the browser or a device code, and your login for a personal access token. GitHub gets your login.
- **Git LFS** uses the same account, since it asks git for credentials.
- **`git credential fill`** in a terminal prints the account's access token. The refresh token never leaves Damocles.
- **In a terminal**, `git config --get-urlmatch credential.helper <server URL>` names only Damocles' helper. A terminal keeps the servers it started with; open a new one after you sign in to another server.
- **Projects with no chosen account**: your own Push, Pull, Fetch and Clone, and git in a terminal, ask once which account to use. Autofetch never asks: your own credential helpers answer it.
- **A revoked token**: when the server refuses a token, Damocles checks it, and refreshes a browser or device code sign-in, so the next try works. When the refresh is refused too, or a personal access token was revoked, the account shows Sign in again.
- **While Damocles Core restarts**, which takes seconds, git in a terminal or an agent shell fails with "Damocles could not provide credentials." for those servers. It does not fall back to your own helpers then.

### Use Git's own credentials with accounts

"Use Git's own credentials" hands the project back to your own setup: Damocles asks your credential helpers itself and passes their answer to git, so a terminal opened earlier follows the change at its next push. Your credential manager stores and erases its own credentials. For the agent's git it asks only the helpers in your system and global git config, never one a repository's own config names, since the agent can write that config; the password it gets is hidden as `***` in what the agent sees.

## The agent's shells

"Agent shells may use this account", under Manage on each account, decides whether git in the agent's Bash and PowerShell may use that account. It starts off for a personal access token. With it off, the agent's git for that server fails with a message that names the switch, nothing asks you, and the chat shows a notice under the shell command with Choose account and Open Git hosting settings. A refusal of a shell the transcript shows no card for (a subagent's or team member's) shows the notice above the message box instead, once per server and reason, with Dismiss. With it on, the agent's git works like yours.

Damocles never hands the agent's git your own credential manager in place of a refused account: an agent shell whose account's switch is off, or for which no account is chosen, is refused. The agent's git reaches your own helpers only when the project uses "Use Git's own credentials" or the server has no account left.

Tokens are masked in what the agent reads. A token Damocles holds, or one it gave git in the last 8 hours, shows as `***` in every tool result (shell output, file reads, MCP results) and in the output shown while a command runs, also in its base64 form as an HTTP header carries it. The model, the transcript, memory, hooks and subagents see `***`. Images in a result, such as a browser screenshot, are not read for tokens.

### The agent's GitHub and GitLab tools

Besides git, the agent has tools that read CI pipelines and job logs, merge and pull requests and issues of the chat's project, and that retry or cancel a job, open a merge request or comment, through the project's account, with no token in its shell. They are described in [Tools](tools.md#github-and-gitlab-desktop) and their permissions in [Permissions](permissions.md#github-and-gitlab-tools). They use the account the project uses here, and never ask which: when none is settled, the call fails and the chat's notice offers Choose account. They do not depend on "Agent shells may use this account", which covers only git in the agent's shells. They act on the repository the project's git remotes name, so a command or edit that changes a remote changes where they act; each write's prompt names the server, project and account again, and a write whose repository, account, branch or text changed after you approved it sends nothing. A remote names its repository by its fetch address, else by its push address when the fetch address is on no GitHub or GitLab server Damocles knows. When a remote fetches one repository and pushes to your fork of it on the same server, opening a merge request opens one from the fork's branch into the repository it fetches, as Publish's Open Pull Request does after a fork.

### What the switch does not protect

The switch and the masking are a guard, not a sandbox. Any program running as you can get around them: it can read another process's environment, ask your operating system's credential manager, or ask the system to decrypt Damocles' secret store. With the switch on, an agent's command can still get the access token, for example by encoding it so the masking misses it, and use it until it expires (8 hours on GitHub, 2 hours on GitLab). Turn the switch on only for accounts you would let the agent use, and prefer an account with the least access it needs.

## CI

With an account on a repository's server, Source Control shows a CI chip between the branch and the sync button, for the repository of the remote the current branch tracks (else `origin`, else the first remote on a server where you have an account): on GitLab the pipeline of the branch (the project's own open merge request's pipeline when there is one, else the newest of the branch and of its tags at HEAD), on GitHub the checks of the commit at HEAD (else of the branch's newest run): every workflow run there, other apps' checks and the commit's statuses. It shows running with a count of jobs done, passed, failed with the number of failed jobs, or canceled. On GitHub the checks fail when any check failed, even when a newer workflow passed. When the pipeline shown is of another commit than HEAD (an unpushed commit has none of its own), the job list shows that commit's short hash and the chip's tooltip names it. A repository with no pipeline, no account on its server, or "Use Git's own credentials" shows no chip.

Click the chip, or run Source Control: Show Pipeline, for the job list: jobs grouped by stage, each with Retry or Cancel and Open log, and Retry or Cancel for the whole pipeline. A manual job that waits and a skipped job show no Retry, and a job the pipeline lets fail shows a warning and does not count as failed. On GitHub the jobs are grouped by workflow: a workflow's heading has Retry failed jobs once its run has finished and Cancel while it runs, a finished job has Retry, and other apps' checks and statuses, listed under Other checks, have no action and no log. A list longer than Damocles reads (10 pages) says it is cut. Open pipeline on <server> (on GitHub, Open checks on <server>) opens the server's page in your browser.

Open log shows a job's log in an editor tab with its colors, sections you can fold (a section GitLab marks collapsed starts folded), section durations, line numbers and a timestamp column, and Find (Ctrl+F) searches folded sections and the line still being written too. Find highlights and counts up to 10,000 matches (a count past that reads 10,000+), and its next and previous match go past them to every match in the log. GitHub's error, warning and notice lines are named and colored as such, and a text direction character shows as its name in a small box, so a line cannot read in another order than it was written. While the job runs, new lines arrive every few seconds, the last one shown even before its line is complete. GitHub serves a job's log only once the job finishes, so a running GitHub job shows its steps until then. A log longer than 16 MiB shows its last 16 MiB. GitLab serves a running log whole each time it changes, so a very long running log is slow to follow. A token Damocles holds shows as `***` in the log, and the last characters of a running log appear with the next lines, so a token split between two reads is still hidden. When you retry a GitHub job, its tab follows the new attempt once GitHub lists it. When a later read of the log fails, the tab keeps the log it has, with its folds and Find, and says why above it, with Try again. The tab shows the pipeline number on GitLab and the workflow on GitHub. A job's log tab closes with its repository, and an engine restart closes the log tabs of this computer's repositories, which open again with it.

Commit details show the commit's pipeline status, which opens the pipeline on the server.

Damocles reads CI only while Source Control shows the repository and the window has focus, and a log only while its tab shows: the status every 15 seconds while a pipeline runs and every 60 seconds otherwise, a running log every 3 seconds. A log that cannot be read is read twice as late each time, up to once a minute, and a finished job's log that the server keeps refusing is read no more. It asks with ETags, so an unchanged answer costs GitHub's rate limit nothing, and when a server limits requests it waits until the limit resets and the chip says why. Turn CI off with `damocles.desktop.forge.ciStatus`: no chip, no job list, no status in commit details, an open log tab says CI status is off, and nothing is read.

## Links to a file or commit

Copy Permalink and Open File on Server work on the editor's file, from its menu and the palette; Open Commit on Server works on a Graph commit and, from the palette, on HEAD; the blame card's Open Commit on Server opens the commit of that line. The editor's menu, the Graph's commit menu and the blame card offer them only for a repository with a remote on a server where you have an account. A file link points at the commit, not the branch, so it keeps showing the same lines after the branch moves:

- GitHub: `https://github.com/<owner>/<repo>/blob/<commit>/<path>#L3-L7`, and `/commit/<commit>` for a commit. A file GitHub shows rendered, such as Markdown or a notebook, gets `?plain=1` before the lines, so the link opens its source with the lines marked, as GitHub's own Copy permalink does.
- GitLab: `https://gitlab.example.com/<group>/<project>/-/blob/<commit>/<path>#L3-7`, and `/-/commit/<commit>`.

The lines are your selection, and the cursor's line when nothing is selected (`#L3`). Copy Permalink puts the link on the clipboard, and the other two open it in your browser. Damocles builds links only for a repository whose remote is on a server where you have an account (the remote the current branch tracks, else `origin`, else the first such remote), and only on that server's own address. In a fork clone that is your fork, where your pushed commits are.

Before it links, Damocles checks that the commit is on a branch of that remote, as of your last fetch. A commit that is not shows a warning and opens nothing. When pushing the current branch would publish it, the warning offers Push, and the link opens or is copied once the push lands; otherwise push the branch that holds the commit and run the command again. A file with uncommitted changes, or with edits in the editor that are not saved, still gets its link, with a warning that its lines may not match. On a remote host the check runs on the host; a host whose Damocles server is older than this version makes the link without the check.

## History details

With an account on a repository's server, the Graph, commit details and blame show more of each commit. They come from the repository the history belongs to: the `upstream` remote's, else `origin`'s, else the first remote on a server where you have an account. In a fork clone, where `origin` is your fork and `upstream` the repository you forked, issue numbers, the merged change and pictures are those of the upstream repository.

- **Author pictures.** Each Graph row shows the author's picture before the name, and so do an expanded commit, the blame card and the inline blame annotation. Until the picture arrives, and for an author with none, you see the initial. On GitHub Damocles finds pictures through the author's no-reply address, the repository's assignable users and, for the rest of a page, one question about its commits, asked about each author's oldest commit on the page, which is the likeliest to be pushed; on GitLab it asks the server for each author's email. Each page of history is asked about once, after it shows, and the answers are kept while Damocles runs, so history never waits for pictures. An author who got no picture, or whose picture would not load, is asked about once more on a later page. A picture on another site, such as Gravatar or `avatars.githubusercontent.com`, is fetched without your token. Only PNG, JPEG, GIF and WebP pictures of at most 512 KiB show. A GitHub Enterprise Server that serves pictures from a host of their own (subdomain isolation, `avatars.<host>`) on a private network shows initials only, because Damocles fetches no picture from a private address other than the server's own.
- **Links.** `#123`, `GH-123` (GitHub), `!45` (GitLab merge requests) and `owner/repo#12` in a commit message or a blame summary open the issue, merge request or pull request on the repository's server in your browser. GitHub opens `#123` as an issue page, which takes you to the pull request when the number is one. A reference links by how it is written: Damocles does not ask the server whether the issue or project exists, so a page that does not exist is the server's own "not found". A message links its first 200 references; the rest stay text.
- **The merged change.** An expanded commit, and the blame card, name the merge request or pull request that merged the commit ("Merged in !45", on GitHub "Merged in #12"), next to its pipeline. An open one is not shown.

Turn pictures off with `damocles.desktop.forge.showAvatars`: no pictures anywhere and nothing is asked for them, which also keeps a Gravatar picture from telling that site an author's email hash. Links and the merged change stay.

## Clone from your repositories

Git: Clone from Your Repositories... (the palette, the File menu and Source Control's Clone) lists the repositories of every account, one section per account, each loading on its own. With an account, Git: Clone and Git: Clone (Recursive) open the same list. Before you type, GitLab sections show the 30 projects you are a member of with the most recent activity. Type to search: GitHub sections search your 100 most recently updated repositories and GitHub's search of your own repositories by name (type `owner/name` to search another owner's); when GitHub limits its search, the section still shows your recent repositories that match. GitLab sections search the projects you are a member of, 30 at a time, by name and namespace. An account with no repositories says so in its section. A server that does not answer shows "<server> did not answer. Try again" in its section, and the other sections stay usable. If Damocles could not read your accounts, the picker says so and offers Try again; a pasted URL still works.

Press Enter on a repository to clone it: Damocles says which account it uses, asks for a folder and clones, with no account question, and the new project keeps using that account. An account that must sign in again does not clone until you sign in again. `damocles.desktop.forge.cloneProtocol` chooses https (the default: git signs in with the account) or ssh (git uses your own SSH keys, and the new project still uses the account for its other work on that server); the picker's hint and the message after Enter say which. Escape closes the picker at any time; once it is closed, nothing is cloned. A pasted URL becomes one "Clone from URL" row, and a command copied from a README (`git clone <url>`) or a local folder path with spaces works too. On a server where you have one account the row names it, and the URL clones and binds the same way; on a server where you have several, or whose one account must sign in again, the clone picks its account as Git: Clone does and may ask once; any other URL clones as Git: Clone does. Damocles clones only from the account's own server and its git hosts, whatever a listing names; a repository whose address points elsewhere does not clone.

## Publish to GitHub or GitLab

Publish Branch... (Source Control's menu and the palette) on a repository with no remote opens the Publish dialog while you have an account; without one it says the repository has no remote. The dialog opens at once. Owner lists each account's own namespace right away, then loads the places each account can create repositories, each account on its own: on GitHub your organizations, on GitLab the groups, nested ones included, where you may create projects. While an account's list loads, its group in Owner says so, and Name, Visibility and your own namespaces stay usable. A list that fails to load says why, with Try again, and its account's own namespace stays available. When an account has more than 1,000 organizations or groups, the hint says only the first ones are offered. Closing the dialog stops every list still loading. Name starts as the folder's name; spaces and other characters a repository name cannot hold become dashes. Visibility is Private, Public, or Internal on GitLab and on a GitHub Enterprise Server organization. Publish creates the repository, adds it as `origin`, pushes the current branch as that account, and the project then uses that account on that server. A name the server refuses, for example one that is taken, shakes the field and shows the server's reason; change it and publish again. Cancel works until the push starts; a repository the server already created stays there, and Damocles says so. A click outside the dialog does not close it while you fill it in or while it runs. If the repository got a remote or closed since the dialog opened, Publish creates nothing and says the repository changed. When the server creates the repository but gives no address Damocles can add as `origin`, Create shows as done and the next step says the repository exists on the server. `damocles.desktop.forge.cloneProtocol` decides whether `origin` is the https or the ssh address.

## Fork when you cannot push

When a push to a GitHub or GitLab server is refused for permission (HTTP 403, or the server's own "permission denied" or "not allowed to push"; an SSH key the server refused is not this), and the server does not protect the branch for your account (see [Protected branches](#protected-branches)), Damocles asks the server whether the account can push to that repository. A rejection because the remote has commits you lack never leads here. When the server says the account can read the repository but not push to it, a dialog names the account and the branch and offers Fork and Push: Damocles forks the repository to your account and waits while the server copies it (it gives up after 2 minutes), renames `origin` to `upstream`, adds your fork as `origin` and pushes the branch there. If you already have a remote named `upstream`, the original becomes `upstream-2` and the dialog says so. If your remotes changed since the dialog opened, nothing is forked; push again to start over. Cancel works until the push starts and leaves your remotes exactly as they were, as does a step that fails before the push, a failure to save which account the project uses included; once the server has made the fork, it stays there and Damocles says so. If the push itself fails, `origin` stays your fork and `upstream` the original, so you can push again. When it is done, Open Merge Request (Open Pull Request on GitHub) opens the server's page for a new one from your fork's branch, with the repository's template filled in (`pull_request_template.md` and the other names GitHub reads, or GitLab's `.gitlab/merge_request_templates/Default.md`). A GitHub organization that requires single sign-on shows "Authorize Damocles for <organization>" instead of the fork. Damocles adds a remote only when its address is on the account's own server.

## Protected branches

Before a commit to a branch the server protects, Source Control asks the question it asks for the branches in Protected branches (`damocles.desktop.git.branchProtection`): Commit to a New Branch, which asks for a name and commits there, or Commit Anyway. `damocles.desktop.git.branchProtectionPrompt` decides whether it asks, as it does for that setting.

Damocles reads the rules through the account the project uses, on the server the branch's upstream remote pushes to, and matches them against the upstream branch's name there (a local `feature` that tracks `origin/main` is asked about as `main`); Protected branches matches your local branch's name:

- GitHub: the repository's active rulesets that require a pull request, the organization's included, and the protected branches whose branch protection rule does not let your account push. A ruleset that only blocks force pushes or deletion does not count, and an administrator a rule does not include can push past it. A ruleset aimed at the default branch or at every branch follows it. Branch patterns read as GitHub reads them: `*` stops at `/`, and `**/` spans folders. An account that cannot write to the repository gets no rules.
- GitLab: the protected branches whose "Allowed to push" leaves you out, by your role in the project or your own name. Your role counts every way you have access, a group the project is shared with included. An entry that allows a group or a deploy key does not count as yours. An account that cannot push to the project at all (a Reporter or a Guest) gets no rules, so a refused push offers the fork instead. A self-managed GitLab older than 16.9 gives no rules.

Damocles reads them in the background when a repository opens and keeps them for 30 minutes, after which the next commit reads them again in the background. A commit never waits for the server: with no rules read yet it goes on without asking, and while the server does not answer it uses the rules it last read. A branch with no upstream, and a project on "Use Git's own credentials", get no server rules. Turn this off with `damocles.desktop.forge.branchProtection`; Protected branches still asks. On a remote host the rules come from this computer and the commit runs on the host; a host whose Damocles server is older than this version asks only by Protected branches.

### A push to a protected branch

When the server refuses a push of a branch (Push, Push to..., Push (Follow Tags), Sync's push, Publish Branch to an existing remote), Damocles checks the server's rules for that branch and the account the push used. The rules come from the ones above when they were read in the last 30 minutes; otherwise Damocles reads them once, then decides. Git's message alone never decides. When the server protects the branch for your account, a dialog says "<branch> is protected on <server>", names the account, and explains that the server takes changes to it only through a pull request (GitHub) or a merge request (GitLab). When your branch has commits the server's branch lacks, it says how many: they will be on the new branch too, and your local branch stays as it is.

Push to a New Branch asks for a name, starting with `<your login>/<branch>` (or the next free one, such as `<your login>/<branch>-2`). The name must be one git accepts, and no local branch or branch on the remote (as last fetched) may have it or sit in its way; where git ignores letter case (`core.ignorecase`, as on Windows and macOS), `Main` and `main` count as the same name. Damocles creates the branch at the commit your branch holds, switches to it, and pushes it to the same remote with its upstream set. The push only creates the branch: if the server already has a branch of that name, the server refuses the push and nothing there changes. Your local protected branch is never moved or reset. When the push is done, Open Pull Request (Open Merge Request on GitLab) opens the server's page for a new one from the new branch into the protected branch, with the repository's template filled in. Cancel leaves everything as it was and says the push was not sent. If something switched your repository to another branch while the dialog was open, Damocles creates nothing and says so.

A refusal for a branch the server does not protect for your account leads to the fork offer for a repository you cannot push to, or else to git's message. A rejection because the remote has commits you lack, and Push Tags, never show this dialog. With `damocles.desktop.forge.branchProtection` off, a refused push is not checked against the server's rules. On a remote host, git runs on the host and the rules and the create page come from this computer; a host whose Damocles server is older than this version shows git's message.

## Settings

Settings › Models & accounts › Git hosting, after the servers and Add server, holds the Git hosting settings on the User tab. They apply to this computer's whole app.

- **Agent's GitHub and GitLab tools** (`damocles.desktop.forge.agentTools`): the same switch as the GitHub and GitLab group in the chat's Tools panel; both show the tool status Damocles Core reports.
- **Agent reads any repository** (`damocles.desktop.forge.agentReadAnyRepository`, off by default, shown while the agent's tools are on): lets the agent's read tools target any repository your account can see on the project's server. Writes stay limited to the project's own repositories.
- **CI status** (`damocles.desktop.forge.ciStatus`): the CI chip and the commit status in history.
- **Server branch protection** (`damocles.desktop.forge.branchProtection`): the server's rules for commits and refused pushes, described above.
- **Clone and publish over** (`damocles.desktop.forge.cloneProtocol`, HTTPS or SSH): the address Clone from Your Repositories and Publish give the new remote.
- **Account pictures** (`damocles.desktop.forge.showAvatars`).

## Registering an OAuth app on your own server

Browser and Device code sign-in on a GitHub Enterprise Server, a ghe.com tenant or a self-managed GitLab need an OAuth app registered on that server. The server form shows the Redirect URI to register, `http://127.0.0.1/callback`, with Copy. It names no port: each browser sign-in receives the result on a free port of this computer, and GitHub and GitLab accept any port for a `127.0.0.1` redirect URI (RFC 8252 section 7.3).

- **GitLab**: User settings (or Admin › Applications) › Add new application.
  1. Paste the Redirect URI Damocles shows.
  2. Untick Confidential.
  3. Tick `api` and `write_repository`.
  4. Save.
  5. Copy the Application ID into "OAuth app client id".
- **GitHub Enterprise Server or ghe.com**: Settings › Developer settings › OAuth Apps › New. Paste the callback URL Damocles shows, then tick "Enable Device Flow" (client id only) or generate a client secret (browser sign-in), and enter them.

## Building Damocles with OAuth apps

The built-in apps come from build-time variables of the desktop build: `DAMOCLES_FORGE_GITHUB_CLIENT_ID`, `DAMOCLES_FORGE_GITHUB_CLIENT_SECRET` and `DAMOCLES_FORGE_GITLAB_CLIENT_ID`. Set them in the shell before `npm run build:desktop` to test real sign-in. The release workflow reads the two client ids from repository variables and the client secret from a repository secret (`docs/release.md`).

- **github.com**: an OAuth App with device flow on, expiring user tokens, and the callback URL `http://127.0.0.1/callback`. A GitHub client id without the secret gives device code sign-in only.
- **gitlab.com**: an application that is not confidential, with scopes `api` and `write_repository`, the device authorization grant allowed, and the redirect URI `http://127.0.0.1/callback`.

The build fails when the GitHub client secret is set without the GitHub client id, or when a value holds a character other than letters, digits, `.`, `_` or `-`.
