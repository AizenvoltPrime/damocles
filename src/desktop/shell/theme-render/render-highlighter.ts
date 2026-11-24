import { createHighlighterCoreSync, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import typescript from 'shiki/langs/typescript.mjs';
import type { CodeHighlighter } from '@/composables/code-highlighter';
import { DAMOCLES_SHIKI_THEME, damoclesShikiTheme } from '@/composables/damoclesShikiTheme';

// The sample's one grammar and the desktop's token theme, loaded with the page: a grammar fetched on demand would race the
// capture, and the CSP admits no WebAssembly, so the regex engine is JavaScript's.
let highlighter: HighlighterCore | undefined;
// made on the first window job, so a page that only analyzes never builds it
const loaded = (): HighlighterCore => (highlighter ??= createHighlighterCoreSync({ themes: [damoclesShikiTheme], langs: [typescript], engine: createJavaScriptRegexEngine() }));
const LANGUAGES: ReadonlyMap<string, string> = new Map([['ts', 'typescript'], ['typescript', 'typescript']]);

/** The theme render page's code highlighter: TypeScript, and plain text for any other language, in the Damocles theme only. */
export const RENDER_HIGHLIGHTER: CodeHighlighter = {
  normalizeLanguage: (language) => LANGUAGES.get(language?.toLowerCase() ?? '') ?? 'txt',
  isReady: (_language, theme) => theme === DAMOCLES_SHIKI_THEME,
  get: (_language, theme) => (theme === DAMOCLES_SHIKI_THEME ? Promise.resolve(loaded()) : Promise.reject(new Error(`The theme render page highlights only in ${DAMOCLES_SHIKI_THEME}, not ${theme}`))),
};
