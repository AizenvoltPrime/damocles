export type PerfFields = Record<string, string | number | boolean | undefined>;

/** The `[perf]` log line both the extension and the webview write. */
export function formatPerfLine(label: string, ms: number, fields?: PerfFields): string {
  let line = `[perf] ${label} ${ms.toFixed(1)}ms`;
  if (fields) {
    for (const [key, value] of Object.entries(fields)) {
      if (value !== undefined) line += ` ${key}=${value}`;
    }
  }
  return line;
}
