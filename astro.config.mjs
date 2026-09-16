// @ts-check
import cloudflare from '@astrojs/cloudflare'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'astro/config'

export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    // 'compile' keeps image work at build time; the Worker runtime has no sharp.
    imageService: 'compile',
    // Lets `astro dev` talk to the real R2 bucket bound below.
    platformProxy: { enabled: true, remoteBindings: true },
  }),
  security: {
    // Astro blocks cross-origin POSTs to defend the app's own forms, which is
    // right — but it also blocked the scheduler calling /api/cron/digest, and
    // the failure looked like a 403 about "form submissions" for a request that
    // is not a form. The endpoint is protected by a constant-time shared-secret
    // check instead, so the origin check buys nothing there.
    //
    // Left ON. The cron caller sends Content-Type: application/json, which the
    // origin check does not apply to. See docs/OPERATIONS.md.
    checkOrigin: true,
  },
  vite: { plugins: [tailwindcss()] },
})
