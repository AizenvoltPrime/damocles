import type { ToolCatalogEntry } from '@shared/types/tools';

/**
 * The web tools' active-set names and Tools-panel rows, and nothing else. Its only import is type-only,
 * so `tools/deferred-tools.ts` can compose these names without the `./exa`/`./extract`/`./feed`/
 * `./youtube` graph — which is what keeps its import-discipline guard (`tool-search.test.ts`) meaningful
 * rather than relaxed to "any import is fine". Reaching for the `web-access` barrel there would pull
 * `./config` and its `vscode` import, exactly the family that guard exists to exclude.
 *
 * NOT a startup optimisation: `tools/index.ts` already imports the barrel, so the heavy graph is parsed
 * regardless. `WEB_SPECS` is the single source of truth; `web-tools.ts`'s `defineTool` name literals are
 * held in parity with it by `tools/__tests__/web-tools-schema-parity.test.ts`.
 */

interface ToolSpec {
  /** PascalCase active-set name + `defineTool` name + label source. */
  name: string;
  /** Human-friendly Tools-panel label. */
  label: string;
  /** One-line Tools-panel blurb. */
  description: string;
}

const WEB_SPECS: readonly ToolSpec[] = [
  { name: 'WebSearch', label: 'Web search', description: 'Search the web (key-free via Exa).' },
  { name: 'WebFetch', label: 'Web fetch', description: 'Fetch and read a web page or PDF as markdown.' },
  { name: 'CodeSearch', label: 'Code search', description: 'Search public source code and docs (key-free via Exa).' },
  { name: 'FeedRead', label: 'Feed read', description: 'Read an RSS or Atom feed as markdown.' },
  {
    name: 'YouTubeTranscript',
    label: 'YouTube transcript',
    description: 'Fetch a YouTube video transcript when captions are available (best-effort; may be blocked by YouTube).',
  },
] as const;

export const WEB_PI_TOOL_NAMES: readonly string[] = WEB_SPECS.map((s) => s.name);

export const WEB_TOOL_CATALOG: readonly ToolCatalogEntry[] = WEB_SPECS.map((s) => ({
  name: s.name,
  label: s.label,
  description: s.description,
  group: 'web',
  toggleable: true,
}));
