import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';
import type { GetModuleInfo, OutputBundle, PreRenderedAsset, PreRenderedChunk } from 'rollup';

// The one dynamic import that loads the editor overlay; every file reachable only through it ships as assets/monaco-*,
// which .vscodeignore and scripts/sync-vscodeignore.mjs --check keep out of the VSIX.
const MONACO_ENTRY = resolve(__dirname, 'src/webview/components/editor/EditorOverlayHost.vue').replace(/\\/g, '/');
const MONACO_PREFIX = 'monaco-';

// Module ids reachable only through MONACO_ENTRY; set at buildEnd, read while chunks and assets are named.
let monacoOnly: ReadonlySet<string> | undefined;

function reachableWithoutMonaco(ids: readonly string[], getModuleInfo: GetModuleInfo): Set<string> {
  const seen = new Set<string>();
  const queue = ids.filter((id) => getModuleInfo(id)?.isEntry === true);
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) {
    if (id === MONACO_ENTRY || seen.has(id)) continue;
    seen.add(id);
    const info = getModuleInfo(id);
    if (info) queue.push(...info.importedIds, ...info.dynamicallyImportedIds);
  }
  return seen;
}

function monacoModules(): ReadonlySet<string> {
  if (!monacoOnly) throw new Error('monaco module set read before the module graph was complete');
  return monacoOnly;
}

// Chunk names by kind, recorded as chunks are named; Vite names a chunk's extracted CSS `<chunk name>.css`.
const monacoChunkNames = new Set<string>();
const eagerChunkNames = new Set<string>();

function isMonacoChunk(chunk: Pick<PreRenderedChunk, 'moduleIds' | 'name'>): boolean {
  const modules = monacoModules();
  const inMonaco = chunk.moduleIds.filter((id) => modules.has(id)).length;
  if (inMonaco !== 0 && inMonaco !== chunk.moduleIds.length) {
    throw new Error(`chunk ${chunk.name} mixes Monaco-only and eager modules`);
  }
  const monaco = chunk.moduleIds.length > 0 && inMonaco === chunk.moduleIds.length;
  (monaco ? monacoChunkNames : eagerChunkNames).add(chunk.name);
  return monaco;
}

// A url() asset (the codicon font) carries its source path in originalFileNames, relative to the Vite root.
function isMonacoAsset(asset: PreRenderedAsset): boolean {
  const cssOf = asset.names.filter((name) => name.endsWith('.css')).map((name) => name.slice(0, -'.css'.length));
  if (cssOf.some((name) => monacoChunkNames.has(name))) {
    if (cssOf.some((name) => eagerChunkNames.has(name))) throw new Error(`CSS ${asset.names.join(', ')} matches both a Monaco and an eager chunk name`);
    return true;
  }
  return asset.originalFileNames.length > 0
    && asset.originalFileNames.every((file) => resolve(__dirname, 'src/webview', file).replace(/\\/g, '/').includes('/node_modules/monaco-editor/'));
}

function monacoChunkNaming(): Plugin {
  return {
    name: 'damocles-monaco-chunk-naming',
    apply: 'build',
    buildEnd() {
      const ids = [...this.getModuleIds()];
      if (!ids.includes(MONACO_ENTRY)) throw new Error(`${MONACO_ENTRY} is not in the webview module graph`);
      const eager = reachableWithoutMonaco(ids, (id) => this.getModuleInfo(id));
      monacoOnly = new Set(ids.filter((id) => !eager.has(id)));
      monacoChunkNames.clear();
      eagerChunkNames.clear();
    },
    generateBundle(_options, bundle: OutputBundle) {
      const prefixed = (fileName: string): boolean => fileName.startsWith(`assets/${MONACO_PREFIX}`);
      for (const file of Object.values(bundle)) {
        if (file.type !== 'chunk') continue;
        const meta = file.viteMetadata;
        if (!meta) throw new Error(`${file.fileName} has no Vite metadata to check its CSS and assets against`);
        const loads = [...file.imports, ...meta.importedCss, ...meta.importedAssets];
        if (prefixed(file.fileName)) {
          const unprefixed = loads.filter((loaded) => !prefixed(loaded));
          const eagerOnly = unprefixed.filter((loaded) => !(bundle[loaded]?.type === 'chunk'));
          if (eagerOnly.length > 0) throw new Error(`${file.fileName} loads ${eagerOnly.join(', ')}, which lack the ${MONACO_PREFIX} prefix`);
          continue;
        }
        const eagerMonaco = loads.filter(prefixed);
        if (eagerMonaco.length > 0) throw new Error(`${file.fileName} statically loads ${eagerMonaco.join(', ')}`);
        const monacoSource = file.moduleIds.find((id) => id.includes('/node_modules/monaco-editor/'));
        if (monacoSource) throw new Error(`${file.fileName} bundles ${monacoSource}`);
      }
    },
  };
}

// Every web worker the webview builds is a Monaco worker; any other worker would need its own naming.
function monacoWorkersOnly(): Plugin {
  return {
    name: 'damocles-monaco-workers-only',
    generateBundle(_options, bundle: OutputBundle) {
      for (const file of Object.values(bundle)) {
        if (file.type === 'chunk' && file.isEntry && !file.facadeModuleId?.replace(/\\/g, '/').includes('/node_modules/monaco-editor/')) {
          throw new Error(`worker ${file.facadeModuleId ?? file.fileName} is not a Monaco worker`);
        }
      }
    },
  };
}

export default defineConfig({
  plugins: [vue(), tailwindcss(), monacoChunkNaming()],
  root: 'src/webview',
  build: {
    outDir: '../../dist/webview',
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    // Preload links would be blocked by the webview CSP; each chunk's static imports fetch its dependencies.
    modulePreload: false,
    rollupOptions: {
      input: resolve(__dirname, 'src/webview/index.html'),
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: (chunk) => (isMonacoChunk(chunk) ? `assets/${MONACO_PREFIX}[name].js` : 'assets/[name].js'),
        assetFileNames: (asset) => (isMonacoAsset(asset) ? `assets/${MONACO_PREFIX}[name].[ext]` : 'assets/[name].[ext]'),
        // BOOT_RESOURCES in src/webview/utils/perf.ts lists the entry and these chunk names.
        manualChunks(id) {
          // Left to Rollup so they stay behind the editor overlay's dynamic import.
          if (monacoModules().has(id)) return undefined;
          if (id.includes('node_modules')) {
            if (id.includes('shiki')) {
              // Left to Rollup, so each grammar and theme is its own lazy chunk.
              if (id.includes('/langs/') || id.includes('/themes/')) return undefined;
              return 'shiki-core';
            }
            if (id.includes('d3-force') || id.includes('d3-selection') || id.includes('d3-zoom') || id.includes('d3-drag') || id.includes('d3-dispatch') || id.includes('d3-timer') || id.includes('d3-quadtree') || id.includes('d3-transition') || id.includes('d3-color') || id.includes('d3-ease') || id.includes('d3-interpolate')) {
              return 'd3-graph';
            }
            // Charting is used only by the async /stats overlay; '@unovis/vue' would otherwise match 'vue' and load eagerly.
            if (id.includes('@unovis')) return undefined;
            if (id.includes('vue') || id.includes('pinia') || id.includes('@vueuse')) {
              return 'vendor';
            }
          }
        },
      },
    },
  },
  worker: {
    // Module workers: Monaco's workers split into chunks, which the iife format cannot express.
    format: 'es',
    plugins: () => [monacoWorkersOnly()],
    rollupOptions: {
      output: {
        entryFileNames: `assets/${MONACO_PREFIX}[name].js`,
        chunkFileNames: `assets/${MONACO_PREFIX}[name].js`,
        assetFileNames: `assets/${MONACO_PREFIX}[name].[ext]`,
      },
    },
  },
  experimental: {
    // The desktop app serves dist/webview under app://damocles/webview/, so a root-absolute /assets/ URL misses it:
    // URLs written into JS (preload deps, workers) and Monaco's CSS url()s resolve against the file that loads them.
    renderBuiltUrl(filename, { hostType }) {
      if (hostType === 'js') return { relative: true };
      return hostType === 'css' && filename.startsWith(`assets/${MONACO_PREFIX}`) ? { relative: true } : undefined;
    },
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@': resolve(__dirname, 'src/webview'),
    },
  },
});
