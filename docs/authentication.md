# Authentication

This page covers how Damocles stores credentials and how to sign in to each model provider: Claude, OpenAI, the key-based providers, OpenRouter, TypeSafe and GitHub Copilot.

## How credentials are kept

Damocles runs on the [pi](https://github.com/earendil-works/pi) agent engine and talks to Anthropic and OpenAI directly. It owns its own credentials, sessions, and plans under `~/.damocles/`, isolated from the standalone Claude Code CLI, so signing in or out of either tool never affects the other. Damocles keeps its own settings, skills, and slash commands in `.damocles/` and reads those first. It also reads the CLI's `~/.claude/` settings, skills, agents, and slash commands directly so those stay shared, while the CLI's credentials are never read, written, or deleted.

Sign in from Settings › Models & accounts, opened by the gear in the chat header (VS Code) or in the title bar (desktop app). The extension refreshes the active session automatically once you authenticate. If startup fails because credentials are missing or expired, the chat panel surfaces a dismissable banner with a **Sign In** shortcut.

How the desktop app encrypts saved keys is described in the README under [Desktop credential storage](../README.md#desktop-credential-storage).

## Claude (Anthropic)

The **Claude Authentication** panel offers three modes:

- **API key.** Your `ANTHROPIC_API_KEY`; bills your Anthropic API account.
- **Subscription · extra usage.** Signs in to your Claude Pro/Max subscription via OAuth; usage is **metered** (pay-as-you-go) against the subscription.
- **Subscription · allowance.** The *same* OAuth token, sent through the third-party [`pi-anthropic-auth`](https://github.com/gotgenes/pi-anthropic-auth) plugin, which adds Claude Code's billing attribution to pi's own Anthropic transport so requests draw on your subscription's **included quota** (no metered charge). Switching between allowance and extra usage installs or removes that plugin, with no re-login. If the plugin fails to load, Damocles switches to extra usage and logs the error in the Damocles output channel.

Pick a subscription mode and click **Sign in with Claude**; your browser opens Claude's sign-in page and Damocles finishes on its own when the browser returns. If the browser cannot return to Damocles (another machine), click **Paste link instead** and paste the URL from the browser's address bar.

> **Warning: the "allowance" mode very likely violates Anthropic's Terms of Service.** It attributes a third-party tool's requests to Anthropic's official Claude Code CLI to draw on your subscription's *included* quota, and may result in account action. Use it entirely at your own risk. "API key" (API account) and "extra usage" (metered against your subscription, where you pay for what you use) do not access included quota this way and are not affected.

## OpenAI / GPT

GPT models authenticate two ways, both on pi's `openai` provider:

- **Sign in with ChatGPT.** Bills your ChatGPT subscription. Sign in through the browser; if the browser cannot reach Damocles' local callback (another machine), paste the URL the browser ends on into the prompt Damocles shows. Sign-in needs local port 1455 free and reports an error when another program (an unfinished sign-in elsewhere, or the Codex CLI) holds it. When you reach your plan's usage limit, the error links to `chatgpt.com/settings/usage`. When you reach a ChatGPT Business workspace's per-user limit, the error says to ask your workspace admin to raise it, with no link.
- **API key.** Bills your OpenAI API account. The key is stored in your operating system's credential store, separately for VS Code and the desktop app, and is never written to disk in plain text. The desktop app without a reachable credential store (see [Desktop credential storage](../README.md#desktop-credential-storage)) keeps a key you enter only until it restarts.

ChatGPT wins when both are configured; the **Prefer API key over ChatGPT sign-in** toggle in the OpenAI auth panel inverts the preference with no new sign-in. It is the user setting `damocles.openai.preferApiKey`, applies at once in every window, and stays on this computer: Settings Sync does not carry it. The chat header shows which one a GPT model is using.

An older version kept the API key in plain text in `~/.damocles/pi/agent/auth.json`. The first start of this version moves it into that app's credential store and deletes the plain-text copy. If you use both VS Code and the desktop app, the other app then asks you once to enter the key there. The desktop app on Linux with no keyring service has no persistent credential store, so it leaves the key in `auth.json` and keeps using it from there; a key you save there also goes to `auth.json`, unless you are signed in with ChatGPT, in which case it lasts until you restart. A later start that reaches a keyring moves it.

An existing Codex sign-in (the legacy "OpenAI Codex" provider) keeps working and shows as a legacy row with Sign out until you sign in with ChatGPT, which replaces it.

## StepFun, DeepSeek, MiniMax, xAI, Kimi Code, Meta, OpenRouter and TypeSafe

Each of these providers has its own panel (below OpenAI Authentication) for an API key, and xAI, Kimi Code, Meta and OpenRouter also for a sign-in. Keys are saved to SecretStorage without a validation probe. An invalid key surfaces as a normal request error on first use.

- **StepFun.** Bearer token for the step-plan flat-fee subscription (enables Step 5 Preview, Low/Medium/High with thinking always on).
- **DeepSeek.** `DEEPSEEK_API_KEY` (pay-per-token; enables DeepSeek V4 Pro and V4.1 Flash). Dollar-budget-enforced like other metered providers.
- **MiniMax.** `MINIMAX_API_KEY` from the international platform, platform.minimax.io (enables MiniMax M3.1 Flash, Low through Max with thinking always on). Billing follows the saved key: a Token Plan key (`sk-cp-…`) bills as a subscription, so costs show as estimates and `damocles.maxBudgetUsd` does not apply; plan usage is used first, and overflow draws your prepaid credit packs, which the budget does not track. Any other key, such as a pay-as-you-go key (`sk-api-…`), and a key pi reads from the environment are metered and dollar-budget-enforced.
- **xAI.** `XAI_API_KEY` (pay-per-token; enables Grok 4.7, Low through Extra High with thinking always on). Dollar-budget-enforced like other metered providers. Or click **Sign in with xAI**: the panel shows a code, **Copy code and open page** copies it and opens xAI's page, and the panel shows Signed in once you approve; Cancel stops it, and **Sign out** removes only the sign-in, so a saved key applies again. The sign-in uses your account's xAI API access and bills per token like a key, so the account needs API access: xAI refuses a SuperGrok or X Premium sign-in without it (HTTP 402), and the chat then shows a card saying the xAI account needs API access, or a key.
- **Kimi Code.** `KIMI_API_KEY`, a Kimi Code membership key (enables K3 and Kimi for Coding, Low/High/Max with thinking always on). Or click **Sign in with Kimi Code**, which works like the xAI sign-in. Keys and sign-ins share the membership quota, so Kimi Code bills as a flat fee with either credential: costs show as estimates and `damocles.maxBudgetUsd` does not apply.
- **Meta.** `META_API_KEY`, a Meta Model API key (enables Muse Spark 1.3 and Muse Wonder 1.0, Low through Max with thinking always on). Or click **Sign in with Meta**, which works like the xAI sign-in and mints a Model API key through Meta's Muse Code key endpoint. Damocles bills Meta per token with either credential and enforces the dollar budget; a Muse Code subscriber's actual charge may be lower than the estimate shown. Meta's terms say the Muse Code subscription works only through the Muse Code CLI, and that the key a sign-in mints is for use with Muse Code only (dev.meta.ai/docs/muse-code/subscriptions).
- **OpenRouter.** `OPENROUTER_API_KEY` (pay-per-token; enables image generation, Jev on OpenRouter and template `model:` pins on OpenRouter models). Or click **Sign in with OpenRouter**: Damocles opens openrouter.ai in your browser, where you approve a key for Damocles, and the browser returns to Damocles to finish. If it cannot, paste the code or the final page address into the panel; **Open page again** reopens the page. The sign-in mints an ordinary metered OpenRouter key, so it bills per token like a key you paste.
- **TypeSafe.** `TYPESAFE_API_KEY` for TypeSafe's Jev classifier, which then runs the memory contradiction judge and reranks (see [Persistent memory](persistent-memory.md#reranking-and-the-memory-judge)). It enables no chat model.

## GitHub Copilot

GitHub Copilot has a sign-in and no key field. Click **Sign in with GitHub** in Settings › Models & accounts › GitHub Copilot. The panel first asks for a GitHub Enterprise domain such as `company.ghe.com`; leave it blank, or click **Continue without a domain**, for github.com. It then shows a code: **Copy code and open page** copies it and opens GitHub's device page, and the panel shows Signed in once you approve. **Sign out** removes the sign-in. Without a sign-in, a token pi reads from `COPILOT_GITHUB_TOKEN` or a key in pi's `models.json` shows on the row as set by an environment variable or in pi's configuration.

- **What signing in changes on GitHub.** The sign-in uses pi's GitHub Copilot flow, which also turns on, in your GitHub account's Copilot settings, every model your plan allows that needs turning on. The panel says so before you start.
- **Models.** A **GitHub Copilot** group in the model picker lists Opus 5.5, Sonnet 5.5, Haiku 5.5, GPT-6 Astra, GPT-6.1 Sol, GPT-6 Luna, Gemini 4 Argon and Gemini 3.8 Flash. They are entries of their own (`github-copilot/<model>`), so signing in to Copilot never moves your Anthropic or OpenAI models onto Copilot. A model your plan does not include stays listed, muted, says "Not in your plan" in the picker and in every model list in Settings, and cannot be picked there, in a template `model:` pin or as a team, Explore, Background or memory judge model. The Gemini models take no reasoning effort, so they show no effort control or badge.
- **Damocles never picks Copilot for you.** Automatic background work and the model a new chat falls back to never choose a Copilot model. Copilot runs only where you picked it: the chat's model, a team role, or an explicit Explore, Background or memory judge choice. On a chat you put on Copilot, the Explore default runs on Copilot's Haiku 5.5 when your plan includes it, and otherwise on the chat's own model, so its spend stays on your plan.
- **A chat whose model cannot run sends nothing.** A message goes back to the input with the reason. With only Copilot signed in and no model set anywhere, Damocles opens This chat to pick a model, and when a resumed chat's Copilot model is no longer in your plan, This chat to pick one your plan includes. Agents and team roles that would run on the chat's model say why they cannot start.
- **Billing.** Copilot requests count against your plan's premium requests, not dollars, so Damocles bills them as a flat fee, a template `model:` pin on a Copilot model outside this list included: costs show as estimates and `damocles.maxBudgetUsd` does not apply. `/stats` shows Copilot spend at API-equivalent prices, and settings lists and `/stats` name a Copilot model whose name another provider's model has as, for example, "Opus 5.5 (GitHub Copilot)". `/usage` shows no Copilot limits.
- **Risk.** pi's sign-in identifies itself with a Copilot editor's client id, as other third-party clients do. GitHub can change or end access for such clients at any time, and a sign-in that works today may stop working.

## GitHub and GitLab accounts

The desktop app also signs in to GitHub and GitLab servers in Settings › Models & accounts › Git hosting, for your repositories rather than for a model. These accounts are separate from the GitHub Copilot sign-in above: signing in to one never signs you in to the other. Their tokens are kept in this computer's Damocles Core and secret store and go only to their own server. Refresh tokens and client secrets never leave this computer; git on a remote host gets an access token for one request at a time, and the host's Damocles server keeps it in memory for 8 hours after that answer so it can mask it. [Git hosting accounts](git-hosting.md) covers servers, the browser, device code and token routes, sign-out and registering an OAuth app on your own server.

## Sign-ins and keys

Every provider above with a key follows the same rule as OpenAI. A sign-in, made in Damocles (xAI, Kimi Code, Meta and OpenRouter) or with the pi CLI (`pi login <provider>` with `PI_CODING_AGENT_DIR=~/.damocles/pi/agent`), beats the key saved in Damocles, unless you turn on **Prefer API key over sign-in** in that provider's panel (`damocles.<provider>.preferApiKey`, kept on this computer like OpenAI's); the switch shows while both a saved key and a sign-in exist.

Each panel says whether you are signed in and which credential is active: the sign-in, the API key, or an external key. Damocles never signs you out: deleting a saved key leaves the sign-in in place. An environment variable such as `XAI_API_KEY` or a key in pi's `models.json` never outranks a sign-in, which pi reads first, and **Prefer API key over sign-in** covers only the key saved in Damocles. xAI, Meta and OpenRouter bill per token with any credential, a sign-in included, and Kimi Code bills as a flat fee with either.

When a provider in Settings › Models & accounts refuses the credential a chat used, the chat shows a card naming that provider. For Claude its action signs in again; for the other providers there it opens that provider's row. A provider not listed there gets the plain error card.

Version 2.6 and earlier wrote the StepFun, DeepSeek and OpenRouter keys in plain text to `~/.damocles/pi/agent/auth.json`. The first start of this version removes such a key once. A key you add there later, for example with `pi login`, and a key stored there for any other provider, is kept and shows as an external key.
