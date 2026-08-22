import {
  createHighlighter,
  type Highlighter,
  type BundledLanguage,
  type BundledTheme,
  bundledLanguages,
} from 'shiki';

export type ExtendedLanguage = BundledLanguage | 'txt';

const SUPPORTED_THEMES = [
  'github-dark',
  'github-light',
  'solarized-dark',
  'solarized-light',
  'nord',
  'min-dark',
  'min-light',
] as const satisfies readonly BundledTheme[];

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

const initialLanguages: BundledLanguage[] = ['shell', 'javascript', 'typescript', 'json', 'html', 'css'];

const state: {
  instance: Highlighter | null;
  initPromise: Promise<Highlighter> | null;
  loadedLanguages: Set<ExtendedLanguage>;
  pendingLoads: Map<ExtendedLanguage, Promise<void>>;
} = {
  instance: null,
  initPromise: null,
  loadedLanguages: new Set(['txt']),
  pendingLoads: new Map(),
};

export function isLanguageLoaded(language: string): boolean {
  return state.loadedLanguages.has(normalizeLanguage(language));
}

export async function getHighlighter(language?: string): Promise<Highlighter> {
  const lang = normalizeLanguage(language);

  if (!state.initPromise) {
    state.initPromise = (async () => {
      const instance = await createHighlighter({
        themes: [...SUPPORTED_THEMES],
        langs: initialLanguages,
      });

      state.instance = instance;
      initialLanguages.forEach((l) => state.loadedLanguages.add(l));

      return instance;
    })();
  }

  const instance = await state.initPromise;

  if (!state.loadedLanguages.has(lang)) {
    let loadPromise = state.pendingLoads.get(lang);

    if (!loadPromise) {
      loadPromise = (async () => {
        try {
          await instance.loadLanguage(lang as BundledLanguage);
          state.loadedLanguages.add(lang);
        } catch (error) {
          console.error(`[Shiki] Failed to load language ${lang}:`, error);
          throw error;
        } finally {
          state.pendingLoads.delete(lang);
        }
      })();

      state.pendingLoads.set(lang, loadPromise);
    }

    await loadPromise;
  }

  return instance;
}

type SupportedTheme = typeof SUPPORTED_THEMES[number];

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
