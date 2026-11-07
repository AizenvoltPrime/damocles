// AUTO-GENERATED from design-skills/*.md; do not edit. Run: npm run generate:design-skills

/*!
 * The design skills in design-skills/ are adapted from open-codesign
 * (https://github.com/OpenCoworkAI/open-codesign,
 * apps/desktop/resources/templates/skills/*.md), used under the MIT License:
 *
 * MIT License
 *
 * Copyright (c) 2026 OpenCoworkAI Contributors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import type { DesignSkill } from './skills';

export const DESIGN_SKILLS: readonly DesignSkill[] = [
  {
    name: "accessibility-states",
    title: "Accessibility and states",
    description: "Makes screens usable through semantics, labels, keyboard focus, legible content and reachable validation, empty, error and success states. Load it for forms, navigation, dialogs and record actions.",
    validationHints: [
      { rule: "a11y.input-label", severity: "error", text: "Associate a label with every input, select and textarea; a placeholder is not a label." },
      { rule: "a11y.img-alt", severity: "warning", text: "Meaningful images need a text alternative; decorative images get alt=\"\" so they add no screen-reader noise." },
    ],
    body: "## Semantics and keyboard\n\nUse native buttons, links, inputs, selects and forms. Associate a `<label>` with every control (`for` and `id`, or a wrapping label), and give icon-only actions an `aria-label`. A placeholder disappears as the user types, so it is never the label. Use landmarks (`header`, `nav`, `main`) and meaningful heading levels; real tables help compare records. Avoid click-only divs and fake links.\n\nKeep the keyboard order aligned with the reading order, and show a visible focus indicator from the design's tokens. Expose current, selected and expanded states with `aria-current`, `aria-selected` and `aria-expanded`. Never rely on color or hover alone for status or instructions.\n\n## Focus is part of the journey\n\nWhen a control disappears after an action, focus moves to a meaningful place, often the page heading. Returning restores context instead of dropping the user at an unrelated control.\n\nA modal dialog needs an accessible name, initial focus, contained focus, Escape and a visible close or cancel action, and focus restored to its opener. Prefer `<dialog>`. If deleting a record removes the opener, focus goes to the next useful action.\n\n## Reachable states\n\nDesign the states the real flow needs, each as a `data-ds-state-only` block of a state the screen declares in `data-ds-states`. A block shared by several states lists them all, such as `data-ds-state-only=\"default no-results\"`:\n\n- Validation names the field and the fix, keeps the input, and points at the first invalid control.\n- Empty results explain the situation and offer an action, such as clearing filters or creating the first record.\n- Errors offer a working way to recover.\n- Success confirms the change without blocking further work.\n- A disabled control says what it needs. A loading state appears only where the user really waits.\n\n## Visual access\n\nUse legible type, contrast from the design's tokens, wrapping text and touch targets of at least 44 × 44 px. Respect reduced motion. Meaningful images need a text alternative; decorative ones get `alt=\"\"`.\n\nAccessible names become part of the design: the implementation and its journeys find controls by role and name, so name every control the way the real app will.",
  },
  {
    name: "empty-states",
    title: "Empty states",
    description: "Designs the empty states that matter, first use, no results and error, for any list, table, dashboard or search surface that can show zero items. Load it to replace a generic \"No data\" placeholder.",
    validationHints: [
      { rule: "states.empty-declared", severity: "warning", text: "A list, table or grid that can show zero items declares an empty state with its own block." },
      { rule: "states.empty-action", severity: "warning", text: "Every empty state answers \"what do I do next?\" with an action." },
    ],
    body: "## When to use\n\nAny surface that can show zero items: lists, tables, boards, inboxes, search and filter results, dashboards and widgets that depend on data, feeds and comment threads, and any screen where a request can fail.\n\nDeclare the state on the screen (`<html data-ds-states=\"default empty error\">`) and draw each one as a block with `data-ds-state-only=\"empty\"` (or `error`), so the preview's States switch shows it. The attribute takes one or more states: a block shown in two states lists both, such as `data-ds-state-only=\"default no-results\"`, instead of being drawn twice.\n\n## Rules\n\nThere are three empty-state categories, each with its own copy. Do not collapse them into one block.\n\n1. **First use** (no record yet): one sentence on what the feature does, one primary action that creates the first record, and an illustration that hints at the artifact rather than a generic clipboard.\n2. **No results** (a filter or search matched nothing): quote the query (`No tickets matched \"urgnet\"`) and offer two of clear filters, broaden the search, a spelling suggestion or recent results. Never reuse the first-use illustration, or users think their data is gone.\n3. **Error** (the request failed): name the cause in plain words (`Network unreachable`), a Retry action, and a secondary way to report the problem. Never a stack trace alone.\n\nA stat tile with no data yet shows an em dash (`—`), not `0`: zero is a real value.\n\nNever ship a screen that only says \"No data\" or \"Nothing here yet\". Every empty state answers \"what do I do next?\".\n\n## Do and don't\n\n- Do quote the user's query in a no-results message.\n- Do use a distinct illustration per category.\n- Do give the error state a Retry action.\n- Don't show a technical code alone (`Error 500`); pair it with the cause.\n- Don't hide an empty state behind a spinner that never resolves.\n\n## Pattern\n\n```html\n<section data-ds-state-only=\"empty\" class=\"empty\">\n  <img src=\"../assets/invoice-empty.svg\" alt=\"\">\n  <p>Invoices you create appear here. Send your first one to get paid.</p>\n  <button type=\"button\" data-ds-component=\"Button\" data-ds-variant=\"primary\">Create invoice</button>\n</section>\n```",
  },
  {
    name: "loading-skeleton",
    title: "Loading and skeletons",
    description: "Decides between skeletons, spinners and progressive rendering, and shapes a skeleton like the content it stands for. Load it for lists, card grids, tables, dashboards and any surface that loads data.",
    validationHints: [
      { rule: "states.loading-declared", severity: "warning", text: "A screen that shows loaded data declares a loading state shaped like that data." },
    ],
    body: "## When to use\n\nAny surface that waits for data: lists, tables and card grids waiting on a fetch, dashboards waiting on several queries, detail panes waiting on a record, and images, avatars and charts with predictable geometry.\n\nDeclare the state on the screen (`<html data-ds-states=\"default loading\">`) and draw it as a block with `data-ds-state-only=\"loading\"`. The attribute takes one or more states: a block shown in two states lists both, such as `data-ds-state-only=\"default no-results\"`.\n\n## Rules\n\n1. **A skeleton only when the shape is predictable.** A card with a title and three lines gets one short bar and three long ones. When the shape is unknown (a variable number of results, an unknown chart), use a small inline spinner with a label.\n2. **Match the real geometry.** A name is about 120 px wide and an email about 200 px; a bar filling the whole container reads as a long paragraph.\n3. **Render progressively.** Show each field as its data arrives; keep only images and charts as placeholders until they load.\n4. **Spinners for unpredictable shapes**, with a `Loading…` label.\n5. **Time out after 10 to 30 s** into an error state with Retry. Never spin forever.\n6. **Never a full-screen spinner** for in-app data: keep the surrounding chrome and replace only the region that changes.\n\n## Do and don't\n\n- Do pulse or shimmer gently, no faster than one cycle per 1.5 s, and not at all under reduced motion.\n- Do match the real element's corner radius from the design's tokens.\n- Do reserve the vertical space, so the layout does not jump when content arrives.\n- Do show three to five placeholder rows so the page feels populated.\n- Don't combine a skeleton and a spinner in one region.\n- Don't hide data already shown behind a skeleton on refresh; keep it with a small refresh indicator.\n\n## Pattern\n\n```html\n<div data-ds-state-only=\"loading\" class=\"row-skeleton\" aria-busy=\"true\" aria-label=\"Loading contacts\">\n  <span class=\"bar\" style=\"width: var(--size-30)\"></span>\n  <span class=\"bar\" style=\"width: var(--size-50)\"></span>\n</div>\n```",
  },
  {
    name: "responsive-layout",
    title: "Responsive layout",
    description: "Designs layouts that hold at every checked width, from the smallest band to the widest breakpoint, without overlap, clipping or horizontal overflow. Load it for app shells, dashboards, tables and card grids.",
    validationHints: [
      { rule: "layout.viewport-font", severity: "warning", text: "Do not scale font size with the viewport; use discrete sizes, or clamp() with conservative bounds for display type only." },
      { rule: "layout.fixed-width", severity: "warning", text: "Use stable constraints (max-width, minmax(), clamp()) instead of fixed widths wider than the smallest screen." },
    ],
    body: "## Layout contract\n\nThe design is checked at one width in every band: base (390 px) and each of the app's breakpoints, which design.md's `viewports.checked` names. On the desktop app an overflow sweep also resizes each screen from 320 px to the widest breakpoint. Each screen must hold at all of them.\n\n## Rules\n\n- Use `box-sizing: border-box` throughout.\n- Set stable dimensions with `minmax()`, `clamp()` for container sizes, `aspect-ratio` and `max-width`; never a fixed width wider than the smallest screen. Hover labels never resize a grid.\n- Do not scale font size with the viewport (`vw`). Use the design's type tokens, or `clamp()` with conservative bounds for display type only.\n- Never use negative letter-spacing on small text.\n- Prefer CSS grid for large layout changes and flex for local alignment.\n- A table on a small screen needs one of: horizontal scroll inside its own container with a sticky first column, card rows, or fewer columns.\n\n## Breakpoints\n\nUse the app's own breakpoints from inventory.json, in its order:\n\n- Below the smallest: one column, compact navigation, full-width primary actions.\n- Middle bands: two columns or a split layout when the content has the room.\n- Widest bands: the full shell, sidebars, wider data grids and secondary panels.\n\nDescribe what changes per band in design.md's responsive table.\n\n## Anti-overlap check\n\n- The longest button label fits its container.\n- Cards do not change size on hover.\n- Fixed headers and footers do not cover content.\n- Mobile navigation does not overlap bottom actions.\n- Wide charts, tables and code blocks scroll inside their own container, never the page.",
  },
];
