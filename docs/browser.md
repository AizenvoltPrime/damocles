# Damocles browser

This page covers the integrated browser: how its pages open in VS Code and the desktop app, the tools the agent gets, how credentials and dialogs are handled, and its known limits.

The browser is enabled by default; turn it off in Settings › Tools & integrations or via `damocles.browser.enabled`.

## Pages and tabs

In VS Code every open page is its own editor tab with its own toolbar (back, forward, reload, URL bar, element picker, DevTools, new tab), so you can split or drag browser tabs like any other editor and both panes keep rendering live.

In the desktop app a conversation's pages open as tabs in the editor pane, with the same toolbar: a page opens without taking the cursor out of the message box, selecting another conversation swaps in its pages, View › New Browser Page opens another, and pages come back after a restart. A conversation with open pages stays loaded, and deleting the conversation closes its pages.

Each tab shows the live title and favicon. A self-healing screencast watchdog recovers a stalled view, and if Chrome exits unexpectedly the browser tabs close with a notification. Pages a site opens itself, `window.open` and `target="_blank"` links, are captured as tabs.

## Engine

The browser runs on **Patchright**, a stealth-hardened Chromium/Playwright engine that never calls `Runtime.enable` (the biggest CDP automation tell), scrubs the automation user-agent, and drives interactions through Playwright locators, so bot-protected pages load normally.

## Agent tools

The agent gets a full tool set for navigation, interaction (click, type, fill, select, hover, drag, upload), and reading (screenshot, DOM query, snapshot, evaluate), plus multi-tab control (`BrowserTabs` for list/open/switch/close), file downloads (`BrowserDownloads`), and request interception/mocking (`BrowserIntercept`).

No page in the agent's browser ever opens from disk. `BrowserOpen`, `BrowserNavigate` and `BrowserTabs` (a new tab) of a `file://` address, a Windows path (`C:\...`, `\\server\share\...`) or `view-source:` of one, inside the chat's project (a worktree chat's working folder) or its design folder, load the file from a local http server Damocles runs for that folder, in the desktop app and in VS Code. A project's pages work as on a dev server: relative links, module scripts and `fetch` of the project's files work, and in an untrusted project the pages run no scripts. A design's pages load their own styles, images and fonts, run scripts (their own and inline ones) only when the design is interactive, and never fetch, open a socket, frame another page or start a worker. A folder address (`file:///home/you/app/` or `file:///home/you/app/docs/`) opens that folder's `index.html`, and the address's query and `#fragment` reach the page. The agent still sees the `file://` address in every answer. Files and folders whose names start with a dot, keys, certificates and 8.3 short names are never served. A file outside those folders asks you first, on an approval card that names the file and the folder Damocles would serve and says that the page can read every file in that folder and its subfolders. Approving it serves that folder to this chat until the chat closes, with the same rules as the project: dot files, keys and certificates are never served, no link leads out of the folder, and its pages run no scripts unless you trusted that exact folder in the desktop app. Later pages in that folder open without asking; another chat asks again; nothing is kept after a restart, so a tab of such a folder is not reopened. Rules decide the card as they decide other asks: a deny rule naming the tool blocks the page, an allow rule naming the tool and YOLO open it without asking and serve its folder, plan mode asks, and a `Read` deny or ask rule covering the page decides too. Damocles never serves a drive, share or file system root, your home folder or a folder holding it, or a hidden folder such as `~/.ssh` or `~/.damocles`, and refuses such a page without asking, telling the agent to move it into a subfolder; one chat is served at most 8 such folders. A project file is refused while Damocles has no server for the chat's project (the chat opened before its project, or the project was removed). A chat on a remote host follows the same rule (see [Remote development](remote-development.md#ports-and-the-browser)), except that its `BrowserTabs` opens no file page: open the tab, then `BrowserNavigate` to the file. Its folders outside the project are the host's, read on the host, and need a Damocles app and server that both serve them; with an older one the page is refused.

Every chat reaches its folders' server on an address of its own, `http://<random>.localhost:<port>`, with a cookie only that address gets, although all your chats share one browser profile. So one chat's agent, or a page it opened, never opens another chat's project or design pages, while a page's own relative and `/`-rooted links work as on any site. Answers name the page by its `file://` address, and a page or address of another chat that turns up in an answer, such as a browser-wide `BrowserDownloads` list, is named "[a served page this chat cannot open]". In VS Code every chat shares the one set of browser tabs, so a chat can still read another chat's open tab.

The agent's `BrowserOpen`, `BrowserNavigate` and `BrowserTabs` open only `http://` and `https://` addresses and `about:blank`, the same addresses the address bar takes; a file address takes the route above. Anything else is refused before Chrome sees it, with a message naming the scheme: browser pages such as `chrome://settings` or `edge://`, other `about:` pages, `javascript:` (use `BrowserEvaluate` to run script), `data:`, `blob:`, `filesystem:`, `view-source:` of a web page (the agent reads a page's source with `BrowserEvaluate` or a snapshot), `devtools://`, extension pages and addresses that start another app.

An open or navigation reports its outcome as Playwright's `page.goto` does: a page that fails to load is a tool error naming Chromium's error, a page that loads with an HTTP error adds its status (`(HTTP 404)`), and an address that starts a download points to `BrowserDownloads`. Over Chromium's error page the address bar, the tab and the agent all show the address that failed.

**`BrowserRequestInput`** asks *you* to fill a form (login, MFA/OTP, payment) whose values are injected straight into the live page and are never seen by the model, logged, or persisted. Press Enter or click Submit.

The element picker attaches DOM/CSS/screenshot context to chat.

`BrowserConsole` reports what the page actually logged, captured by an in-page bridge, since the CDP console API is one of the automation tells Patchright disables. It also reports any `alert`/`confirm`/`prompt` Damocles auto-answered on the agent's behalf, so an accepted dialog is never silent.

## Tabs per agent

Each subagent and team agent drives its **own isolated tab** (the main agent and you share the primary one; in the desktop app each conversation has its own), so concurrent agents never clobber each other's page. `BrowserTabs` and `BrowserClose` only see the calling agent's tabs, and an agent's tabs close automatically when it succeeds but stay open after a failure so you can inspect the page.

## Credential redaction

Everything a page produces is **credential-redacted at capture**: values under credential-shaped keys and self-identifying token formats (JWT, `Bearer`, PEM keys, vendor-prefixed keys) never enter the transcript or the session file, and a picked password field is masked rather than attached.

## DevTools port

The DevTools port is off by default. `damocles.browser.devToolsPort` launches the browser with a DevTools debugging port, an unauthenticated loopback endpoint that any local process can attach to and drive the browser as you, with your logged-in profile. It exists only to power the toolbar's DevTools button, and a relaunch is required because it is a launch-time Chromium flag.

## Known limitation

Popup-based "Sign in with Google" / Apple / Microsoft windows attach as tabs but headless Chromium does not paint popup surfaces ([Chromium 696439](https://crbug.com/696439)), so there is nothing to click. Same-window OAuth that redirects the parent page is unaffected. For popup providers, sign in via your normal browser before bringing the URL into the panel.
