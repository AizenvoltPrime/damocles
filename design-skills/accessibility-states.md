---
name: accessibility-states
title: Accessibility and states
description: Makes screens usable through semantics, labels, keyboard focus, legible content and reachable validation, empty, error and success states. Load it for forms, navigation, dialogs and record actions.
validationHints:
  - rule: a11y.input-label
    severity: error
    text: Associate a label with every input, select and textarea; a placeholder is not a label.
  - rule: a11y.img-alt
    severity: warning
    text: Meaningful images need a text alternative; decorative images get alt="" so they add no screen-reader noise.
---

## Semantics and keyboard

Use native buttons, links, inputs, selects and forms. Associate a `<label>` with every control (`for` and `id`, or a wrapping label), and give icon-only actions an `aria-label`. A placeholder disappears as the user types, so it is never the label. Use landmarks (`header`, `nav`, `main`) and meaningful heading levels; real tables help compare records. Avoid click-only divs and fake links.

Keep the keyboard order aligned with the reading order, and show a visible focus indicator from the design's tokens. Expose current, selected and expanded states with `aria-current`, `aria-selected` and `aria-expanded`. Never rely on color or hover alone for status or instructions.

## Focus is part of the journey

When a control disappears after an action, focus moves to a meaningful place, often the page heading. Returning restores context instead of dropping the user at an unrelated control.

A modal dialog needs an accessible name, initial focus, contained focus, Escape and a visible close or cancel action, and focus restored to its opener. Prefer `<dialog>`. If deleting a record removes the opener, focus goes to the next useful action.

## Reachable states

Design the states the real flow needs, each as a `data-ds-state-only` block of a state the screen declares in `data-ds-states`. A block shared by several states lists them all, such as `data-ds-state-only="default no-results"`:

- Validation names the field and the fix, keeps the input, and points at the first invalid control.
- Empty results explain the situation and offer an action, such as clearing filters or creating the first record.
- Errors offer a working way to recover.
- Success confirms the change without blocking further work.
- A disabled control says what it needs. A loading state appears only where the user really waits.

## Visual access

Use legible type, contrast from the design's tokens, wrapping text and touch targets of at least 44 × 44 px. Respect reduced motion. Meaningful images need a text alternative; decorative ones get `alt=""`.

Accessible names become part of the design: the implementation and its journeys find controls by role and name, so name every control the way the real app will.
