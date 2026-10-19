const KIB = 1024;
const UNITS = ['kilobyte', 'megabyte', 'gigabyte', 'terabyte'] as const;

/** A byte count in the UI language's own units and number format, counted in 1024s as VS Code's ByteSize does (8 bytes, 1.5 kB, 50 MB). */
export function formatBytes(bytes: number, locale: string): string {
  if (bytes < KIB) return new Intl.NumberFormat(locale, { style: 'unit', unit: 'byte', unitDisplay: 'long' }).format(bytes);
  let value = bytes / KIB;
  let unit = 0;
  while (value >= KIB && unit < UNITS.length - 1) {
    value /= KIB;
    unit++;
  }
  return new Intl.NumberFormat(locale, { style: 'unit', unit: UNITS[unit], maximumFractionDigits: 1 }).format(value);
}
