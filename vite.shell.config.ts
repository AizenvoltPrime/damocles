import { readFileSync } from 'fs';
import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';
import { DESKTOP_FONT_FILES, DESKTOP_FONT_LICENSES } from './src/desktop/main/desktop-fonts';

// Copies the desktop fonts and their licences to dist/desktop-shell/fonts/ under the names theme.ts's @font-face rules load.
function desktopFonts(): Plugin {
  const packageFile = (pkg: string, file: string): Buffer => readFileSync(resolve(__dirname, 'node_modules', pkg, file));
  return {
    name: 'damocles-desktop-fonts',
    generateBundle() {
      for (const font of DESKTOP_FONT_FILES) {
        this.emitFile({ type: 'asset', fileName: `fonts/${font.output}`, source: packageFile(font.pkg, `files/${font.source}`) });
      }
      for (const license of DESKTOP_FONT_LICENSES) {
        this.emitFile({ type: 'asset', fileName: `fonts/${license.output}`, source: packageFile(license.pkg, 'LICENSE') });
      }
    },
  };
}

// Main's generated pages load these by fixed name; Rollup emits one file for identical stylesheets, so a page whose
// stylesheet matches another's would silently get none.
function requiredPageAssets(): Plugin {
  const required = ['index', 'overlay'].flatMap((page) => [`assets/${page}.js`, `assets/${page}.css`]);
  return {
    name: 'damocles-required-page-assets',
    generateBundle(_options, bundle) {
      const missing = required.filter((file) => !Object.hasOwn(bundle, file));
      if (missing.length > 0) this.error(`the desktop shell build did not emit ${missing.join(', ')}`);
    },
  };
}

// The shell ships only Monaco's editor, JSON and TypeScript workers (docs/invariants.md, "Only the desktop chat panel page and the shell page allow workers"); any other worker entry fails the build.
const SHELL_WORKER = /\/node_modules\/monaco-editor\/esm\/vs\/.*\/(?:editor|json|ts)\.worker\.js$/;
function shellWorkersOnly(): Plugin {
  return {
    name: 'damocles-shell-workers-only',
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        const entry = file.type === 'chunk' && file.isEntry ? file.facadeModuleId?.replace(/\\/g, '/') ?? file.fileName : undefined;
        if (entry !== undefined && !SHELL_WORKER.test(entry)) this.error(`worker ${entry} is not one the shell may ship`);
      }
    },
  };
}

// The desktop shell and overlay pages; main generates their HTML (nonce CSP) and loads assets/index.{js,css} and assets/overlay.{js,css} by these fixed names.
export default defineConfig({
  plugins: [vue(), tailwindcss(), desktopFonts(), requiredPageAssets()],
  root: 'src/desktop/shell',
  // Relative asset URLs: the shell is served under app://damocles/desktop-shell/, where a root-absolute /assets/ URL misses.
  base: './',
  build: {
    outDir: '../../../dist/desktop-shell',
    emptyOutDir: true,
    sourcemap: false,
    // Preload links would be blocked by the nonce-locked CSP; each chunk's static imports fetch its dependencies.
    modulePreload: false,
    rollupOptions: {
      // Each entry imports its own stylesheet; a stylesheet both imported would land in a shared chunk's CSS instead.
      input: {
        index: resolve(__dirname, 'src/desktop/shell/index.html'),
        overlay: resolve(__dirname, 'src/desktop/shell/overlay/main.ts'),
      },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
  worker: {
    // Module workers: Monaco's workers split into chunks, which the iife format cannot express. The shell CSP's worker-src is
    // app://damocles/desktop-shell/assets/, so they stay there, prefixed apart from the pages' chunks.
    format: 'es',
    plugins: () => [shellWorkersOnly()],
    rollupOptions: {
      output: {
        entryFileNames: 'assets/worker-[name].js',
        chunkFileNames: 'assets/worker-[name].js',
        assetFileNames: 'assets/worker-[name].[ext]',
      },
    },
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@': resolve(__dirname, 'src/webview'),
    },
  },
});
