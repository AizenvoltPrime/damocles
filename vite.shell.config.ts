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
  const required = ['index', 'pane', 'overlay'].flatMap((page) => [`assets/${page}.js`, `assets/${page}.css`]);
  return {
    name: 'damocles-required-page-assets',
    generateBundle(_options, bundle) {
      const missing = required.filter((file) => !Object.hasOwn(bundle, file));
      if (missing.length > 0) this.error(`the desktop shell build did not emit ${missing.join(', ')}`);
    },
  };
}

// The desktop shell, pane and overlay pages; main generates their HTML (nonce CSP) and loads assets/index.{js,css}, assets/pane.{js,css} and assets/overlay.{js,css} by these fixed names.
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
        pane: resolve(__dirname, 'src/desktop/shell/pane/main.ts'),
        overlay: resolve(__dirname, 'src/desktop/shell/overlay/main.ts'),
      },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
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
