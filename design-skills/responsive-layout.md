---
name: responsive-layout
title: Responsive layout
description: Designs layouts that hold at every checked width, from the smallest band to the widest breakpoint, without overlap, clipping or horizontal overflow. Load it for app shells, dashboards, tables and card grids.
validationHints:
  - rule: layout.viewport-font
    severity: warning
    text: Do not scale font size with the viewport; use discrete sizes, or clamp() with conservative bounds for display type only.
  - rule: layout.fixed-width
    severity: warning
    text: Use stable constraints (max-width, minmax(), clamp()) instead of fixed widths wider than the smallest screen.
---

## Layout contract

The design is checked at one width in every band: base (390 px) and each of the app's breakpoints, which design.md's `viewports.checked` names. On the desktop app an overflow sweep also resizes each screen from 320 px to the widest breakpoint. Each screen must hold at all of them.

## Rules

- Use `box-sizing: border-box` throughout.
- Set stable dimensions with `minmax()`, `clamp()` for container sizes, `aspect-ratio` and `max-width`; never a fixed width wider than the smallest screen. Hover labels never resize a grid.
- Do not scale font size with the viewport (`vw`). Use the design's type tokens, or `clamp()` with conservative bounds for display type only.
- Never use negative letter-spacing on small text.
- Prefer CSS grid for large layout changes and flex for local alignment.
- A table on a small screen needs one of: horizontal scroll inside its own container with a sticky first column, card rows, or fewer columns.

## Breakpoints

Use the app's own breakpoints from inventory.json, in its order:

- Below the smallest: one column, compact navigation, full-width primary actions.
- Middle bands: two columns or a split layout when the content has the room.
- Widest bands: the full shell, sidebars, wider data grids and secondary panels.

Describe what changes per band in design.md's responsive table.

## Anti-overlap check

- The longest button label fits its container.
- Cards do not change size on hover.
- Fixed headers and footers do not cover content.
- Mobile navigation does not overlap bottom actions.
- Wide charts, tables and code blocks scroll inside their own container, never the page.
