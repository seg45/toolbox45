import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// Fase 3, fatia 1 (Toolbox45): a app original serve DUAS páginas HTML
// separadas (login.html / index.html), navegação de página inteira entre
// elas (não SPA client-side routing) — replicado aqui como duas entradas
// de build multi-página do Vite, no mesmo padrão do app original, em vez
// de introduzir uma arquitetura nova (react-router) sem necessidade nesta
// fatia. index.html (app principal) ainda é um placeholder — construído
// de verdade na fatia 2 (app shell).
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        login: resolve(__dirname, 'login.html'),
        main: resolve(__dirname, 'index.html'),
      },
    },
  },
  server: {
    port: 5173,
  },
});
