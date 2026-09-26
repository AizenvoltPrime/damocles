import {
  createHighlighter,
  type Highlighter,
  type BundledLanguage,
  type BundledTheme,
  bundledLanguages,
} from 'shiki';
import { perfSpan, resourceFields } from '@/utils/perf';

export type ExtendedLanguage = BundledLanguage | 'txt';

type SupportedTheme = Extract<BundledTheme,
  'github-dark' | 'github-light' | 'solarized-dark' | 'solarized-light' | 'nord' | 'min-dark' | 'min-light'>;

const languageAliases: Record<string, ExtendedLanguage> = {
  text: 'txt',
  plaintext: 'txt',
  plain: 'txt',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  shellscript: 'shell',
  'shell-script': 'shell',
  console: 'shell',
  terminal: 'shell',
  js: 'javascript',
  node: 'javascript',
  nodejs: 'javascript',
  ts: 'typescript',
  py: 'python',
  python3: 'python',
  py3: 'python',
  rb: 'ruby',
  md: 'markdown',
  cpp: 'c++',
  cc: 'c++',
  cs: 'c#',
  csharp: 'c#',
  htm: 'html',
  yml: 'yaml',
  dockerfile: 'docker',
  styles: 'css',
  style: 'css',
  jsonc: 'json',
  json5: 'json',
  xaml: 'xml',
  xhtml: 'xml',
  svg: 'xml',
  mysql: 'sql',
  postgresql: 'sql',
  postgres: 'sql',
  pgsql: 'sql',
};

const warnedLanguages = new Set<string>();

export function normalizeLanguage(language: string | undefined): ExtendedLanguage {
  if (!language) return 'txt';

  const normalized = language.toLowerCase();

  if (normalized in bundledLanguages) {
    return normalized as BundledLanguage;
  }

  const alias = languageAliases[normalized];
  if (alias) return alias;

  if (language !== 'txt' && !warnedLanguages.has(language)) {
    console.warn(`[Shiki] Unrecognized language '${language}', defaulting to txt.`);
    warnedLanguages.add(language);
  }

  return 'txt';
}

/** Grammars and themes each load on first use. `loadedThemes` holds only themes the highlighter has. */
const state: {
  initPromise: Promise<Highlighter> | null;
  loadedLanguages: Set<ExtendedLanguage>;
  pendingLanguages: Map<ExtendedLanguage, Promise<void>>;
  loadedThemes: Set<SupportedTheme>;
  pendingThemes: Map<SupportedTheme, Promise<void>>;
} = {
  initPromise: null,
  loadedLanguages: new Set(['txt']),
  pendingLanguages: new Map(),
  loadedThemes: new Set(),
  pendingThemes: new Map(),
};

/** Whether `getHighlighter(language, theme)` would resolve without loading anything. */
export function isHighlighterReady(language: string, theme: SupportedTheme): boolean {
  return state.loadedThemes.has(theme) && state.loadedLanguages.has(normalizeLanguage(language));
}

function loadOnce<K>(key: K, loaded: Set<K>, pending: Map<K, Promise<void>>, load: () => Promise<void>): Promise<void> {
  if (loaded.has(key)) return Promise.resolve();
  let promise = pending.get(key);
  if (!promise) {
    promise = load()
      .then(() => { loaded.add(key); })
      .finally(() => { pending.delete(key); });
    pending.set(key, promise);
  }
  return promise;
}

/** A highlighter with `language` and `theme` loaded. */
export async function getHighlighter(language: string | undefined, theme: SupportedTheme): Promise<Highlighter> {
  const lang = normalizeLanguage(language);
  const firstHighlightSpan = state.initPromise ? null : perfSpan('shiki.firstHighlight');
  let initMs: number | undefined;

  if (!state.initPromise) {
    const initStart = performance.now();
    state.initPromise = createHighlighter({ themes: [theme], langs: [] }).then(
      (instance) => {
        initMs = Math.round(performance.now() - initStart);
        state.loadedThemes.add(theme);
        return instance;
      },
      (error: unknown) => {
        state.initPromise = null;
        console.error('[Shiki] Failed to create highlighter:', error);
        throw error;
      },
    );
  }

  try {
    const instance = await state.initPromise;
    await Promise.all([
      loadOnce(lang, state.loadedLanguages, state.pendingLanguages, async () => {
        try {
          await instance.loadLanguage(lang as BundledLanguage);
        } catch (error) {
          console.error(`[Shiki] Failed to load language ${lang}:`, error);
          throw error;
        }
      }),
      loadOnce(theme, state.loadedThemes, state.pendingThemes, async () => {
        try {
          await instance.loadTheme(theme);
        } catch (error) {
          console.error(`[Shiki] Failed to load theme ${theme}:`, error);
          throw error;
        }
      }),
    ]);
    // Chunk names are the grammar and theme ids (vite.config.ts manualChunks leaves them unnamed).
    firstHighlightSpan?.end({ lang, theme, init: initMs, ...resourceFields([`${lang}.js`, `${theme}.js`]).fields });
    return instance;
  } catch (error) {
    firstHighlightSpan?.end({ lang, theme, failed: true });
    throw error;
  }
}

export function getShikiTheme(): SupportedTheme {
  const bodyClass = document.body.className.toLowerCase();
  const isLight = bodyClass.includes('light');

  const themeName = (document.body.dataset.vscodeThemeName || '').toLowerCase();

  if (themeName.includes('solarized')) {
    return isLight ? 'solarized-light' : 'solarized-dark';
  }

  if (themeName.includes('nord')) {
    return 'nord';
  }

  if (themeName.includes('min') || themeName.includes('minimal')) {
    return isLight ? 'min-light' : 'min-dark';
  }

  return isLight ? 'github-light' : 'github-dark';
}
