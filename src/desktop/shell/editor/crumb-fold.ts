// The number of folders after the first crumb that fold into the ellipsis crumb, so every folder shown is whole.
// widths: whole widths of the first crumb, each folder and the file; available: room from the first crumb's start; one unit throughout.
export function foldCrumbs(widths: readonly number[], available: number, separator: number, ellipsis: number): number {
  const folders = widths.length - 2;
  if (folders < 1) return 0;
  const sum = widths.reduce((total, width) => total + width, 0);
  if (sum + (widths.length - 1) * separator <= available) return 0;
  let used = widths[0]! + separator + ellipsis + separator + widths.at(-1)!;
  let hidden = folders;
  while (hidden > 0 && used + widths[hidden]! + separator <= available) {
    used += widths[hidden]! + separator;
    hidden--;
  }
  return hidden;
}
