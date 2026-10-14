import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Не очищать экран терминала, чтобы были видны сообщения Tauri.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // src-tauri не пересобираем по изменению файлов фронтенда.
      ignored: ["**/src-tauri/**"],
    },
  },
  // VITE_* — пользовательские переменные (AI_BASE_URL и т.п.), TAURI_* — служебные.
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    // Tauri 2 поддерживает современные браузерные движки.
    target: "es2021",
    minify: "esbuild",
    sourcemap: false,
  },
});
