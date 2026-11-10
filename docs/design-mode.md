# Design mode

This page covers design mode: how a design chat starts, what it may change, the checks a design passes, versions and their approval, the desktop preview tab, Open in browser, and comparing your running app with a design. The rules behind it are in [Invariants](invariants.md#design-mode).

Design mode is on by default. `damocles.design.enabled` turns it off, in Settings › Tools & integrations (Design mode) or the Design group of the Tools panel; it applies from user settings only. While it is off the agent has no design tools, StartDesign refuses, and an existing design chat refuses messages until you turn it back on.

## Starting a design

Ask the agent to design first. It calls StartDesign with a title and a brief, which opens a linked design chat titled "Design · {title}"; there is no button for it. In the desktop app the design chat is listed nested under its main chat. Calling StartDesign again reopens the same design chat and sends it the new brief.

The designer reads your app before it draws. Inventory records its components, screens, types, stores and actions, ExtractTokens its tokens, breakpoints and fonts, and ImportAsset copies a font or image into the design, from your project, another file on the chat's machine, or an https URL. It asks whether you want static mockups or an interactive prototype, then about every design choice your brief, the app and the current decisions leave open, and each answer becomes a numbered decision (D1, D2, ...); see [Decisions](#decisions).

## The design folder

Each design has a folder under `~/.damocles/designs/<design>/`. The designer writes only these files of its own folder:

- `design.md`, whose frontmatter names the app and the viewports (`primary`, `checked`, `journey`)
- `screens/<name>.html`, one file per screen
- `shared/<name>.css` and `shared/<name>.js`, styles and scripts several screens link (`../shared/<name>.css`), such as the app shell, so it is written once
- anything under `variants/`

RemoveDesignFile deletes a screen, a variant file or a shared file; for a screen it also deletes its journey files, its manifest entry and its check record. It never deletes `design.md`, `tokens.css` or another file Damocles writes. A rewind brings the files back.

Damocles writes the rest: `manifest.json`, `decisions.md`, `inventory.json`, `tokens.css`, `assets/`, `references/`, `feedback/` and each screen's journey files. No chat's write tool writes those files, in any mode. Cross-chat state (the link to the main chat, finished versions, briefs, check records) lives in `~/.damocles/designs/.state/<design>/`, which checkpoints never capture.

## What a design chat may do

A design chat's permissions are fixed and hold in every mode, YOLO included, before any hook:

- It stays in Default mode, with no plan mode.
- Edit and Write of its own designer files run under your permission rules, and any other write is blocked.
- A shell command runs only when it is proven read-only; any other is blocked, and the designer is told why.
- It gets only the browser tools that read.
- An MCP tool not annotated read-only asks every time, and a deny rule denies it.
- GenerateImage asks.
- ImportAsset of a file, whether a project path or another file on the chat's machine, runs as a Read of that file would, so Read rules apply to it (`Read(secrets/**)` covers both `path` and `file`); it names another file as Read does (an absolute path, `~/` or `file://`). From a URL it runs as a WebFetch of that URL would, so `WebFetch(domain:example.com)` deny and ask rules apply to it, and only while Web search is on in Settings. Your ImportAsset rules apply too, and the stricter rule wins. All run without asking unless a rule says ask or deny. A URL must be https, every redirect included, and private and local network addresses are refused; a redirect to another host that a deny or ask `WebFetch(domain:…)` rule matches is not followed, and the designer is told its URL to import as a call of its own. The file's bytes must be the type its name says: a `.png` URL that serves a web page is refused, and a URL with no extension takes the type of its bytes. ImportAsset takes PNG, JPEG, GIF, WebP, AVIF, ICO, SVG, WOFF, WOFF2, TTF and OTF, at most 5 MiB, and saves a JPEG as `.jpg`. A design that uses an AVIF image needs the updated app on every device that views it; an earlier app does not serve AVIF.
- In the desktop app OpenPreview opens or shows a page's preview tab, a screen or a variant such as `variants/accent/b.html`, on the device that shows the design chat.
- It delegates parallel work to subagents, never teams; a design chat has no team tools and no team guidance. A subagent that edits files writes the same designer files, and a read-only one (Explore, Plan) writes none. Its subagents verify with DesignCheck, and on the desktop with DesignScreenshot and PreviewJourney too, and one that can ask may ask you about choices inside their area. The question names the subagent. An option you choose is recorded as one of the design's decisions; words you type instead are kept on the design chat's record, and the designer records what you meant with RecordDecision, quoting you. The designer sees both with the subagent's result.

A design chat keeps its conversation: `/clear` there is refused, and New Session and Reload leave it alone.

## Checks

DesignCheck checks every screen and every shared file without a model call. A shared stylesheet meets the token, network and asset rules of a screen's `<style>`, and a shared script the script rules of a screen (no script in a static design, `motion.reduced-motion`); its issues name the file, such as `shared/base.css`. A page may load files of `assets/` and `shared/`, and `tokens.css` as a stylesheet, each relative to the page's own folder (`../shared/base.css` from a screen). Its errors block a version, and its warnings travel with it. Each rule's severity is fixed:

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
| `decisions.conflict` | error | A decision from your answer that conflicts with another current decision, until a refining decision resolves it |
| `decisions.unchecked` | warning | A decision recorded while its conflict check could not run |
| `ds.decision-replaced` | warning | A screen that cites a replaced decision |
| `motion.reduced-motion` | warning | A script that animates (`requestAnimationFrame`, `setInterval`, `.animate()`) and does not itself check `prefers-reduced-motion` (a screen's inline scripts together, each linked script on its own, a `shared/` script once, on the script), or `@keyframes` while none of the screen's styles, linked ones included, checks it (WCAG 2.2.2, 2.3.3) |

A screen's journey and its width checks hold for its render inputs: the screen, `tokens.css`, every file it loads (through `src`, `srcset`, `poster`, `data`, a `<link>`, an SVG `<use>`, `<image>` or `<feImage>` `href` or `xlink:href`, a `url()`, a bare `image-set()` string, or an `@import`, followed through every stylesheet it reaches), and, when the screen runs any script (a `<script>` that is no data block, or an inline `on*` handler), every file under `shared/` and `assets/`, since a script can load any of them. So an edit of `shared/base.css` makes only the screens that load it run their journeys and width checks again, and an edit of `shared/app.js` those that run scripts. In the desktop app DesignCheck also renders each screen at the checked widths, `viewports.checked` in `design.md` or else 390 px and each breakpoint, and sweeps from 320 px to the widest breakpoint in 8 px steps for overflow. Width checks need the chat open in the Damocles app. A remote design chat with no app attached checks statically and says so.

LoadDesignSkill loads a design skill: `accessibility-states`, `empty-states`, `loading-skeleton` or `responsive-layout`. A loaded skill's hints join DesignCheck at the severity each hint declares, until a rewind goes back past the load.

## Decisions

Every design choice is a numbered decision (D1, D2, ...) with its source: your words in the chat, the text you typed into an answer, a change note, a steer you sent a subagent, a brief (whose message names its id), a markup pin, a kept tweak or a reference row. Damocles records each one in the design chat itself, so a rewind or a fork keeps exactly the decisions of its branch, and `decisions.md` lists the current decisions first, then the replaced ones.

- **Answers.** An AskUserQuestion answer that picks an option records a decision; one where you only typed your own text records none, and the designer records what you meant with RecordDecision, quoting you. This holds for a subagent's question too: what you typed or noted there is kept in the design chat, where the designer can quote it. Answering the same question again replaces the earlier decision; an answer to another question with the same short title does not, and is checked against it like any other decision. A question about an element of a reference image names that element, and the decision its answer records keeps it: `decisions.md` lists it as `Reference: R<n>#<element>`, and the decision's chip names it.
- **Changing your mind.** A new decision names what it replaces (`replaces`) and should restate what still holds, or names the decisions that stay valid beside it (`stillHolds`). A decision the designer records with the same title as a current one must name it.
- **Conflict check.** Before a decision is recorded, the background model checks it against the current decisions. RecordDecision is refused when the new decision contradicts or restates one it does not name. Your answer to a question is never refused: its conflict is flagged, DesignCheck reports it, and FinishDesign waits until the designer records a decision that resolves it. So two current decisions can conflict only while such a flag stands; once a later decision replaces either one, the flag shows as resolved.
- **No background model.** When the check cannot run, the decision is recorded unchecked and DesignCheck warns. FinishDesign checks it again; if it still cannot, the approval names the unchecked decisions, so you approve knowingly, and the version and the main chat's report record them.

The main chat's report lists the current decisions only, and tells it that a decision outranks its brief, since you made it later. When it reads `decisions.md`, it is told that the replaced decisions after the current ones no longer apply.

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

The desktop app opens a screen's preview as an editor tab of the design chat at the designer's first write of it, from Open preview on a card or in the design chat's header, and from Open preview in the menu of a screen's own editor tab, which shows the design chat first. The page runs sandboxed with the network off, and scripts run only in an interactive design. A designer edit reloads it, and so do new tokens, an imported asset and a removed file. A link to another screen moves the tab to that screen once its facts arrive, at the state last chosen there in this tab, and Back and Forward in the toolbar (Alt+Left and Alt+Right, or Cmd+[ and Cmd+] on macOS) walk the pages it showed. A link to a page the design does not have leaves the tab on its screen and shows that no page is there; Back returns. Markup marks belong to the screen they were drawn on: each screen of a tab keeps its own until it is sent.

- **Width**: presets for 390 px and each breakpoint, the primary width from `design.md` (1280 px when absent), Fit, a typed width from 320 to 2560 px, and a drag handle (arrow keys move 1 px, Shift+arrow 10 px).
- **State** shows each state the screen declares, and **Provenance** outlines each element and shows where it comes from on hover.
- **Screenshot** adds a capture of the live page to the design chat's composer, marked as a preview so it is not saved as a reference.
- **Markup** freezes the page at its width and state for pen, arrow, box and pin marks (Change or Note pins, at most 64 marks). Send to designer saves them as `feedback/F<n>` and sends them as your next message. While the designer works, they reach it at its next step as a message of their own, as a message you type does.
- **Tweaks** shows the controls the designer declared with DeclareTweaks. Each stop is one of your tokens, it restyles only the live preview, and Keep sends "Keep: {label} → {token}" to the designer, at its next step while it works, and the designer records it as a decision.
- **Browser** opens the screen in your own browser.

PreviewJourney runs a scripted journey on a screen at each journey width, finding elements by role, label, placeholder or text, exactly or with `exact: false` by a part of the text, as Playwright does, and saves it as `screens/<name>.journey.json` and a Playwright test, `screens/<name>.journey.spec.ts`. A press focuses its target and sends the key to the focused element; a target that takes no focus leaves the focus where it was, so the element focused before it, or the page when none is, receives the key, as Playwright's does. A scroll step brings an element into view, or wheels to its end the box the wheel scrolls there: the target's nearest scrolling ancestor (the target included), else the page, which loads what an infinite list loads there. Replay in preview on its card plays the steps in the open tab.

DesignScreenshot captures screens and variants for the designer, at each checked width or the widths it names, in any declared state, as JPEG images sized for the chat's model, as many as the model keeps from one result. Each capture waits for fonts, images and animations to finish and for the page to hold still, and says so when it never does (an endless animation, a carousel). The look is pinned to light with motion allowed, whatever your app's or your system's theme, unless the designer asks for dark, reduced motion, forced colors, contrast or reduced transparency. `fullPage` captures down the page in up to four frames, `selector` captures one element, and `steps` open a menu or dialog first, which stays open in the capture. An older Damocles app that shows the chat gives the plain top frame as PNG and the designer is told; options it lacks need the app updated.

## Reference images

An image you attach in a design chat becomes a reference, `references/R<n>`, at most 4 per message and 4 MiB each (PNG, JPEG, GIF or WebP). MapReference maps each element of a reference onto an inventory component, a token or a type field, or marks it as needing a decision or out of scope. The designer asks you about each element that needs a decision, one question per element, and your answer records its decision. A decision you make about an element in the chat instead is recorded with the element's row as its source.

## Open in browser

Open in browser serves a screen from a loopback server on this computer, at `http://127.0.0.1:<port>/d/<token>/<path>`, for as long as a chat of that design is open. In the desktop app it is the preview's Browser button and tab menu, and it serves SSH, WSL and container chats with no listener on the host. In VS Code it is on the chat's cards, and works in remote windows too.

## VS Code

The extension has design mode with the static checks only: no preview tab, Screenshot, markup, tweaks, journeys, width checks or DesignParity.

## Comparing your app with a design

DesignParity, in the main chat of the desktop app, opens your running app at an http or https address and compares it with a screen of the version the chat received, at the checked widths or up to 16 you name. For each width the Background model answers 12 fixed checks of layout, color, typography, content and components, and code computes the score and its status: verified at 12 of 12, needs review from 0.85, needs iteration from 0.6, else failed. It needs `damocles.browser.enabled`, a Background model that reads images (`damocles.background.model`), and no change to the screen since that version. It uses two images per width, so a model that keeps 12 images from one result compares at most 6 widths.
