---
name: loading-skeleton
title: Loading and skeletons
description: Decides between skeletons, spinners and progressive rendering, and shapes a skeleton like the content it stands for. Load it for lists, card grids, tables, dashboards and any surface that loads data.
validationHints:
  - rule: states.loading-declared
    severity: warning
    text: A screen that shows loaded data declares a loading state shaped like that data.
---

## When to use

Any surface that waits for data: lists, tables and card grids waiting on a fetch, dashboards waiting on several queries, detail panes waiting on a record, and images, avatars and charts with predictable geometry.

Declare the state on the screen (`<html data-ds-states="default loading">`) and draw it as a block with `data-ds-state-only="loading"`. The attribute takes one or more states: a block shown in two states lists both, such as `data-ds-state-only="default no-results"`.

## Rules

1. **A skeleton only when the shape is predictable.** A card with a title and three lines gets one short bar and three long ones. When the shape is unknown (a variable number of results, an unknown chart), use a small inline spinner with a label.
2. **Match the real geometry.** A name is about 120 px wide and an email about 200 px; a bar filling the whole container reads as a long paragraph.
3. **Render progressively.** Show each field as its data arrives; keep only images and charts as placeholders until they load.
4. **Spinners for unpredictable shapes**, with a `Loading…` label.
5. **Time out after 10 to 30 s** into an error state with Retry. Never spin forever.
6. **Never a full-screen spinner** for in-app data: keep the surrounding chrome and replace only the region that changes.

## Do and don't

- Do pulse or shimmer gently, no faster than one cycle per 1.5 s, and not at all under reduced motion.
- Do match the real element's corner radius from the design's tokens.
- Do reserve the vertical space, so the layout does not jump when content arrives.
- Do show three to five placeholder rows so the page feels populated.
- Don't combine a skeleton and a spinner in one region.
- Don't hide data already shown behind a skeleton on refresh; keep it with a small refresh indicator.

## Pattern

```html
<div data-ds-state-only="loading" class="row-skeleton" aria-busy="true" aria-label="Loading contacts">
  <span class="bar" style="width: var(--size-30)"></span>
  <span class="bar" style="width: var(--size-50)"></span>
</div>
```
