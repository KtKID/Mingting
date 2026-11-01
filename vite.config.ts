import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/web",
    rollupOptions: {
      input: {
        main: resolve("index.html"),
        approvals: resolve("approval-tests/index.html"),
      },
    },
  },
});
