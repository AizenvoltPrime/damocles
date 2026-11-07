# Design mode

This page covers design mode: how a design chat starts, what it may change, the checks a design passes, versions and their approval, the desktop preview tab, Open in browser, and comparing your running app with a design. The rules behind it are in [Invariants](invariants.md#design-mode).

Design mode is on by default. `damocles.design.enabled` turns it off, in Settings › Tools & integrations (Design mode) or the Design group of the Tools panel; it applies from user settings only. While it is off the agent has no design tools, StartDesign refuses, and an existing design chat refuses messages until you turn it back on.

## Starting a design

Ask the agent to design first. It calls StartDesign with a title and a brief, which opens a linked design chat titled "Design · {title}"; there is no button for it. In the desktop app the design chat is listed nested under its main chat. Calling StartDesign again reopens the same design chat and sends it the new brief.

The designer reads your app before it draws. Inventory records its components, screens, types, stores and actions, ExtractTokens its tokens, breakpoints and fonts, and ImportAsset copies a font or image into the design. It asks whether you want static mockups or an interactive prototype, and RecordDecision records each answer as a numbered decision (D1, D2, ...).

## The design folder

Each design has a folder under `~/.damocles/designs/<design>/`. The designer writes only these files of its own folder:

- `design.md`, whose frontmatter names the app and the viewports (`primary`, `checked`, `journey`)
- `screens/<name>.html`, one file per screen
- anything under `variants/`

Damocles writes the rest: `manifest.json`, `decisions.md`, `inventory.json`, `tokens.css`, `assets/`, `references/`, `feedback/` and each screen's journey files. No chat's write tool writes those files, in any mode. Cross-chat state (the link to the main chat, finished versions, briefs, check records) lives in `~/.damocles/designs/.state/<design>/`, which checkpoints never capture.

## What a design chat may do

A design chat's permissions are fixed and hold in every mode, YOLO included, before any hook:

- It stays in Default mode, with no plan mode.
- Edit and Write of its own designer files run under your permission rules, and any other write is blocked.
- A shell command runs only when it is proven read-only; any other is blocked.
- It gets only the browser tools that read.
- An MCP tool not annotated read-only asks every time, and a deny rule denies it.
- GenerateImage asks.

A design chat keeps its conversation: `/clear` there is refused, and New Session and Reload leave it alone.

## Checks

DesignCheck checks every screen without a model call. Its errors block a version, and its warnings travel with it. Each rule's severity is fixed:

| Rule | Severity | Catches |
| --- | --- | --- |
| `ds.component-known`, `ds.variant-known`, `ds.bind-known` | error | A component, variant or binding the inventory lacks |
| `ds.decision-known`, `ds.new-cites-decision` | error | A cited decision that does not exist, or new UI (`data-ds-new`) that cites none |
| `tokens.color`, `tokens.spacing`, `tokens.radius` | error | A literal value where a token belongs |
| `tokens.unknown-var`, `tokens.redefined` | error | A `var()` of a token not in `tokens.css`, or a token set to a literal |
| `screen.states`, `screen.size` | error | Malformed `data-ds-screen` or `data-ds-states`, too many screens, or a screen over 2 MiB |
| `design.frontmatter` | error | Missing or unresolved `design.md` frontmatter |
| `fidelity.static-no-scripts` | error | A `<script>` in a static design |
| `links.no-javascript`, `net.no-external`, `assets.local-only` | error | A `javascript:` link, a network load, or an asset outside the design |
| `a11y.control-name` | error | A control with no accessible name |
| `layout.overflow` | error | An element wider than the viewport (desktop) |
| `ds.hidden-required` | warning | A bound field hidden at one checked width and shown at another (desktop) |
| `journey.required` | error | A screen of an interactive design with a control and no passing journey (desktop) |

In the desktop app DesignCheck also renders each screen at the checked widths, `viewports.checked` in `design.md` or else 390 px and each breakpoint, and sweeps from 320 px to the widest breakpoint in 8 px steps for overflow. Width checks need the chat open in the Damocles app. A remote design chat with no app attached checks statically and says so.

LoadDesignSkill loads a design skill: `accessibility-states`, `empty-states`, `loading-skeleton` or `responsive-layout`. A loaded skill's hints join DesignCheck at the severity each hint declares, until a rewind goes back past the load.

## Versions and approval

FinishDesign runs DesignCheck, and in the desktop app the width checks and the journey gate, and refuses on any error. When nothing changed since the latest version, it returns that version again without asking. Otherwise the design chat asks you, in every mode, YOLO included:

- **Approve and send to main chat** (Approve the version, for a design with no main chat) makes the next version, v1 first, and sends it to the main chat.
- **Request changes** sends your note back to the designer, who keeps working and finishes again.
- **Stop** ends the designer's turn with no version.

A finished version reaches the main chat once as a "Design finished · v{n}" card, and the agent plans against it. An idle main chat starts a run in its current mode. A main chat that is closed gets the card when it opens, after a notification with Open chat.

When a version is newer than the one you approved a plan against, the main chat stops after its current tool batch and asks: **Update the plan and re-approve** turns plan mode on so the agent submits the plan again, and **Finish v{n} first** lets it finish the approved version.

## Rewind and fork

A design chat's checkpoints capture its design folder, not your project. Its rewind dialog offers:

- **Rewind**: continues the design in a new chat. The old chat becomes read-only, listed below the new one.
- **Files only**: puts the design files back. The conversation and decisions stay.
- **Fork from here**: a separate design in a new chat, from the files at that point, with no main chat.

A rewind in the main chat carries the design's link to the new chat.

## Desktop preview tab

The desktop app opens a screen's preview as an editor tab of the design chat at the designer's first write of it, and from Open preview on a card. The page runs sandboxed with the network off, and scripts run only in an interactive design. A designer edit reloads it.

- **Width**: presets for 390 px and each breakpoint, the primary width from `design.md` (1280 px when absent), Fit, a typed width from 320 to 2560 px, and a drag handle (arrow keys move 1 px, Shift+arrow 10 px).
- **State** shows each state the screen declares, and **Provenance** outlines each element and shows where it comes from on hover.
- **Screenshot** adds a capture of the live page to the design chat's composer, marked as a preview so it is not saved as a reference.
- **Markup** freezes the page at its width and state for pen, arrow, box and pin marks (Change or Note pins, at most 64 marks). Send to designer saves them as `feedback/F<n>` and sends them as your next message, or after the run when the chat is busy.
- **Tweaks** shows the controls the designer declared with DeclareTweaks. Each stop is one of your tokens, it restyles only the live preview, and Keep sends "Keep: {label} → {token}" to the designer, who records it as a decision.
- **Browser** opens the screen in your own browser.

PreviewJourney runs a scripted journey on a screen at each journey width, finding elements by role, label, placeholder or text, and saves it as `screens/<name>.journey.json` and a Playwright test, `screens/<name>.journey.spec.ts`. Replay in preview on its card plays the steps in the open tab. DesignScreenshot captures each checked width for the designer, as many images as the chat's model keeps from one result.

## Reference images

An image you attach in a design chat becomes a reference, `references/R<n>`, at most 4 per message and 4 MiB each (PNG, JPEG, GIF or WebP). MapReference maps each element of a reference onto an inventory component, a token or a type field, or marks it as needing a decision or out of scope.

## Open in browser

Open in browser serves a screen from a loopback server on this computer, at `http://127.0.0.1:<port>/d/<token>/<path>`, for as long as a chat of that design is open. In the desktop app it is the preview's Browser button and tab menu, and it serves SSH, WSL and container chats with no listener on the host. In VS Code it is on the chat's cards, and works in remote windows too.

## VS Code

The extension has design mode with the static checks only: no preview tab, Screenshot, markup, tweaks, journeys, width checks or DesignParity.

## Comparing your app with a design

DesignParity, in the main chat of the desktop app, opens your running app at an http or https address and compares it with a screen of the version the chat received, at the checked widths or up to 16 you name. For each width the Background model answers 12 fixed checks of layout, color, typography, content and components, and code computes the score and its status: verified at 12 of 12, needs review from 0.85, needs iteration from 0.6, else failed. It needs `damocles.browser.enabled`, a Background model that reads images (`damocles.background.model`), and no change to the screen since that version. It uses two images per width, so a model that keeps 12 images from one result compares at most 6 widths.
