---
name: empty-states
title: Empty states
description: Designs the empty states that matter, first use, no results and error, for any list, table, dashboard or search surface that can show zero items. Load it to replace a generic "No data" placeholder.
validationHints:
  - rule: states.empty-declared
    severity: warning
    text: A list, table or grid that can show zero items declares an empty state with its own block.
  - rule: states.empty-action
    severity: warning
    text: Every empty state answers "what do I do next?" with an action.
---

## When to use

Any surface that can show zero items: lists, tables, boards, inboxes, search and filter results, dashboards and widgets that depend on data, feeds and comment threads, and any screen where a request can fail.

Declare the state on the screen (`<html data-ds-states="default empty error">`) and draw each one as a block with `data-ds-state-only="empty"` (or `error`), so the preview's States switch shows it. The attribute takes one or more states: a block shown in two states lists both, such as `data-ds-state-only="default no-results"`, instead of being drawn twice.

## Rules

There are three empty-state categories, each with its own copy. Do not collapse them into one block.

1. **First use** (no record yet): one sentence on what the feature does, one primary action that creates the first record, and an illustration that hints at the artifact rather than a generic clipboard.
2. **No results** (a filter or search matched nothing): quote the query (`No tickets matched "urgnet"`) and offer two of clear filters, broaden the search, a spelling suggestion or recent results. Never reuse the first-use illustration, or users think their data is gone.
3. **Error** (the request failed): name the cause in plain words (`Network unreachable`), a Retry action, and a secondary way to report the problem. Never a stack trace alone.

A stat tile with no data yet shows an em dash (`—`), not `0`: zero is a real value.

Never ship a screen that only says "No data" or "Nothing here yet". Every empty state answers "what do I do next?".

## Do and don't

- Do quote the user's query in a no-results message.
- Do use a distinct illustration per category.
- Do give the error state a Retry action.
- Don't show a technical code alone (`Error 500`); pair it with the cause.
- Don't hide an empty state behind a spinner that never resolves.

## Pattern

```html
<section data-ds-state-only="empty" class="empty">
  <img src="../assets/invoice-empty.svg" alt="">
  <p>Invoices you create appear here. Send your first one to get paid.</p>
  <button type="button" data-ds-component="Button" data-ds-variant="primary">Create invoice</button>
</section>
```
