import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:8080",
      "/receiver-api": {
        target: "http://127.0.0.1:8081",
        rewrite: (path) => path.replace(/^\/receiver-api/, ""),
      },
    },
  },
});
