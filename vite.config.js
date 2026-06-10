import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "icons/*.png"],
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff,woff2}"],
        cleanupOutdatedCaches: true,
        skipWaiting: true,
        clientsClaim: true,
      },
      manifest: {
        name: "QuickPOS",
        short_name: "QuickPOS",
        description: "Freedom From Paperwork",
        start_url: "/",
        display: "standalone",
        background_color: "#0f172a",
        theme_color: "#4f46e5",
        icons: [
          { src: "/icons/icon-72.png",           sizes: "72x72",   type: "image/png", purpose: "any" },
          { src: "/icons/icon-96.png",           sizes: "96x96",   type: "image/png", purpose: "any" },
          { src: "/icons/icon-128.png",          sizes: "128x128", type: "image/png", purpose: "any" },
          { src: "/icons/icon-144.png",          sizes: "144x144", type: "image/png", purpose: "any" },
          { src: "/icons/icon-152.png",          sizes: "152x152", type: "image/png", purpose: "any" },
          { src: "/icons/icon-192.png",          sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icons/icon-384.png",          sizes: "384x384", type: "image/png", purpose: "any" },
          { src: "/icons/icon-512.png",          sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icons/icon-maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
          { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      devOptions: {
        enabled: true,
      },
    }),
  ],
});
