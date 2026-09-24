import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Chat webview bundle: fixed file names so ChatViewProvider can reference them.
export default defineConfig({
  plugins: [react()],
  // Relative asset URLs: the webview serves files from a vscode-webview:// origin.
  base: "./",
  build: {
    outDir: "dist/webview",
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      input: "src/ui/webview/main.tsx",
      output: { entryFileNames: "index.js", assetFileNames: "index.[ext]", format: "es" },
    },
  },
});
