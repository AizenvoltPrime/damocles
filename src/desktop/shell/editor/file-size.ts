const KIB = 1024;
const MIB = KIB * KIB;

/** A byte count in the UI language's own unit and number format, counted in 1024s as VS Code's ByteSize does (1.2 kB, 50 MB). */
export function fileSize(bytes: number, locale: string): string {
  const megabytes = bytes >= MIB;
  const unit = megabytes ? 'megabyte' : 'kilobyte';
  return new Intl.NumberFormat(locale, { style: 'unit', unit, maximumFractionDigits: 1 }).format(bytes / (megabytes ? MIB : KIB));
}
