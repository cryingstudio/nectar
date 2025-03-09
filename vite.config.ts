import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import webExtension from "vite-plugin-web-extension";
import path from "path";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    webExtension({
      manifest: () => ({
        name: "Nectar",
        version: "1.0.0",
        manifest_version: 3,
        description: "Save Money with ONE click!",
        permissions: ["activeTab", "scripting", "storage", "tabs"],
        host_permissions: ["*://*/*"],
        action: { default_popup: "index.html" },
        background: {
          service_worker: "background.js",
          type: "module",
        },
        // We don't need content scripts here anymore as we're doing all fetching
        // from the background script
      }),
      browser: "chrome",
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name].js",
        assetFileNames: "[name].[ext]",
      },
    },
  },
  // Add this to prevent issues with Puppeteer
  optimizeDeps: {
    exclude: ["puppeteer"],
  },
});
