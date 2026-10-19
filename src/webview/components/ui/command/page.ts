// Sub-pixel layout can leave a row that fits a fraction of a pixel past the scroll area's edge.
const SLACK_PX = 1

// The visible part of the row's nearest scrolling ancestor, else of the viewport, in client coordinates.
function scrollArea(row: HTMLElement): { scroller: Element, top: number, bottom: number } {
  const root = row.ownerDocument.documentElement
  for (let element = row.parentElement; element && element !== root; element = element.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(element).overflowY)) {
      const top = element.getBoundingClientRect().top + element.clientTop
      return { scroller: element, top, bottom: top + element.clientHeight }
    }
  }
  return { scroller: root, top: 0, bottom: root.clientHeight }
}

/**
 * The row PageDown (`forward`) or PageUp moves the highlight to, as VS Code's List.focusNextPage and focusPreviousPage
 * (listWidget.ts) do: the last (first) row the scroll area shows whole, or, when the highlight is already there or past
 * it, that row of the page beyond, scrolled into view. Undefined at the list's end, which it does not wrap past.
 */
export function pageRow(rows: readonly HTMLElement[], current: HTMLElement | null, forward: boolean): HTMLElement | undefined {
  const first = rows[0]
  if (!first) return undefined
  const { scroller, top, bottom } = scrollArea(first)
  // A row's scroll margin keeps it clear of a sticky header, so it narrows the area as it does for scrollIntoView.
  const margin = getComputedStyle(first)
  const bandTop = top + (Number.parseFloat(margin.scrollMarginTop) || 0)
  const bandBottom = bottom - (Number.parseFloat(margin.scrollMarginBottom) || 0)
  const whole = (row: HTMLElement) => {
    const rect = row.getBoundingClientRect()
    return rect.top >= bandTop - SLACK_PX && rect.bottom <= bandBottom + SLACK_PX
  }
  const edge = () => (forward ? [...rows].reverse() : rows).find(whole)
  const at = current ? rows.indexOf(current) : -1

  let target = edge()
  const ahead = target !== undefined && (at < 0 || (forward ? rows.indexOf(target) > at : rows.indexOf(target) < at))
  if (!ahead) {
    const before = scroller.scrollTop
    scroller.scrollTop = before + (forward ? 1 : -1) * (bandBottom - bandTop)
    if (scroller.scrollTop === before) return undefined
    target = edge()
  }
  if (target && !forward) revealHeading(target, rows, scroller, bandTop)
  return target
}

// VS Code's quick pick reveals the separator above the first item of its group (quickInputList.ts QuickPickFocus.PreviousPage).
function revealHeading(row: HTMLElement, rows: readonly HTMLElement[], scroller: Element, bandTop: number): void {
  const group = row.closest("[role=\"group\"]")
  const labelId = group?.getAttribute("aria-labelledby")
  const heading = labelId ? row.ownerDocument.getElementById(labelId) : null
  if (!group || !heading || rows.find(other => group.contains(other)) !== row) return
  const hidden = bandTop - heading.getBoundingClientRect().top
  if (hidden > 0) scroller.scrollTop -= hidden
}
