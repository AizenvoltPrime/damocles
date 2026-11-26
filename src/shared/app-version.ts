// App versions, and the server versions that carry them. Erasable syntax and no imports: the daemon, desktop main and the
// scripts that load the server manifest's format with Node's type stripping all read it.

// SemVer 2.0.0 sections 2 and 9 without build metadata, since a server version adds the build after the one +
const APP_VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/;

/** Whether `value` is an app version: SemVer 2.0.0 with no build metadata. */
export const isAppVersion = (value: unknown): value is string => typeof value === 'string' && value.length <= 64 && APP_VERSION.test(value);

/** The app version a server version names: the part before its `+<build>`, or all of a version without one. */
export function appVersionOf(serverVersion: string): string {
  const plus = serverVersion.indexOf('+');
  return plus === -1 ? serverVersion : serverVersion.slice(0, plus);
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// numeric identifiers have no leading zero, so the longer is the larger at any size, and ones of equal length compare as text
function compareIdentifiers(a: string, b: string): number {
  const [aNumeric, bNumeric] = [/^\d+$/.test(a), /^\d+$/.test(b)];
  if (aNumeric && bNumeric) return a.length !== b.length ? a.length - b.length : compareText(a, b);
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  return compareText(a, b);
}

/** SemVer 2.0.0 section 11 precedence of two app versions: negative when a precedes b, positive when it follows, 0 when equal. */
export function compareAppVersions(a: string, b: string): number {
  const parts = (version: string): { core: string[]; pre: string[] } => {
    const dash = version.indexOf('-');
    return { core: (dash === -1 ? version : version.slice(0, dash)).split('.'), pre: dash === -1 ? [] : version.slice(dash + 1).split('.') };
  };
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    const order = compareIdentifiers(x.core[i]!, y.core[i]!);
    if (order !== 0) return order;
  }
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const order = compareIdentifiers(x.pre[i]!, y.pre[i]!);
    if (order !== 0) return order;
  }
  return x.pre.length - y.pre.length;
}
