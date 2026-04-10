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
    rollupOptions: {
      input: resolve(__dirname, 'src/webview/index.html'),
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('shiki')) {
              if (id.includes('/langs/')) return 'shiki-langs';
              if (id.includes('/themes/')) return 'shiki-themes';
              return 'shiki-core';
            }
            if (id.includes('d3-force') || id.includes('d3-selection') || id.includes('d3-zoom') || id.includes('d3-drag') || id.includes('d3-dispatch') || id.includes('d3-timer') || id.includes('d3-quadtree') || id.includes('d3-transition') || id.includes('d3-color') || id.includes('d3-ease') || id.includes('d3-interpolate')) {
              return 'd3-graph';
            }
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
