// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, cloudflare (build-only),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... } }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";

export default defineConfig({
  vite: {
    define: {
      // Polyfill only process.env.NODE_ENV for the browser bundle.
      // Using "process.env": JSON.stringify({}) would shadow ALL env vars
      // (including server-side ones read at boot time) which breaks Cloudflare
      // Worker bindings. Defining just NODE_ENV fixes the blank-page
      // "ReferenceError: process is not defined" from TanStack Start's
      // hydrateStart without touching any other server env vars.
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
  },
});
