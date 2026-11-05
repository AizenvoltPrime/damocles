# Models and reasoning

This page covers the models Damocles offers, how a panel picks one, the reasoning effort levels each model supports, and how effort is shown.

Sign-in for each provider is described in [Authentication](authentication.md).

## Model selection

Switch models from the composer's model dropdown:

- **Anthropic**: Fable 5.1, Opus 5.5 by default, Sonnet 5.5, Haiku 5.5
- **OpenAI**: `gpt-6-astra` at the head of the group, `gpt-6.1-sol` the recommended default, `gpt-6-luna`
- **Custom providers**: StepFun **Step 5 Preview**, **DeepSeek V4 Pro / V4.1 Flash**, **MiniMax M3.1 Flash**, xAI **Grok 4.7**, Kimi Code **K3 / Kimi for Coding**, Meta **Muse Spark 1.3 / Muse Wonder 1.0**
- **GitHub Copilot** models. Copilot models outside your plan stay listed, muted, as "Not in your plan", and cannot be picked.

The dropdown and Settings › This chat list the models of the providers that have a credential, plus the chat's current model. Turn **Show in model picker** on or off per provider in Settings › Models & accounts (`damocles.modelPicker.providers`, user settings only), which the dropdown's **Manage models…** opens. Defaults, Teams, Explore and Background always list every model.

All OpenAI models work via Sign in with ChatGPT or an API key. **GPT-6 Astra** has a 272,000-token context window, an April 2026 cutoff, and effort Low/Medium/High/Extra High/Max; its pricing defaults are $10 input, $1 cached input, $50 output, $50 reasoning per million tokens.

Selection is per panel, plus a workspace-wide default for new panels. A chat runs the model it shows: a model you set or a resumed chat's model that you are not signed in to stays the chat's model, and a message or `/compact` on it goes back to the input with the reason and opens Settings at that provider's row in Models & accounts, or at This chat for a model your plan does not include. Only a new chat with no model set anywhere starts on another model you are signed in to.

## Per-panel models

Each open panel can have its own model independent of other panels. Settings shows two model selectors:

- **This chat › Model**: The model for the current panel's session (applies immediately)
- **Defaults for new chats › Default model**: The global default that new panels inherit when opened

Changing the default does not affect any existing panel's session. Only new panels pick up the new default.

## OpenAI / GPT backend

GPT models run natively alongside Anthropic models on pi's `openai` provider, signed in with ChatGPT (bills your ChatGPT subscription) or an OpenAI API key (bills your API account). See [OpenAI / GPT](authentication.md#openai--gpt). Selection is per panel with a workspace default. Cost is the price pi records from its own rate table when each request is made.

## StepFun, DeepSeek, MiniMax, xAI, Kimi Code and Meta backends

These run natively as main-dropdown models:

- **StepFun**: Step 5 Preview, step-plan flat-fee subscription, Low/Medium/High with thinking always on
- **DeepSeek**: V4 Pro / V4.1 Flash, per-token metered
- **MiniMax**: M3.1 Flash, Low through Max with thinking always on, billed by key kind
- **xAI**: Grok 4.7, Low through Extra High with thinking always on, per-token metered
- **Kimi Code**: K3 and Kimi for Coding, Low/High/Max with thinking always on, flat membership
- **Meta**: Muse Spark 1.3 and Muse Wonder 1.0, Low through Max with thinking always on, per-token metered

Each has a dedicated API-key panel in Settings; keys live in SecretStorage and reach pi via the native custom-provider path (no reload). Selecting an unauthed model emits a "Sign in to {provider}" toast and the chat stays on, and keeps showing, its current model. DeepSeek, xAI, Meta and a MiniMax pay-as-you-go key (`sk-api-…`) are dollar-budget-enforced like other metered providers; StepFun's flat subscription, Kimi Code's membership and a MiniMax Token Plan key (`sk-cp-…`) are exempt.

## Adaptive thinking (per panel)

Thinking configuration is model-aware and driven by model-reported capabilities. Adaptive models use configurable reasoning effort whose available levels depend on the model:

| Model | Effort levels |
| --- | --- |
| GPT-6 Astra, GPT-6.1 Sol | Low/Medium/High/Extra High/Max |
| GPT-6 Luna | **None** (no reasoning) plus Low/Medium/High/Extra High/Max in chats and Defaults; team roles, Explore, Background and the memory judge never run at None |
| Fable 5.1, Opus 5.5, Sonnet 5.5, Haiku 5.5 | Low/Medium/High/Extra High/Max plus **Ultracode** as a top tier above Max |
| StepFun Step 5 Preview | Low/Medium/High |
| DeepSeek V4 Pro | High/Max |
| DeepSeek V4.1 Flash | Low/High/Max |
| MiniMax M3.1 Flash | Low/Medium/High/Extra High/Max |
| Grok 4.7 | Low/Medium/High/Extra High |
| K3, Kimi for Coding | Low/High/Max |
| Muse Spark 1.3, Muse Wonder 1.0 | Low/Medium/High/Extra High/Max |

**Ultracode** is the highest reasoning-effort level (maximum thinking). It is selectable per panel or as a default for new panels (listed after Max), and applies only to those Anthropic models (not to OpenAI/Codex models). The **Max** level is native as of pi 0.80.6 and available on GPT-6 and the adaptive Claude models.

Each panel has independent reasoning state: a `thinkingDisabled` flag plus a per-(panel, model) matrix of effort, so switching models within a panel preserves prior intent. A model with no stored effort runs at its catalog default where it has one (High on Opus 5.5 and Sonnet 5.5). Flip back to a previously configured model and its effort restores automatically.

The disable-thinking switch has no effect on OpenAI models, which are driven by effort alone, or on Fable 5.1, Opus 5.5, Sonnet 5.5, Step 5 Preview, MiniMax M3.1 Flash, Grok 4.7, K3, Kimi for Coding, Muse Spark 1.3, Muse Wonder 1.0, GPT-6 Astra and GPT-6.1 Sol, which always think. Settings shows it disabled with a note that effort is the control.

A resumed or restored conversation continues on the model and effort it last ran with, read from its session file (Ultracode comes back as Max, which runs the same), and one recorded on a retired model continues on its successor (Haiku 4.5 on Haiku 5.5, Step 3.7 Flash on Step 5 Preview, DeepSeek V4 Flash on V4.1 Flash). Permission mode and YOLO always start at your defaults.

Settings' **This chat** and **Defaults for new chats** sections each have a reasoning block, and the two track different model dimensions independently, so switching the active model in This chat never drags the defaults section's effort capabilities along with it. Workspace defaults persist via `damocles.thinkingDisabled` / `damocles.effortByModel`. Thinking blocks are always visible (`display: 'summarized'` overrides the API's `omitted` default on Fable 5.1, Opus 5.5 and Sonnet 5.5).

## Effort badges

Each reply shows the reasoning effort it ran at (for example "High"), once per turn on the turn's first reply and again only if the effort changes within the turn. Subagent cards, team lead and specialist cards and their overlays show each agent's effort beside its model. The value is the level pi actually ran at after fitting it to the model, so a subagent asked for Max on a model whose top level is High shows High, and Ultracode shows as Max. Models that do not reason, GitHub Copilot's Gemini models (which reason but take no effort setting), and conversations and team logs recorded before this version show no badge.
