# Tools

This page covers the optional tool groups that are not covered elsewhere (web tools, image generation, and GitHub and GitLab), how deferred tool loading keeps unused tools out of the prompt, and the Tools panel.

The browser, Compass and MCP tools have their own pages: [Browser](browser.md), [Compass](compass.md) and [MCP servers](mcp.md).

## Order of tool calls in one reply

The agent can ask for several tool calls in one reply, and they usually run at the same time. When a reply holds an `Edit` or a `write`, all its calls run one after another in the order the agent wrote them, so a `read` or a test command after an edit sees the edited file. That includes foreground `Agent` calls: subagents started in the same reply as an `Edit` or `write` run one after another, not side by side.

A `read` never sees a file half written by Damocles' own file tools. For an existing file this holds against `Edit` and `write`: a `read` waits in a per-file queue until an `Edit` or `write` of that file in the same Damocles engine process has finished; `GenerateImage` creates its file atomically, so any reader sees no file or the whole image. It does not hold against MCP tools or shell commands: a shell command such as `cat` can still see a file an `Edit` or `write` is writing, and a `read` can see a file an MCP tool or a shell command is writing.

## Web tools

The web tools are opt-in: enable them via `damocles.pi.webSearch.enabled`. The toggle takes effect on the next turn with no install or reload.

Five native, **key-free** read-only tools:

- **WebSearch**: an answer with cited sources, with optional category / domain / publish-date filters via Exa's advanced search
- **WebFetch**: read a web page or PDF as markdown, with `raw` / `maxChars` / `includeLinks` / `includeImages` controls
- **CodeSearch**: search public source code and docs
- **FeedRead**: read an RSS 2.0 or Atom feed as markdown
- **YouTubeTranscript**: best-effort video transcript when captions are available, though YouTube may block it

WebSearch and CodeSearch are backed by Exa's free endpoint; no API key or config is required. WebFetch extracts HTML via Readability, reads PDFs inline, fetches a GitHub `blob` or `raw` page from `raw.githubusercontent.com`, and falls back to the `r.jina.ai` reader for JavaScript-heavy pages. Every outbound fetch is validated to block internal/loopback/cloud-metadata addresses.

WebFetch never contacts a host that a deny or ask `WebFetch(domain:<host>)` rule matches on a step it takes by itself ([Permissions](permissions.md)): with `raw.githubusercontent.com` matched it fetches the GitHub page as named, with `r.jina.ai` matched it returns the direct result without the reader, and a redirect to a matched host other than the URL's own stops, with the result naming the redirect's URL, which the agent can fetch as a call of its own that the rules judge. Allow rules change none of this, and ImportAsset's URL fetch stops at such a redirect the same way.

All five are read-only, available in plan mode and inherited by `tools: *` subagents. They start **deferred**: their schemas are not in the prompt until the agent loads them with `ToolSearch`, so a turn that never searches the web costs nothing for them. See [Deferred tool loading](#deferred-tool-loading).

## Image generation

An opt-in `GenerateImage` tool (`damocles.imageGeneration.enabled`, off by default and settable only in user settings) creates a new PNG, JPEG or WebP file at the path you approve from a text prompt. It uses an OpenRouter image model you pick in Settings (`damocles.imageGeneration.model`, also user settings only) and your OpenRouter key or sign-in, which you set under OpenRouter in Settings › Models & accounts. Only models whose cost pi can track are offered. The agent loads it with ToolSearch when it needs it.

It goes through the same permission gate as Write: it asks with the path, the prompt and the model in Default mode, runs without asking in Accept Edits, is blocked in Plan mode, never overwrites a file, and a rewind removes the image. The image appears at its path only once it is complete: any program reading the path sees no file or the whole image, never part of one. The cost OpenRouter billed counts in the status bar, the budget and `/stats`, under the image model. The generated image shows in the tool's overlay. Subagents and team agents do not get the tool.

## GitHub and GitLab (desktop)

With a GitHub or GitLab account signed in (Settings › Models & accounts › Git hosting, see [Git hosting accounts](git-hosting.md)), the agent can read and act on the chat project's repository through that account, instead of `gh`, `glab` or `curl` with git credentials:

| Tool | What it does |
| --- | --- |
| ForgePipelines | Lists the newest CI pipelines (GitHub: workflow runs) of the current branch, or of `branch` |
| ForgeJobs | Lists a pipeline's jobs, the latest attempt of each, up to 10 pages, saying when the list is cut |
| ForgeJobLog | Reads the last lines of a job's log, 200 at most, colors removed; `section` keeps only the sections whose name holds it. A GitHub job still running answers that its log is published when the job completes |
| ForgeMergeRequest, ForgeMergeRequests | Read one merge request (GitHub: pull request) with its latest comments (on GitHub its conversation comments, review comments not included), or list them |
| ForgeIssue, ForgeIssues | Read one issue with its latest comments, or list them |
| ForgeJobAction | Retries or cancels a job (on GitHub, cancel stops the whole workflow run, and a retry answers the new attempt, or that the rerun was requested while GitHub does not list it yet); asks first |
| ForgeOpenMergeRequest | Opens a merge or pull request from a pushed branch; asks first. When the remote pushes to your fork on the same server, it opens one from the fork into the repository the remote fetches |
| ForgeComment | Comments on a merge request, pull request or issue; asks first |

- The group is called `forge`, and the agent loads it with ToolSearch when it needs it. It can be loaded only while an account exists, never in a design chat or by the agents a design chat starts. `damocles.desktop.forge.agentTools` (on by default) switches it off. The Explore and Plan subagents get the read tools; team reviewers and read-only agents get no writes. A subagent or team member started while no account exists has none of the tools.
- The tools always act on the chat's own repository: its git remotes give the server and the project, and the project's account answers. A remote's fetch address names the project; when that address is on no server Damocles knows, its push address does.
- A write runs only on what its card showed: when the repository, the account, a branch or the text to send changed after you approved it, nothing is sent and the agent is told to call the tool again. A tool takes at most a remote name (`origin`, `upstream`), numbers and text, never a server address. With `damocles.desktop.forge.agentReadAnyRepository` on (off by default), the read tools may name another repository on the same server; the writes never can.
- What the server returns is treated as data: secrets in it are redacted, your live tokens masked, hidden characters removed, and the text is marked as coming from the server. A result over 20 KB is cut; in a chat on this computer the full text is in a temporary file the agent can read.
- When the project has no account on its server, the call fails and the chat shows a notice with Choose account. When a GitHub organization requires single sign-on, or has not approved Damocles, the notice offers to authorize Damocles or to request approval.
- In a chat on a remote host the tools run on your computer with your accounts, only for that host's projects, and only text comes back: no token reaches the host. They are unavailable while your computer is not connected or while the group is off on it.

## Deferred tool loading

The browser, Compass, web, GitHub and GitLab, and MCP tools, and the MCP resource tools (group `mcp_resources`), start registered but **inactive**, so their schemas are not in the prompt on turn one. A conversation that never touches them never pays for them. The resource tools are the one exception to deferral: when a resource server is set to Always loaded, all three are declared from the first turn.

The agent loads a group on demand with the always-active `ToolSearch` tool, and the tools are callable from its next step. The menu it reads is built from live workspace configuration, so a subsystem you disable mid-session drops out of it rather than staying advertised.

What this saves depends on your provider: a tool never loaded always costs nothing, and on Anthropic *loading* a group mid-conversation still reads the cached system prompt and initial tools, so only the new schemas and the messages are written to the cache again. Subagents and team agents resolve through the same deferral, so no agent kind is a hole. `/context` shows the split; see [Context stats](chat.md#context-stats).

## Tools panel

A status panel lists every agent tool grouped by subsystem (core, memory, compass, browser, web, image, GitHub and GitLab on desktop, design), each with a per-tool enable switch and a per-subsystem master switch. Core built-ins are locked on; the other groups' tools toggle. The GitHub and GitLab group shows as unavailable until an account is signed in; in a chat on a remote host, while Damocles is still reading the accounts of your computer, it says so instead. It opens from the Tools button in the chat header (in its More menu when the panel is narrow).
