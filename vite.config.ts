import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';

export default defineConfig({
  plugins: [vue(), tailwindcss()],
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
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
        // BOOT_RESOURCES in src/webview/utils/perf.ts lists the entry and these chunk names.
        manualChunks(id) {
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
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@': resolve(__dirname, 'src/webview'),
    },
  },
});
