import { readFile } from '../../core/resource-fs';
import type { Memento } from '../../platform/key-value-state';
import type { TextNotifications } from './platform/notification-service';
import { MAX_RELEASE_VERSION_LENGTH, type ReleaseIndex, type ReleaseIndexEntry, type ReleaseNotes } from '../preload/updates';
import { compareVersions, isVersion } from './semver';

// Global KeyValueState: the version the last launch ran, for the after-update notice (D56).
export const LAST_SEEN_VERSION_KEY = 'damocles.desktop.lastSeenVersion';

// Keep a Changelog headings; any other level-2 heading ends the section above it and is not indexed.
const VERSION_HEADING = /^## \[(\d+\.\d+\.\d+)\] - (\d{4}-\d{2}-\d{2})\r?$/;
const SECTION_HEADING = /^## /;

interface Section extends ReleaseIndexEntry {
  readonly markdown: string;
}

/** Every `## [x.y.z] - YYYY-MM-DD` section of a CHANGELOG.md, newest first; a malformed or repeated heading is skipped. */
export function parseChangelog(text: string): readonly Section[] {
  const lines = text.split('\n');
  const sections: Section[] = [];
  const seen = new Set<string>();
  let open: { version: string; date: string; start: number } | undefined;
  const close = (end: number): void => {
    if (open && !seen.has(open.version)) {
      seen.add(open.version);
      sections.push({ version: open.version, date: open.date, markdown: lines.slice(open.start, end).join('\n').trim() });
    }
    open = undefined;
  };
  lines.forEach((line, i) => {
    if (!SECTION_HEADING.test(line)) return;
    close(i);
    const match = VERSION_HEADING.exec(line);
    if (match) open = { version: match[1]!, date: match[2]!, start: i + 1 };
  });
  close(lines.length);
  return sections.sort((a, b) => compareVersions(b.version, a.version));
}

/** The CHANGELOG.md the desktop build copies next to main.js, read and indexed on the first request. */
export class ReleaseNotesSource {
  private readonly path: string;
  private readonly current: string;
  private readonly log: (line: string) => void;
  private sections: Promise<ReadonlyMap<string, Section>> | undefined;

  constructor(path: string, current: string, log: (line: string) => void) {
    this.path = path;
    this.current = current;
    this.log = log;
  }

  async index(): Promise<ReleaseIndex> {
    const sections = await this.load();
    return { current: this.current, versions: [...sections.values()].map(({ version, date }) => ({ version, date })) };
  }

  async has(version: string): Promise<boolean> {
    return (await this.load()).has(version);
  }

  async notes(version: string): Promise<ReleaseNotes> {
    const section = (await this.load()).get(version);
    if (!section) throw new Error(`No release notes for ${JSON.stringify(version.slice(0, MAX_RELEASE_VERSION_LENGTH))}`);
    return { version, markdown: section.markdown };
  }

  // A failed read is not kept, so the next request reads again; the renderer gets no path.
  private load(): Promise<ReadonlyMap<string, Section>> {
    this.sections ??= readFile(this.path, 'utf8')
      .then((text) => new Map(parseChangelog(text).map((section) => [section.version, section])))
      .catch((err: unknown) => {
        this.sections = undefined;
        this.log(`[release-notes] could not read ${this.path}: ${err instanceof Error ? err.message : String(err)}`);
        throw new Error('The release notes could not be read');
      });
    return this.sections;
  }
}

export interface InstalledVersionDeps {
  readonly version: string;
  readonly state: Memento;
  readonly notifications: TextNotifications;
  readonly t: (message: string, ...args: Array<string | number | boolean>) => string;
  // Settings › About with the version expanded in What's new
  readonly openWhatsNew: (version: string) => void;
  readonly log: (line: string) => void;
}

/**
 * Records the running version as the last seen one; when it is higher than the version the last launch recorded, posts
 * one notice whose action opens its notes. A first launch, the same version and a downgrade post nothing.
 */
export async function announceInstalledVersion(deps: InstalledVersionDeps): Promise<void> {
  const { version, state, t } = deps;
  const lastSeen = state.get<unknown>(LAST_SEEN_VERSION_KEY);
  if (lastSeen === version) return;
  await state.update(LAST_SEEN_VERSION_KEY, version);
  if (!isVersion(lastSeen) || compareVersions(version, lastSeen) <= 0) return;
  deps.log(`[release-notes] updated from ${lastSeen} to ${version}`);
  const whatsNew = t("See what's new");
  if ((await deps.notifications.info(t('Damocles {0} is installed', version), whatsNew)) === whatsNew) deps.openWhatsNew(version);
}
