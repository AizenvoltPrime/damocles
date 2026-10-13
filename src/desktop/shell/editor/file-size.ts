const KIB = 1024;
const MIB = KIB * KIB;

/** A byte count in the UI language's own unit and number format, counted in 1024s as VS Code's ByteSize does (8 bytes, 1.2 kB, 50 MB). */
export function fileSize(bytes: number, locale: string): string {
  if (bytes < KIB) return new Intl.NumberFormat(locale, { style: 'unit', unit: 'byte', unitDisplay: 'long' }).format(bytes);
  const megabytes = bytes >= MIB;
  const unit = megabytes ? 'megabyte' : 'kilobyte';
  return new Intl.NumberFormat(locale, { style: 'unit', unit, maximumFractionDigits: 1 }).format(bytes / (megabytes ? MIB : KIB));
}
