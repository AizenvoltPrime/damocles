// The daemon's port detection: the user's listening sockets, polled on this module's own timer only while a client is
// connected, every max(20 x the average scan time, 2 s), and sooner after a printed URL, though never sooner than 2 s after the
// last scan began; and the URLs terminal and agent-shell output prints. It never runs in
// the shell process-lifetime path (core's tools/process-tree.ts) and decides nothing: every client gets every candidate.
import type { Disposable } from '../../../platform/disposable';
import { listeners } from '../../../remote/listeners';
import { scanDarwinListeners } from './darwin-ports';
import { scanLinuxListeners } from './linux-ports';
import type { PortCandidate, UrlSource } from './ports-messages';
import { MAX_PORT_CANDIDATES } from './ports-messages';
import { createUrlFinder, type UrlFinder, type UrlHit } from '../../local-services/url-finder';
import { scanWin32Listeners } from './win32-ports';

export const MIN_SCAN_INTERVAL_MS = 2000;
export const SCAN_INTERVAL_FACTOR = 20;
// scans the average is taken over
const SCAN_SAMPLES = 10;
// the same URL from the same source is reported again only after this long
export const URL_REPEAT_MS = 10_000;
// distinct URLs remembered within that window; past it the oldest is forgotten and may be reported again
export const MAX_REPORTED_URLS = 4096;

export interface UrlSeen {
  readonly host: string;
  readonly port: number;
  readonly source: UrlSource;
}

export interface PortDetector extends Disposable {
  // true while at least one client is connected
  setActive(active: boolean): void;
  // the last scan's candidates; undefined before the first
  current(): readonly PortCandidate[] | undefined;
  onList(listener: (candidates: readonly PortCandidate[]) => void): Disposable;
  onUrl(listener: (seen: UrlSeen) => void): Disposable;
  // a terminal's output, and its end
  terminalOutput(id: string, text: string): void;
  terminalEnded(id: string): void;
  // a URL core's url finder saw in an agent shell's output
  agentShellUrl(hit: UrlHit): void;
}

export interface PortDetectorDeps {
  readonly scan: () => Promise<PortCandidate[]>;
  readonly log: (line: string) => void;
  readonly now?: () => number;
}

export function scannerFor(platform: NodeJS.Platform): () => Promise<PortCandidate[]> {
  if (platform === 'linux') return () => scanLinuxListeners();
  if (platform === 'darwin') return () => scanDarwinListeners();
  if (platform === 'win32') return () => Promise.resolve(scanWin32Listeners());
  return () => Promise.reject(new Error(`Port detection does not run on ${platform}`));
}

const order = (a: PortCandidate, b: PortCandidate): number => a.port - b.port || a.bindAddress.localeCompare(b.bindAddress);

export function createPortDetector(deps: PortDetectorDeps): PortDetector {
  const now = deps.now ?? Date.now;
  const lists = listeners<[readonly PortCandidate[]]>(deps.log);
  const urls = listeners<[UrlSeen]>(deps.log);
  const samples: number[] = [];
  const finders = new Map<string, UrlFinder>();
  const reported = new Map<string, number>();
  let active = false;
  let disposed = false;
  let timer: NodeJS.Timeout | undefined;
  // when the timer fires, on now()'s clock
  let dueAt = 0;
  let scanning = false;
  // a scan asked for while one ran runs after it, paced as scanSoon paces
  let again = false;
  let lastStarted: number | undefined;
  let last: readonly PortCandidate[] | undefined;
  let lastJson = '';

  const interval = (): number => {
    const average = samples.length === 0 ? 0 : samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
    return Math.max(SCAN_INTERVAL_FACTOR * average, MIN_SCAN_INTERVAL_MS);
  };

  const schedule = (delay: number): void => {
    clearTimeout(timer);
    dueAt = now() + delay;
    timer = active && !disposed ? setTimeout(() => void scan(), delay) : undefined;
  };

  // how long a scan asked for outside the timer waits: scans start at most once per MIN_SCAN_INTERVAL_MS
  const pacedDelay = (): number => (lastStarted === undefined ? 0 : Math.max(0, lastStarted + MIN_SCAN_INTERVAL_MS - now()));

  // a scan soon, coalesced with any already due by then
  const scanSoon = (): void => {
    if (!active || disposed) return;
    if (scanning) {
      again = true;
      return;
    }
    const delay = pacedDelay();
    if (timer !== undefined && dueAt <= now() + delay) return;
    schedule(delay);
  };

  async function scan(): Promise<void> {
    if (scanning) {
      again = true;
      return;
    }
    clearTimeout(timer);
    timer = undefined;
    scanning = true;
    const started = now();
    lastStarted = started;
    try {
      const found = (await deps.scan()).sort(order).slice(0, MAX_PORT_CANDIDATES);
      samples.push(now() - started);
      if (samples.length > SCAN_SAMPLES) samples.shift();
      const json = JSON.stringify(found);
      if (json !== lastJson && active) {
        last = found;
        lastJson = json;
        lists.fire(found);
      }
    } catch (err) {
      deps.log(`[ports] scanning the listening sockets failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      scanning = false;
    }
    schedule(again ? pacedDelay() : interval());
    again = false;
  }

  const seen = (source: UrlSource, hit: UrlHit): void => {
    const id = `${source}|${hit.host}|${hit.port}`;
    const at = now();
    // an id is set only once its previous report expired and left, so the map stays in report order, the oldest first
    for (const [key, when] of reported) {
      if (at - when < URL_REPEAT_MS) break;
      reported.delete(key);
    }
    if (reported.has(id)) return;
    reported.set(id, at);
    if (reported.size > MAX_REPORTED_URLS) reported.delete(reported.keys().next().value!);
    urls.fire({ host: hit.host, port: hit.port, source });
    // a URL usually means a server just started listening
    scanSoon();
  };

  return {
    setActive: (next) => {
      if (next === active) return;
      active = next;
      if (active) {
        void scan();
        return;
      }
      schedule(0);
      // what a later client gets comes from a scan made while it is connected
      last = undefined;
      lastJson = '';
    },
    current: () => last,
    onList: lists.add,
    onUrl: urls.add,
    terminalOutput: (id, text) => {
      let finder = finders.get(id);
      if (!finder) {
        finder = createUrlFinder((hit) => seen('terminal', hit));
        finders.set(id, finder);
      }
      finder.push(text);
    },
    terminalEnded: (id) => {
      finders.delete(id);
    },
    agentShellUrl: (hit) => seen('agentShell', hit),
    dispose: () => {
      disposed = true;
      active = false;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
