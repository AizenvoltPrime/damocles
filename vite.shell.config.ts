import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';

// The desktop shell and pane pages; main generates their HTML (nonce CSP) and loads assets/index.{js,css} and assets/pane.{js,css} by these fixed names.
export default defineConfig({
  plugins: [vue(), tailwindcss()],
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
