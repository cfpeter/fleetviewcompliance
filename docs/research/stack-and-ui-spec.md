# Toma Appliances — Stack & UI Build Spec

Extracted verbatim from `/Users/bedopapajanian/Work/toma-appliances` (read-only pass).
Everything below is copy-paste-ready for a brand-new project that must look, feel and
behave identically.

**One-line characterisation:** Astro 7 SSR on Cloudflare Workers, Tailwind v4 (CSS-first
`@theme`, no config file), Supabase Postgres + Auth with RLS as the real security
boundary, R2 for images, Biome for lint/format, `node:test` integration tests against
the live DB inside rolled-back transactions. **Zero client-side framework JS** —
React is installed and configured but *not a single `.tsx` component exists*; every
interaction is a plain form POST plus a handful of tiny inline `<script is:inline>`
blocks.

---

## 1. Dependencies (copy-pasteable)

```json
{
  "name": "REPLACE-ME",
  "type": "module",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "astro dev",
    "build": "astro build",
    "preview": "astro preview",
    "check": "astro check",
    "lint": "biome check .",
    "format": "biome check --write .",
    "test": "node --test --test-concurrency=1 \"tests/*.test.ts\"",
    "reset": "node scripts/reset-data.mjs"
  },
  "dependencies": {
    "@astrojs/cloudflare": "^14.2.5",
    "@astrojs/react": "^6.0.4",
    "@supabase/ssr": "^0.12.5",
    "@supabase/supabase-js": "^2.112.4",
    "@tailwindcss/vite": "^4.3.3",
    "astro": "^7.2.9",
    "react": "^19.2.8",
    "react-dom": "^19.2.8",
    "tailwindcss": "^4.3.3"
  },
  "devDependencies": {
    "@astrojs/check": "^0.9.10",
    "@biomejs/biome": "^2.5.11",
    "@cloudflare/workers-types": "^5.20260911.1",
    "@types/node": "^26.4.0",
    "@types/react": "^19.2.18",
    "@types/react-dom": "^19.2.5",
    "pg": "^8.23.0",
    "supabase": "^2.116.0",
    "typescript": "^5.9.3",
    "wrangler": "^4.127.1"
  },
  "engines": {
    "node": ">=22.12.0"
  }
}
```

`.nvmrc`:

```
22.23.2
```

> **Note.** React / `@astrojs/react` / `@types/react*` are dependencies of record but
> carry **no actual usage** in the source. If the new project genuinely ships no
> islands, they can be dropped and `integrations: [react()]` removed. Keep them only
> if admin islands are planned.

> **Trap:** Astro 7 refuses to start on Node < 22.12.

---

## 2. Config files (verbatim)

### `astro.config.mjs`

```js
// @ts-check

import process from 'node:process'
import cloudflare from '@astrojs/cloudflare'
import react from '@astrojs/react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'astro/config'

export default defineConfig({
  // Server-rendered, then cached hard at Cloudflare's edge.
  // See docs/TECHNICAL_PLAN.md §3 for why this beats fully-static here.
  output: 'server',
  adapter: cloudflare({
    imageService: 'compile',
    // Lets bindings marked `"remote": true` in wrangler.jsonc reach the real
    // Cloudflare resource during `astro dev`, instead of a local stand-in.
    remoteBindings: true,
  }),
  integrations: [react()],
  site: process.env.PUBLIC_SITE_URL ?? 'http://localhost:4321',
  vite: { plugins: [tailwindcss()] },
})
```

### `wrangler.jsonc`

```jsonc
{
  // Cloudflare configuration. Astro's adapter reads the bindings from here,
  // and `platformProxy` in astro.config.mjs makes the same bindings available
  // during `astro dev` -- backed by a local simulation, so photo upload can be
  // developed and tested without a Cloudflare account or a live bucket.
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "REPLACE-ME",
  "compatibility_date": "2026-09-01",
  "compatibility_flags": ["nodejs_compat"],

  // The live site. `custom_domain` makes Cloudflare create and manage the DNS
  // record and certificate; www exists only so it can 301 to the apex, which
  // the middleware does.
  "routes": [
    { "pattern": "example.com", "custom_domain": true },
    { "pattern": "www.example.com", "custom_domain": true }
  ],
  "r2_buckets": [
    {
      "binding": "PHOTOS",
      "bucket_name": "REPLACE-ME-photos",
      // `astro dev` reads and writes the REAL bucket rather than a local
      // stand-in, so a photo taken while testing is genuinely in the cloud and
      // can be opened from another device. Needs a workers.dev subdomain on
      // the account; without one the dev server refuses to start (error 10063).
      "remote": true
      // Deliberately no `preview_bucket_name`. It does not only affect remote
      // preview: miniflare names the LOCAL on-disk store after it, so setting
      // it puts development photos under a different namespace, and removing
      // it later strands every object already written there.
    }
  ]
}
```

### `tsconfig.json`

```json
{
  "extends": "astro/tsconfigs/strict",
  "include": [".astro/types.d.ts", "**/*"],
  "exclude": ["dist"],
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react",
    "baseUrl": ".",
    "paths": {
      "@/*": ["src/*"]
    }
  }
}
```

> Note: the `@/*` alias exists but is **never used** — every import in the codebase is
> a relative path with an explicit `.ts` / `.astro` extension.

### `biome.json`

```json
{
  "$schema": "https://biomejs.dev/schemas/2.5.11/schema.json",
  "files": {
    "includes": [
      "**",
      "!dist",
      "!.astro",
      "!.wrangler",
      "!.claude",
      "!node_modules",
      "!package-lock.json"
    ]
  },
  "formatter": {
    "enabled": true,
    "indentStyle": "space",
    "indentWidth": 2,
    "lineWidth": 100
  },
  "linter": {
    "enabled": true,
    "rules": { "preset": "recommended" }
  },
  "javascript": {
    "formatter": {
      "quoteStyle": "single",
      "semicolons": "asNeeded"
    }
  },
  "css": {
    "parser": { "tailwindDirectives": true }
  },
  "overrides": [
    { "includes": ["**/*.astro"], "linter": { "enabled": false } },
    {
      "includes": ["**/tests/**"],
      "linter": { "rules": { "style": { "noNonNullAssertion": "off" } } }
    }
  ]
}
```

### `.gitignore`

```
# dependencies
node_modules/

# build output
dist/
.astro/

# cloudflare
.wrangler/

# env & secrets — NEVER commit these
.env
.env.*
!.env.example
.dev.vars

# editor / OS
.DS_Store
*.log
.vscode/
.idea/

# local-only credentials, never commit
LOGIN.local.txt
```

> **⚠️ Never gitignore `src/`.** Tailwind v4 skips gitignored paths when scanning for
> class names, so an over-broad ignore rule ships a completely unstyled site that
> still builds "successfully".

### `.env.example` (key names only; all values redacted/blank)

```bash
# ── Supabase ────────────────────────────────────────────────
# Project URL — safe to expose
PUBLIC_SUPABASE_URL=https://xxxxxxxxxxxx.supabase.co

# Publishable key (starts sb_publishable_...) — safe in the browser; RLS protects data.
# On older projects this is the "anon" key and is a long JWT.
PUBLIC_SUPABASE_PUBLISHABLE_KEY=

# 🔴 SECRET — secret key (sb_secret_...). Bypasses ALL database security.
# Not read by the app: every request runs as the signed-in user under RLS.
SUPABASE_SECRET_KEY=

# Pooler host, e.g. aws-0-us-west-1.pooler.supabase.com.
# The direct db.<ref> host is IPv6-only.
SUPABASE_DB_HOST=

# 🔴 SECRET — Postgres password, used only for running migrations
SUPABASE_DB_PASSWORD=

# ── Site ────────────────────────────────────────────────────
PUBLIC_SITE_URL=http://localhost:4321

# ── Cloudflare R2 ───────────────────────────────────────────
# Photos use the PHOTOS binding in wrangler.jsonc -- no access keys.
# Leave blank: images are served by the /img route from the binding.
# Set to https://img.<your-domain> once the bucket has a custom domain.
PUBLIC_IMAGE_BASE_URL=

# ── Testing ─────────────────────────────────────────────────
# '1' shows the destructive "Start over" control in the admin.
ALLOW_DATA_RESET=
```

### `src/env.d.ts`

```ts
/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    user?: import('@supabase/supabase-js').User
    supabase?: import('@supabase/supabase-js').SupabaseClient
  }
}

interface ImportMetaEnv {
  readonly PUBLIC_SUPABASE_URL: string
  readonly PUBLIC_SUPABASE_PUBLISHABLE_KEY: string
  readonly SUPABASE_SECRET_KEY: string
  readonly PUBLIC_SITE_URL: string
  readonly PUBLIC_IMAGE_BASE_URL: string
  /** '1' while testing: shows the reset control in the admin. */
  readonly ALLOW_DATA_RESET: string
}
interface ImportMeta {
  readonly env: ImportMetaEnv
}
```

### `.claude/launch.json` (dev-server config for the Browser pane)

```json
{
  "version": "0.0.1",
  "configurations": [
    {
      "name": "toma",
      "runtimeExecutable": "npm",
      "runtimeArgs": ["run", "dev", "--", "--port", "4322"],
      "port": 4322
    }
  ]
}
```

There is **no** `CLAUDE.md` in this project. Conventions live in `README.md` and
`docs/TECHNICAL_PLAN.md` §12.

---

## 3. Design tokens — `src/styles/global.css` (complete file)

This is the **entire** stylesheet. There is no `tailwind.config.js`, no component CSS,
no `@layer` blocks, no custom utilities. Everything else is inline Tailwind.

```css
@import "tailwindcss";

/* Toma Appliances design tokens.
   Tailwind v4 is configured in CSS — there is no tailwind.config.js. */
@theme {
  --color-ink-50: #f6f7f8;
  --color-ink-100: #eaecef;
  --color-ink-300: #b9bfc7;
  --color-ink-500: #6b7480;
  --color-ink-700: #39414c;
  --color-ink-900: #171b21;

  --color-brand-500: #1d63d1;
  --color-brand-600: #1750ac;
  --color-brand-700: #123f88;

  --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}
```

### Annotation — how each token is actually used

| Token | Hex | Role in the UI |
|---|---|---|
| `ink-50` | `#f6f7f8` | Page background for admin + login; footer band; image placeholder tiles; `hover:bg-ink-50` on ghost buttons; `hover:bg-ink-50/60` on table rows |
| `ink-100` | `#eaecef` | **The border colour.** `border-ink-100` on every card, table, input and divider; `divide-ink-100`; also `bg-ink-100` for muted status pills |
| `ink-300` | `#b9bfc7` | Tertiary/hint text (`text-ink-300`), placeholder icons, disabled state, "×" separators, footer legal text |
| `ink-500` | `#6b7480` | **Secondary body text.** Subtitles, table cell muted values, `<dt>` labels, inactive nav links |
| `ink-700` | `#39414c` | Hover target for dark buttons (`hover:bg-ink-700`), pill text on `bg-ink-50` |
| `ink-900` | `#171b21` | Primary text colour on `body`; the **dark/secondary button fill**; `theme-color` meta; `bg-ink-900/85` overlays (Sold badge), `bg-ink-900/70` (photo chrome), `bg-ink-900/40` (dialog backdrop) |
| `brand-500` | `#1d63d1` | Focus ring source (`focus:border-brand-500`, `focus:ring-brand-500/20`), tinted surfaces at low alpha (`bg-brand-500/10`, `/[0.08]`, `/[0.06]`, `/[0.04]`, `/[0.03]`), progress bar fill |
| `brand-600` | `#1750ac` | **Primary button fill**; wordmark accent; links (`text-brand-600`) |
| `brand-700` | `#123f88` | Primary button hover; active-tab text on `bg-brand-500/10`; brand-coloured notice text |

Semantic colours come from **Tailwind's own default palette**, not from `@theme`:

- success / active — `bg-emerald-50 text-emerald-800`, `bg-emerald-100 text-emerald-700/800`, `text-emerald-700`
- warning / needs-attention — `bg-amber-50 text-amber-900`, `bg-amber-100 text-amber-800`, `text-amber-700`, `border-amber-200/300`
- destructive — `bg-red-50 text-red-700`, `bg-red-100 text-red-800`, `bg-red-600 hover:bg-red-700`, `border-red-200`
- informational / open-box — `bg-sky-50 text-sky-700 ring-sky-600/20`
- sold — `bg-blue-100 text-blue-800`

### ⚠️ Known defect to fix in the new project

`border-ink-200` is used **5 times** (`AdminBar.astro` ×2, `index.astro`,
`about.astro`, `appliances/[slug].astro`) but `--color-ink-200` **is not defined**.
Tailwind v4 drops the unknown utility silently, so those "secondary / Call" buttons
render with **no border at all**. Either add `--color-ink-200: #d4d8de;` to `@theme`
or change those five to `border-ink-100`.

### Scales in use (no custom values — pure Tailwind defaults)

- **Radius:** `rounded-md` (badges/pills-in-tables), `rounded-lg` (buttons, inputs, notices, nav links — the default), `rounded-xl` (cards, product cards, hero CTAs, search input), `rounded-2xl` (photo gallery, modal, large CTA panels), `rounded-full` (filter pills, step circles, gallery arrows/dots)
- **Shadow:** `shadow-sm` (dashboard tile hover), `shadow-md` (gallery arrows, category card hover), `shadow-lg` (product card hover), `shadow-xl` (modal only). Cards at rest have **no shadow** — they are defined by `border-ink-100`.
- **Container widths:** `max-w-6xl` public, `max-w-7xl` admin, `max-w-3xl` prose pages, `max-w-2xl` settings form, `max-w-sm` login.
- **Horizontal page padding:** always `px-4 sm:px-6`.
- **Type scale:** `text-xs` (hints/meta) → `text-sm` (body/UI default) → `text-base` (inputs — deliberately, to stop iOS zoom) → `text-lg`/`text-xl` (sub-heads) → `text-2xl sm:text-3xl` (admin H1) → `text-3xl sm:text-4xl` (public page H1) → `text-4xl sm:text-6xl` (hero).
- **Numbers always carry `tabular-nums`.** Every price, count, quantity and total.
- **Headings always carry `tracking-tight`.** Uppercase eyebrows carry `tracking-wide` or `tracking-widest`.

---

## 4. UI component catalogue

Exact class strings, lifted from source.

### 4.1 Card (the universal container)

```
rounded-xl border border-ink-100 bg-white p-5
```

Hoisted to a local const on pages that repeat it:

```astro
const card = 'rounded-xl border border-ink-100 bg-white p-5'
```

Accented variant (draws attention, e.g. "drafts need pricing"):

```
rounded-xl border border-brand-500/30 bg-brand-500/[0.04] p-4
```

Danger variant (destructive zone):

```
rounded-xl border border-red-200 bg-red-50/40 p-5
```

### 4.2 Buttons

| Role | Class string |
|---|---|
| **Primary (brand)** | `rounded-lg bg-brand-600 px-5 py-2.5 font-medium text-white transition hover:bg-brand-700` |
| **Primary (dark/neutral)** | `rounded-lg bg-ink-900 px-4 py-2.5 font-medium text-white transition hover:bg-ink-700` |
| **Secondary / ghost-bordered** | `rounded-lg border border-ink-100 px-4 py-2.5 font-medium transition hover:bg-ink-50` |
| **Destructive** | `rounded-lg bg-red-600 px-5 py-2.5 font-medium text-white transition hover:bg-red-700` |
| **Warn (amber)** | `rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-amber-700` |
| **Text/link action** | `text-sm font-medium text-brand-600 hover:underline` — or `text-sm text-red-600 hover:underline` for destructive |
| **Small (in a row / toolbar)** | `rounded-lg bg-ink-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-ink-700` |
| **Hero CTA (public, large)** | `rounded-xl bg-ink-900 px-7 py-3.5 text-center font-semibold text-white transition hover:bg-ink-700` |
| **Hero CTA secondary** | `rounded-xl border border-ink-200 bg-white px-7 py-3.5 text-center font-semibold transition hover:bg-white/60` |
| **Disabled state add-on** | `disabled:cursor-not-allowed disabled:bg-ink-100 disabled:text-ink-300 disabled:hover:bg-ink-100` |
| **Nav item (inactive)** | `rounded-lg px-3 py-1.5 text-sm font-medium whitespace-nowrap transition text-ink-500 hover:bg-ink-100 hover:text-ink-900` |
| **Nav item (active)** | `rounded-lg px-3 py-1.5 text-sm font-medium whitespace-nowrap transition bg-brand-500/10 text-brand-700` |

Buttons that carry an action always use `name="intent" value="..."`:

```astro
<button type="submit" name="intent" value="publish"
  class="rounded-lg bg-brand-600 px-5 py-2.5 font-medium text-white transition hover:bg-brand-700">
  Save &amp; publish
</button>
```

### 4.3 Form input + label

The canonical input class, hoisted to a const named `field` on every form page:

```astro
const field =
  'mt-1 w-full rounded-lg border border-ink-100 bg-white px-3 py-2 text-base outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20'
```

Some pages use `py-2.5` instead of `py-2` (login, lot cost form). `text-base` is
deliberate — 16px stops iOS from zooming on focus.

**Label pattern — the label *wraps* the input; `for`/`id` only on the login page:**

```astro
<label class="block">
  <span class="text-sm font-medium">Name shown to customers</span>
  <input name="name" value={p.name} required class={field} />
</label>
```

With a hint:

```astro
<label class="block">
  <span class="text-sm font-medium">Area served <span class="font-normal text-ink-300">(optional)</span></span>
  <input name="area_text" value={b.area_text ?? ''} placeholder="e.g. San Diego County" class={field} />
  <span class="mt-1 block text-xs text-ink-300">Left blank, the site says nothing about location.</span>
</label>
```

Required marker: `<span class="text-red-600">*</span>`

**Money input** — a bordered wrapper holding a static `$` and a borderless input, so
the focus ring wraps the whole thing:

```astro
<label class="block">
  <span class="text-sm font-medium">Your price</span>
  <div class="mt-1 flex items-center rounded-lg border border-ink-100 focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-500/20">
    <span class="pl-3 text-ink-300">$</span>
    <input name="price" value={dollars(p.price_cents)} inputmode="decimal"
      class="w-full bg-transparent px-2 py-2 text-base tabular-nums outline-none" />
  </div>
</label>
```

Narrow in-table variant: wrapper gets `ml-auto flex w-28 …`, input gets
`w-full bg-transparent px-1.5 py-1.5 text-right tabular-nums outline-none`.

**Select** — same `field` class. Filter selects on the public catalogue navigate
directly: `onchange="location=this.value"` with each `<option value={someUrl}>`.

**File input:**

```
mt-1 block w-full text-sm text-ink-500 file:mr-3 file:rounded-lg file:border-0 file:bg-ink-100 file:px-4 file:py-2 file:text-sm file:font-medium file:text-ink-700 hover:file:bg-ink-300/50
```

**Checkbox (table row select):** `size-4 rounded border-ink-300`

**Search field with leading icon:**

```astro
<div class="relative flex-1">
  <svg class="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-ink-300"
       viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
    <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
  </svg>
  <input type="search" name="q" value={q} placeholder="Search by brand, model or name…"
    aria-label="Search appliances"
    class="w-full rounded-xl border border-ink-100 bg-white py-3 pr-4 pl-10 text-base outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20" />
</div>
```

### 4.4 Table

The table is always wrapped in a scrolling bordered card; the border lives on the
wrapper, never on the `<table>`.

```astro
<div class="overflow-x-auto rounded-xl border border-ink-100 bg-white">
  <table class="w-full text-sm">
    <thead class="border-b border-ink-100 text-left text-xs tracking-wide text-ink-500 uppercase">
      <tr>
        <th class="px-4 py-3 font-medium">Product</th>
        <th class="px-4 py-3 text-right font-medium">MSRP</th>
        <th class="px-4 py-3"></th>          <!-- actions column: no header text -->
      </tr>
    </thead>
    <tbody class="divide-y divide-ink-100">
      <tr class="hover:bg-ink-50/60">
        <td class="px-4 py-3">…</td>
        <td class="px-4 py-3 text-right tabular-nums">…</td>
        <td class="px-4 py-3 text-right whitespace-nowrap">…</td>
      </tr>
    </tbody>
  </table>
</div>
```

- Cell padding `px-4 py-3` (or `py-2.5` on denser tables).
- Numeric columns: `text-right tabular-nums`; muted numbers add `text-ink-500`.
- Wide tables add a min width: `class="w-full min-w-[54rem] text-sm"`.
- Primary cell link: `font-medium hover:text-brand-600 hover:underline`, with a
  `text-xs text-ink-300` sub-line beneath it.

### 4.5 Badges / pills

**Status pill (table cell), by value:**

```astro
<span class:list={['rounded-md px-2 py-0.5 text-xs font-medium',
  p.status === 'active'  ? 'bg-emerald-100 text-emerald-800'
  : p.status === 'draft'  ? 'bg-ink-100 text-ink-500'
  : p.status === 'sold'   ? 'bg-blue-100 text-blue-800'
  : p.status === 'deleted'? 'bg-red-100 text-red-700'
  : 'bg-amber-100 text-amber-800']}>{p.status}</span>
```

**Ring-style badge** (condition), driven by a helper that returns only the colours:

```astro
<span class:list={['rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
  conditionBadgeClass(p.condition)]}>{conditionLabel(p.condition)}</span>
```

```ts
// src/lib/condition.ts
export function conditionBadgeClass(c: string | null | undefined): string {
  switch (c) {
    case 'new':          return 'bg-emerald-50 text-emerald-700 ring-emerald-600/20'
    case 'open_box':     return 'bg-sky-50 text-sky-700 ring-sky-600/20'
    case 'scratch_dent': return 'bg-amber-50 text-amber-800 ring-amber-600/20'
    case 'for_parts':    return 'bg-red-50 text-red-700 ring-red-600/20'
    default:             return 'bg-ink-50 text-ink-700 ring-ink-600/20'
  }
}
```

**Inline warning chip** (e.g. "needs price"):
`rounded-md bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800`

**Overlay badge** (on an image, e.g. "Sold"):
`absolute top-2 left-2 rounded-md bg-ink-900/85 px-2 py-1 text-xs font-semibold tracking-wide text-white uppercase`

**Filter pill (public, rounded-full):**

```astro
const pill = 'rounded-full px-3 py-1.5 text-sm font-medium whitespace-nowrap transition'
// selected:  `${pill} bg-ink-900 text-white`
// unselected:`${pill} bg-ink-50 text-ink-700 hover:bg-ink-100`
```

**Removable active-filter chip:**
`inline-flex items-center gap-1.5 rounded-full bg-brand-500/10 px-3 py-1 font-medium text-brand-700 hover:bg-brand-500/20`

**Admin tab (rounded-lg, not full):**
active `bg-brand-500/10 text-brand-700`, inactive `text-ink-500 hover:bg-ink-100`,
both on `rounded-lg px-3 py-1.5 text-sm font-medium transition`.

### 4.6 Alerts / notices / banners

All are one-line `<p>` elements at the top of the page body, `mb-5`:

| Tone | Class string |
|---|---|
| Success | `mb-5 rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-800` |
| Error | `mb-5 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700` |
| Error (stronger) | `mb-5 rounded-lg bg-red-100 px-4 py-3 text-sm text-red-800` |
| Warning | `mb-5 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900` |
| Info (brand) | `mb-5 rounded-lg bg-brand-500/[0.08] px-4 py-3 text-sm text-brand-700` |

Multi-line call-to-action banner (title + body + button on one row):

```astro
<div class="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-brand-500/30 bg-brand-500/[0.04] p-4">
  <div class="min-w-0 flex-1">
    <p class="font-medium">{draftCount} drafts need pricing</p>
    <p class="mt-0.5 text-sm text-ink-500">Drafts are invisible to customers.</p>
  </div>
  <a href="/admin/products/pricing"
    class="rounded-lg bg-brand-600 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-brand-700">
    Set prices →
  </a>
</div>
```

Amber variant swaps to `border-amber-300 bg-amber-50` with `text-amber-900` /
`text-amber-800`.

### 4.7 Empty state

Always a **dashed** border, centred, with a short title, an explanatory sentence and
optionally one button.

```astro
<div class="rounded-xl border border-dashed border-ink-100 bg-white p-10 text-center">
  <p class="font-medium">No products yet</p>
  <p class="mx-auto mt-2 max-w-md text-sm text-ink-500">
    Import a manifest or add an appliance by hand to get started.
  </p>
  <a href="/admin/import"
    class="mt-4 inline-block rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700">
    Review imports →
  </a>
</div>
```

Public variant uses `p-12` and no `bg-white`. Text-only variant collapses to a single
`<p class="rounded-xl border border-dashed border-ink-100 bg-white p-10 text-center text-sm text-ink-500">`.

### 4.8 Stat tile / KPI

```astro
<div class="rounded-xl border border-ink-100 bg-white p-5">
  <div class="text-xs tracking-wide text-ink-500 uppercase">Units sold</div>
  <div class="mt-1 text-3xl font-semibold tabular-nums">{units}</div>
  <div class="mt-1 text-xs text-ink-500">3 returned · $1,200.00 refunded</div>
</div>
```

Grid: `grid gap-4 sm:grid-cols-2 lg:grid-cols-4` (or `sm:grid-cols-3` for three).
Clickable dashboard tile: same box, as an `<a>`, with
`transition hover:shadow-sm` plus optional accent
`border-brand-500/40 bg-brand-500/[0.03]`.

### 4.9 Sticky action bar (bottom of a long form / bulk select)

```astro
<div class="sticky bottom-0 mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-ink-100 bg-white/95 p-4 backdrop-blur">
  <span class="flex-1 text-sm text-ink-500">{list.length} drafts.</span>
  <button …>Save prices</button>
  <button …>Save &amp; publish</button>
</div>
```

### 4.10 Progress bar

```astro
<div class="mt-2 h-1.5 overflow-hidden rounded-full bg-ink-100">
  <div class="h-full rounded-full bg-brand-500 transition-all" style={`width:${pct}%`}></div>
</div>
```

### 4.11 Stepper — `src/components/admin/Stepper.astro`

**Props:** `{ current: 1|2|3|4; importId?: string; lotId?: string; done?: number[] }`

Renders an `<ol class="mb-6 flex flex-wrap items-center gap-x-2 gap-y-2 text-sm">`
with a `→` separator `<li aria-hidden="true" class="text-ink-300">` between items.
Each step is an `<a>` when reachable, `<span>` when not.

Step wrapper: `flex items-center gap-2 rounded-lg px-2.5 py-1.5 transition` plus
- current: `bg-brand-500/10 font-medium text-brand-700`
- done: `text-ink-500 hover:bg-ink-100`
- reachable-but-unfinished: `text-amber-700 hover:bg-amber-50`
- unreachable: `text-ink-300`

Step numeral circle: `flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold` plus
- current: `bg-brand-600 text-white`
- done: `bg-emerald-100 text-emerald-700` (renders `✓`)
- reachable: `bg-amber-100 text-amber-700`
- unreachable: `bg-ink-100 text-ink-300`

> Design note carried in the source: "done" means genuinely finished, which is separate
> from "reachable" (any step ≤ current).

### 4.12 Confirm dialog — `src/components/admin/ConfirmAction.astro`

The single most transferable component. A native `<dialog>` + one delegated document
listener shared by every instance on the page. The trigger is `type="button"` so it can
never submit; only the confirm button submits, and it does so by **injecting a hidden
`intent` input into the enclosing `<form>`**.

**Props:**

```ts
interface Props {
  intent: string            // becomes <input name="intent" value=…>
  label: string             // trigger button text
  title: string             // dialog heading
  message: string           // dialog body
  confirmLabel?: string     // defaults to `label`
  tone?: 'danger' | 'warn'  // red-600 vs amber-600
  fieldName?: string        // optional extra hidden field, e.g. 'single_id'
  fieldValue?: string
  class?: string            // classes for the trigger
}
```

Markup:

```astro
const uid = `ca-${Math.random().toString(36).slice(2, 10)}`   // unique per instance
const confirmClasses =
  tone === 'danger' ? 'bg-red-600 hover:bg-red-700' : 'bg-amber-600 hover:bg-amber-700'
---
<button type="button" class={className} data-confirm-open={uid}>{label}</button>

<dialog id={uid} data-intent={intent} data-field-name={fieldName} data-field-value={fieldValue}
  class="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-2xl border border-ink-100 p-0 text-left font-sans text-base normal-case whitespace-normal text-ink-900 shadow-xl backdrop:bg-ink-900/40">
  <div class="p-6">
    <h2 class="text-lg font-semibold tracking-tight text-balance">{title}</h2>
    <p class="mt-2 text-sm break-words text-ink-500">{message}</p>
    <div class="mt-6 flex justify-end gap-3">
      <button type="button" data-confirm-cancel
        class="rounded-lg border border-ink-100 px-4 py-2 text-sm font-medium transition hover:bg-ink-50">
        Cancel
      </button>
      <button type="button" data-confirm-go
        class={`rounded-lg px-4 py-2 text-sm font-medium text-white transition ${confirmClasses}`}>
        {confirmLabel}
      </button>
    </div>
  </div>
</dialog>
```

**Two non-obvious details to carry over:**

1. The dialog carries `text-left font-sans text-base normal-case whitespace-normal` as
   *deliberate resets* — `<dialog>` renders in the browser's top layer but still
   **inherits** from its DOM parent, and it is often placed inside a
   `text-right whitespace-nowrap` table cell.
2. `form.submit()` bypasses the `submit` event, so the script must invoke the global
   busy helper (`window.__tomaBusy`) by hand, or the page sits silent.

Script (one delegated listener, guarded by `window.__confirmActionWired`):

```ts
if (!(window as any).__confirmActionWired) {
  ;(window as any).__confirmActionWired = true
  document.addEventListener('click', (event) => {
    const target = event.target as HTMLElement

    const opener = target.closest<HTMLElement>('[data-confirm-open]')
    if (opener) {
      const dialog = document.getElementById(opener.dataset.confirmOpen!) as HTMLDialogElement | null
      if (dialog) {
        const owner = opener.closest('form')
        if (!owner) console.error('ConfirmAction has no <form> ancestor', opener)
        ;(dialog as any).__form = owner    // top layer breaks closest() later
        dialog.showModal()
      }
      return
    }
    if (target.closest('[data-confirm-cancel]')) { target.closest('dialog')?.close(); return }

    const go = target.closest<HTMLElement>('[data-confirm-go]')
    if (go) {
      const dialog = go.closest('dialog') as (HTMLDialogElement & { __form?: HTMLFormElement }) | null
      const form = dialog?.__form
      if (!dialog || !form) return
      const add = (name: string, value: string) => {
        const i = document.createElement('input')
        i.type = 'hidden'; i.name = name; i.value = value; form.append(i)
      }
      add('intent', dialog.dataset.intent!)
      if (dialog.dataset.fieldName) add(dialog.dataset.fieldName, dialog.dataset.fieldValue ?? '')
      const cancel = dialog.querySelector<HTMLButtonElement>('[data-confirm-cancel]')
      if (cancel) cancel.disabled = true       // keep modal open so the spinner shows
      const busy = (window as any).__tomaBusy
      if (typeof busy === 'function' && busy(form, go) === false) return
      go.setAttribute('disabled', 'true')
      form.submit()
    }
  })
}
```

Usage:

```astro
<ConfirmAction intent="delete" label="Delete"
  title="Delete this product?"
  message={`"${p.name}" comes off the site. Its sales history is kept and you can restore it from the Deleted tab.`}
  confirmLabel="Delete" tone="danger"
  fieldName="single_id" fieldValue={p.id}
  class="text-sm text-red-600 hover:underline" />
```

### 4.13 Other components (API summary)

| Component | Props | Notes |
|---|---|---|
| `public/ProductCard.astro` | `{ product: {slug,name,brand,price_cents,condition,status,qty_available}; photo?: {r2_key, format}\|null; showExactQuantity?: boolean; eager?: boolean }` | Root is an `<a class="group flex flex-col overflow-hidden rounded-xl border border-ink-100 bg-white transition hover:-translate-y-0.5 hover:border-ink-300 hover:shadow-lg">`. Image well is `relative aspect-[4/3] overflow-hidden bg-ink-50`, image `size-full object-cover transition duration-300 group-hover:scale-[1.03]`. Body `flex flex-1 flex-col p-4`; price uses `mt-auto pt-4 text-xl font-semibold tabular-nums`. `eager` drives `loading="eager"` for the first row. |
| `public/PhotoGallery.astro` | `{ shots: Shot[]; name: string; sold: boolean }` | CSS scroll-snap, **works with zero JS** (thumbnails are in-page anchors). Strip: `flex snap-x snap-mandatory overflow-x-auto scroll-smooth rounded-2xl border border-ink-100 bg-ink-50 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden`. Arrows are `hidden` until the script runs. Progressive-enhancement script uses `scrollIntoView({behavior:'smooth', inline:'center', block:'nearest'})` and an `IntersectionObserver` on the strip (threshold 0.6) as the source of truth for which slide is active. |
| `public/AdminBar.astro` | `{ productId, priceCents, condition, qtyAvailable, photoCount, sold }` | `<aside class="mb-6 rounded-xl border border-brand-500/25 bg-brand-500/[0.04] p-4">`. Deliberately **links only, never forms** — business rules live in the admin and a second set of controls would drift. |
| `admin/PhotoUploader.astro` | `{ productId: string; photos: Photo[]; compact?: boolean }` | `accept="image/*"` with **no `capture`** so a phone offers camera *and* gallery. Resizes on-device to three sizes then POSTs multipart to `/api/admin/photos`. Add-tile: `flex aspect-square cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed border-ink-100 text-center transition hover:border-brand-500 hover:bg-brand-500/[0.04]`. Emits a bubbling `photos:changed` CustomEvent so a parent page can update a counter. |

---

## 5. Page layout patterns

### 5.1 `src/layouts/Public.astro` — storefront shell

**Props:** `{ business: Business; title: string; description?: string; image?: string; noindex?: boolean }`

Frontmatter computes:

```ts
const looksSignedIn = (Astro.request.headers.get('cookie') ?? '').includes('sb-')
const site = Astro.site ?? new URL('http://localhost:4321')
const canonical = new URL(Astro.url.pathname, site).toString()
const fullTitle = title === business.name ? title : `${title} · ${business.name}`
const tel = telHref(business.phone)
const nav = [
  { href: '/appliances', label: 'All appliances', short: 'Browse' },
  { href: '/about',      label: 'About',          short: 'About' },
]
```

`<head>` (the full meta set):

```astro
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>{fullTitle}</title>
{description && <meta name="description" content={description} />}
<link rel="canonical" href={canonical} />
{noindex && <meta name="robots" content="noindex, follow" />}

<meta property="og:type" content="website" />
<meta property="og:title" content={fullTitle} />
{description && <meta property="og:description" content={description} />}
<meta property="og:url" content={canonical} />
{image && <meta property="og:image" content={image} />}
<meta name="twitter:card" content={image ? 'summary_large_image' : 'summary'} />

<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<meta name="theme-color" content="#171b21" />
```

Body / chrome:

```astro
<html lang="en" class="scroll-smooth">
<body class="min-h-dvh bg-white font-sans text-ink-900 antialiased">
  <a href="#main" class="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-3 focus:rounded-lg focus:bg-ink-900 focus:px-4 focus:py-2 focus:text-white">
    Skip to content
  </a>

  <header class="sticky top-0 z-40 border-b border-ink-100 bg-white/85 backdrop-blur">
    <div class="mx-auto flex max-w-6xl items-center gap-4 px-4 py-3.5 sm:px-6">
      <a href="/" class="shrink-0 text-base font-semibold tracking-tight whitespace-nowrap sm:text-lg">
        Toma<span class="text-brand-600">Appliances</span>
      </a>
      <nav class="ml-auto flex items-center gap-0.5 text-sm sm:gap-1"> … </nav>
    </div>
  </header>

  <main id="main"><slot /></main>

  <footer class="mt-20 border-t border-ink-100 bg-ink-50">
    <div class="mx-auto grid max-w-6xl gap-8 px-4 py-12 sm:grid-cols-3 sm:px-6"> … </div>
    <div class="border-t border-ink-100">
      <div class="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-5 text-xs text-ink-300 sm:px-6"> … </div>
    </div>
  </footer>
</body>
</html>
```

Nav links carry a responsive short/long label pair (`<span class="sm:hidden">{short}</span>`
+ `<span class="hidden sm:inline">{label}</span>`) because a phone header has ~120px to
spare. Active state: `text-ink-900`; inactive: `text-ink-500 hover:bg-ink-50 hover:text-ink-900`.
The trailing `Call` button is `ml-0.5 shrink-0 rounded-lg bg-ink-900 px-3 py-2 font-medium whitespace-nowrap text-white transition hover:bg-ink-700 sm:ml-1 sm:px-3.5`.

### 5.2 `src/layouts/Admin.astro` — back-office shell

**Props:** `{ title: string; subtitle?: string }`.
Reads `Astro.locals.user?.email` and `Astro.url.pathname`.

```astro
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="robots" content="noindex, nofollow" />
  <title>{title} · Toma Admin</title>
</head>
<body class="min-h-dvh bg-ink-50 font-sans text-ink-900 antialiased">
  <div id="progress" aria-hidden="true"
    class="pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5 origin-left scale-x-0 bg-brand-500 opacity-0 transition-transform duration-300"></div>

  <header class="sticky top-0 z-10 border-b border-ink-100 bg-white/85 backdrop-blur">
    <div class="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3 sm:px-6">
      <a href="/admin" class="font-semibold tracking-tight">Toma<span class="text-brand-600">Admin</span></a>
      <nav class="flex flex-1 gap-1 overflow-x-auto"> … </nav>
      <span class="hidden text-xs text-ink-300 sm:block">{email}</span>
      <form method="POST" action="/logout" class="shrink-0">
        <button type="submit"
          class="rounded-lg px-2.5 py-1.5 text-sm font-medium text-ink-500 transition hover:bg-ink-100 hover:text-ink-900">
          Sign out
        </button>
      </form>
    </div>
  </header>

  <main class="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
    <div class="mb-6">
      <h1 class="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
      {subtitle && <p class="mt-1 text-sm text-ink-500">{subtitle}</p>}
    </div>
    <slot />
  </main>
  …busy script…
</body>
```

Nav active test: `path === n.href || (n.href !== '/admin' && path.startsWith(n.href))`.

**The global busy/progress script** (`<script is:inline>` at the bottom of the layout) is
essential to the feel and must be ported. It:

1. Draws a top progress bar that creeps to 90% over 10s and is finished by the page load.
2. On any `submit` (captured at document level), calls `markBusy(form, event.submitter)`:
   disables every `<button>` in the form, swaps the pressed button's innerHTML for an
   inline SVG spinner + `"Label…"` (or `"Working…"` if the label is >18 chars), sets
   `aria-busy`, and starts the bar. A second submit is swallowed via `form.dataset.busy`.
3. **Critical fix baked in:** a disabled control is excluded from submitted form data —
   including the button just pressed — so `intent=sell` would never reach the server.
   `markBusy` therefore copies the submitter's `name`/`value` into a hidden
   `input[data-carried-intent="1"]` *before* disabling anything.
4. Exposes `window.__tomaBusy` so `ConfirmAction`'s `form.submit()` can trigger it.
5. Starts the bar on plain internal link clicks too (skipping `target`, `#`, `http`,
   and modifier-clicks).
6. On `pageshow` with `event.persisted` (bfcache back-button), removes stale carried
   inputs, unlocks every form and restores every button's `prevHtml`.

### 5.3 Marketing / public home page

Skeleton: full-bleed tinted hero section → category grid → product grid → three-up
value props on a tinted band.

```astro
<section class="border-b border-ink-100 bg-ink-50">
  <div class="mx-auto max-w-6xl px-4 py-16 sm:px-6 sm:py-24">
    <p class="text-sm font-medium tracking-widest text-brand-600 uppercase">{eyebrow}</p>
    <h1 class="mt-4 max-w-3xl text-4xl font-semibold tracking-tight sm:text-6xl">…</h1>
    <p class="mt-5 max-w-2xl text-lg text-ink-500">…</p>
    <div class="mt-8 flex flex-col gap-3 sm:flex-row"> …two CTAs… </div>
  </div>
</section>

<section class="mx-auto max-w-6xl px-4 py-14 sm:px-6">
  <div class="flex items-baseline justify-between gap-4">
    <h2 class="text-2xl font-semibold tracking-tight">Just arrived</h2>
    <a href="/appliances" class="text-sm font-medium text-brand-600 hover:underline">See all →</a>
  </div>
  <div class="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4"> …cards… </div>
</section>
```

Product grid is **always** `grid grid-cols-2 gap-4 lg:grid-cols-4` (two-up on phones —
never one-up).

### 5.4 Public list page with filters (`/appliances`)

The defining convention: **every filter is a plain GET parameter and every control is a
link or a form — no client JavaScript.** A filtered view stays shareable, indexable,
and usable on bad signal.

Skeleton, in order:

1. `<h1 class="text-3xl font-semibold tracking-tight sm:text-4xl">{heading}</h1>`
2. Search form `method="GET"` with hidden inputs preserving the other filters.
3. Horizontally-scrolling category pill row:
   `<div class="mt-5 -mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0"><div class="flex gap-2">…`
4. Filter bar: `<div class="mt-4 flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-ink-100 pt-4 text-sm">`
   containing `<label class="flex items-center gap-2"><span class="text-ink-500">Brand</span><select onchange="location=this.value" …>`
5. Active-filter chips row, each linking to the URL with that param removed.
6. Result count `<p class="mt-6 text-sm text-ink-500">`.
7. Grid **or** empty state.

The URL builder is the load-bearing helper:

```ts
/** Build a link that keeps the other filters intact. */
function withParam(key: string, value: string): string {
  const next = new URLSearchParams(params)
  if (value) next.set(key, value)
  else next.delete(key)
  const s = next.toString()
  return `/appliances${s ? `?${s}` : ''}`
}
```

Facets are computed from the **unfiltered** set, "so a filter never hides the way back
out of itself."

### 5.5 Public detail page (`/appliances/[slug]`)

- Optional signed-in `AdminBar` at the very top.
- Breadcrumb `<nav aria-label="Breadcrumb" class="flex flex-wrap items-center gap-1.5 text-sm text-ink-500">`.
- Two-column split: `<div class="mt-6 grid gap-8 lg:grid-cols-2 lg:gap-12">` — gallery left, everything else right.
- Price block: `text-4xl font-semibold tabular-nums` beside a condition ring badge.
- Two equal CTAs: `<div class="mt-6 flex flex-col gap-3 sm:flex-row">` with each button `flex-1 rounded-xl … px-6 py-3.5 text-center font-semibold`.
- Spec list as a definition list with dividers:
  `<dl class="mt-3 divide-y divide-ink-100 text-sm">` containing
  `<div class="flex justify-between gap-4 py-2.5"><dt class="text-ink-500">…</dt><dd class="text-right font-medium">…</dd></div>`.
- Section separators: `mt-8 border-t border-ink-100 pt-6`.
- Related items grid at the bottom under `<section class="mt-20">`.
- Emits JSON-LD `Product` structured data via
  `<script type="application/ld+json" set:html={JSON.stringify(jsonLd)} />`.
- Missing record handling: `if (!product) return Astro.redirect('/appliances', 302)`.

### 5.6 Admin list page (`/admin/products`)

Order of elements inside `<Admin>`:

1. `{notice && <p class="mb-5 rounded-lg bg-emerald-50 …">}` and any query-param-driven
   success banners.
2. A call-to-action banner if there is outstanding work.
3. Status tab row: `<div class="mb-4 flex flex-wrap items-center gap-1">` with the
   "Deleted" tab pushed right via `ml-auto`.
4. Empty state **or** `<form method="POST" id="bulk">` wrapping the table.
5. Sticky bulk bar inside the same form, hidden until a checkbox is ticked.
6. A tiny `<script is:inline>` that syncs the select-all checkbox and toggles
   `hidden` / `flex` on the bulk bar.

### 5.7 Admin form / detail page (`/admin/products/[id]`)

Two-column asymmetric grid — main form left, stacked info cards right:

```astro
<div class="grid gap-6 lg:grid-cols-[1fr_minmax(0,20rem)]">
  <form method="POST" class="space-y-4 rounded-xl border border-ink-100 bg-white p-5"> … </form>
  <div class="space-y-4"> …cards… </div>
</div>
```

(The lot page inverts it: `lg:grid-cols-[22rem_minmax(0,1fr)]`, form narrow on the left.)

- Paired fields: `<div class="grid gap-4 sm:grid-cols-2">`.
- Form footer: `<div class="flex flex-wrap items-center gap-3 border-t border-ink-100 pt-4">`
  with primary button, a plain "Back to …" link, and a `ml-auto` destructive
  `ConfirmAction`.
- Right-hand cards hold read-only `<dl>` money summaries, a big `text-3xl font-semibold tabular-nums`
  stock figure, a secondary "Record a sale" form, a history list, and the PhotoUploader.
- Anchor-target forms get `id="sell" class="scroll-mt-24 …"` so a `#sell` deep link
  from the public AdminBar lands correctly, plus an inline script that focuses the
  price field on the frame after `load`.

### 5.8 Admin dashboard (`/admin`)

`<div class="grid gap-4 sm:grid-cols-3">` of clickable stat tiles, then a prompt
paragraph, then (gated on `ALLOW_DATA_RESET`) a red "Start over" section with a
type-`RESET`-to-confirm input.

### 5.9 Login page (`src/pages/login.astro`)

Standalone — does **not** use a layout; imports `global.css` directly and writes its own
`<html>`. Centred column:

```astro
<body class="min-h-dvh bg-ink-50 font-sans text-ink-900 antialiased">
  <main class="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6">
    <h1 class="text-2xl font-semibold tracking-tight">Toma<span class="text-brand-600">Admin</span></h1>
    <p class="mt-1 text-sm text-ink-500">Sign in to manage inventory.</p>
    …error / signed-out notices…
    <form method="POST" class="mt-6 space-y-4">
      <input type="hidden" name="next" value={next} />
      …email + password with for/id labels…
      <button type="submit" class="w-full rounded-lg bg-brand-600 px-4 py-2.5 font-medium text-white transition hover:bg-brand-700">Sign in</button>
    </form>
    <p class="mt-6 text-xs text-ink-300">Accounts are created by invitation only.</p>
  </main>
</body>
```

---

## 6. Auth & middleware pattern

### `src/lib/supabase/server.ts` (complete)

```ts
import { createServerClient } from '@supabase/ssr'
import { createClient } from '@supabase/supabase-js'
import type { AstroCookies } from 'astro'

// Optional-chained because this module is imported by code that also holds
// pure helpers, and those get exercised by the test runner -- where Vite does
// not exist and `import.meta.env` is undefined.
const url = import.meta.env?.PUBLIC_SUPABASE_URL
const publishable = import.meta.env?.PUBLIC_SUPABASE_PUBLISHABLE_KEY

/**
 * Request-scoped client that carries the signed-in user's session.
 * Row Level Security applies — this is what admin pages should use.
 */
export function createSupabaseServerClient(cookies: AstroCookies, request: Request) {
  return createServerClient(url, publishable, {
    cookies: {
      // AstroCookies has no getAll(), so read the request header directly.
      getAll: () => parseCookieHeader(request.headers.get('cookie') ?? ''),
      setAll: (list) => {
        // `secure` would stop the cookie being stored at all on local http.
        const secure = new URL(request.url).protocol === 'https:'
        for (const { name, value, options } of list) {
          cookies.set(name, value, {
            ...options,
            path: '/',
            httpOnly: true,          // nothing in the browser reads it
            secure,
            sameSite: 'lax',
            maxAge: 400 * 24 * 60 * 60,  // 400 days, the longest a browser honours
          })
        }
      },
    },
  })
}

/** "a=1; b=2" -> [{ name: 'a', value: '1' }, ...] */
function parseCookieHeader(header: string): { name: string; value: string }[] {
  if (!header) return []
  return header
    .split(';')
    .map((part) => {
      const eq = part.indexOf('=')
      if (eq < 0) return null
      const name = part.slice(0, eq).trim()
      if (!name) return null
      return { name, value: decodeURIComponent(part.slice(eq + 1).trim()) }
    })
    .filter((c): c is { name: string; value: string } => c !== null)
}

/**
 * Anonymous client for the public catalog. Sees only what RLS and the column
 * grants allow — no costs, no MSRP.
 */
export function createPublicClient() {
  return createClient(url, publishable, { auth: { persistSession: false } })
}

// There is deliberately NO service-role client. Every request acts as the
// signed-in user. If a job ever genuinely has to act as the system, add it
// back deliberately -- `import.meta.env` reads SUPABASE_SECRET_KEY from the
// Worker environment at runtime rather than baking it into the bundle, so
// `wrangler secret put SUPABASE_SECRET_KEY` is all it needs.
```

### `src/middleware.ts` (complete)

```ts
import { defineMiddleware } from 'astro:middleware'
import { createSupabaseServerClient } from './lib/supabase/server.ts'

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url

  // One canonical hostname: www 301s to the apex, so Google does not index twice.
  const host = context.url.hostname
  if (host.startsWith('www.')) {
    const target = new URL(context.url)
    target.hostname = host.slice(4)
    return context.redirect(target.toString(), 301)
  }

  const isApi = pathname.startsWith('/api/admin')

  if (isApi || pathname.startsWith('/admin')) {
    const supabase = createSupabaseServerClient(context.cookies, context.request)
    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      // A redirect to a login page is a confusing answer to fetch().
      return isApi
        ? new Response(JSON.stringify({ error: 'Not signed in.' }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          })
        : context.redirect(`/login?next=${encodeURIComponent(pathname)}`, 302)
    }
    context.locals.user = user
    context.locals.supabase = supabase

    const response = await next()
    response.headers.set('Cache-Control', 'private, no-store')
    return response
  }

  return next()
})
```

Consequences for page code: every admin page starts with
`const supabase = Astro.locals.supabase!` — the guard has already proven it exists.

### Login (POST handled in the page's own frontmatter)

```ts
let error = ''
const next = Astro.url.searchParams.get('next') ?? '/admin'

if (Astro.request.method === 'POST') {
  const form = await Astro.request.formData()
  const email = String(form.get('email') ?? '')
  const password = String(form.get('password') ?? '')
  const supabase = createSupabaseServerClient(Astro.cookies, Astro.request)
  const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })
  if (signInError) error = signInError.message
  else return Astro.redirect(String(form.get('next') ?? '/admin'), 303)
}
```

### Logout — `src/pages/logout.ts`

POST-only ("a link that ends your session is a link a prefetcher can follow"), and it
clears every `sb-*` cookie by hand because auth cookies are chunked when large:

```ts
export const POST: APIRoute = async ({ cookies, request, redirect }) => {
  const supabase = createSupabaseServerClient(cookies, request)
  await supabase.auth.signOut()

  const header = request.headers.get('cookie') ?? ''
  for (const part of header.split(';')) {
    const name = part.split('=')[0]?.trim()
    if (name?.startsWith('sb-')) cookies.delete(name, { path: '/' })
  }
  return redirect('/login?signedout=1', 303)
}
```

### "Looks signed in" heuristic (public pages)

```ts
const looksSignedIn = (Astro.request.headers.get('cookie') ?? '').includes('sb-')
```

Presence only, **never verified** — verifying means a Supabase round trip on every
public page view, and the answer only decides whether to draw a link. Explicitly not
a security measure.

---

## 7. Data layer

### Client selection rule

| Context | Client | Why |
|---|---|---|
| Public pages, sitemap | `createPublicClient()` | Runs as `anon`; sees only the `catalog` / `public_business` views |
| Admin pages, admin API | `Astro.locals.supabase!` | Request-scoped, carries the user's session, RLS applies as that user |
| Migrations, tests, CLI scripts | raw `pg.Client` over the pooler | Needs DDL and transactions |
| Service role | **does not exist** | Deliberately removed |

### Query conventions

- Always destructure: `const { data, error } = await …`; `const { data: rows } = …`.
- Always coalesce: `const list = rows ?? []`.
- Parallelise with a single `Promise.all([...])` destructured into named results:
  ```ts
  const [{ data: cats }, { data: stock }, { count: draftCount }] = await Promise.all([…])
  ```
- Counts use `.select('*', { count: 'exact', head: true })`.
- Single row: `.single()` when it must exist, `.maybeSingle()` when it may not.
- Conditional filters build the query up in a `let`:
  ```ts
  let query = supabase.from('catalog').select('*')
  if (!includeSold) query = query.eq('status', 'active')
  if (brand) query = query.eq('brand', brand)
  ```
- Joins are lifted into `Map`s in the frontmatter rather than looped queries:
  ```ts
  const catName = new Map((cats ?? []).map((c) => [c.id, c.name]))
  const mainPhoto = new Map<string, {...}>()
  for (const r of photoRows ?? []) if (!mainPhoto.has(r.product_id)) mainPhoto.set(r.product_id, r)
  ```
- Free-text search sanitises the PostgREST `or` pattern:
  ```ts
  const safe = q.replace(/[,()]/g, ' ')
  query = query.or(`name.ilike.%${safe}%,brand.ilike.%${safe}%,model.ilike.%${safe}%`)
  ```
- Hard caps on every list: `.limit(300)` admin, `.limit(300)` catalogue, `.limit(5000)` sitemap.
- Business logic that must be atomic lives in **Postgres functions** called via
  `supabase.rpc('commit_import', {...})` / `rpc('revert_import')` / `rpc('return_sale')` /
  `rpc('reset_test_data')`.

### Three non-negotiable data rules

1. **All money is integer cents.** `price_cents INTEGER`, never float. Cost allocation
   divides a lump sum across dozens of units — exactly where float drifts.
2. **Quantity is derived, never stored.**
   `qty_available = SUM(stock_lines.qty_received) - SUM(sales.qty)`, exposed by a view.
3. **Nothing is ever hard-deleted.** `status = 'deleted'` hides it everywhere; sales and
   import history stay intact.

### RLS / grants assumptions

Two layers, both enforced by Postgres:

```sql
-- 1. RLS policies — which ROWS you can see
alter table products enable row level security;

create policy products_authenticated_all on products
  for all to authenticated using (true) with check (true);

create policy products_public_read on products
  for select to anon using (status in ('active', 'sold'));

-- 2. Column GRANTs — which COLUMNS you can see.
-- RLS alone cannot hide a column, and cost/MSRP live beside public fields.
revoke all on products from anon;
grant select (
  id, upc, brand, model, name, slug, description,
  category_id, price_cents, status, published_at, created_at
) on products to anon;
```

The authenticated policies are created in a loop:

```sql
do $$
declare t text;
begin
  foreach t in array array['profiles','sources','categories','lots','products', …] loop
    execute format(
      'create policy %I on %I for all to authenticated using (true) with check (true)',
      t || '_authenticated_all', t
    );
  end loop;
end $$;
```

**⚠️ `security_invoker` views silently zero out aggregates.** A view that sums tables
`anon` has no policy on recomputes under the caller's RLS and returns 0 with no error.
Anything the public reads goes through a **definer** view whose own `WHERE` clause is
the gate:

```sql
create view catalog with (security_invoker = false) as
select p.id, p.brand, p.name, p.slug, p.price_cents, p.condition, p.status,
       coalesce(sl.qty_received, 0) - coalesce(sa.qty_sold, 0) as qty_available
from products p
left join (select product_id, sum(qty_received)::int as qty_received
           from stock_lines group by product_id) sl on sl.product_id = p.id
…
where p.status in ('active','sold');

grant select on catalog to anon;
```

**Revoke, don't just rely on RLS** — Supabase grants `anon` a blanket table grant on the
public schema, so one mistaken `create policy … to anon` would expose purchase prices.

### Migration workflow

- `supabase/migrations/NNNN_slug.sql`, four-digit zero-padded, applied in filename order.
- Each file opens with a boxed header comment stating what it changes and **why**:
  ```sql
  -- ═══════════════════════════════════════════════════════════════════
  -- Public catalog: real stock counts, and condition on show
  -- ═══════════════════════════════════════════════════════════════════
  ```
- Never hand-edit in the dashboard. The schema lives in git.
- Applied by `node scripts/migrate.mjs`, which:
  - parses `.env` by hand (no dotenv dependency),
  - derives the project ref from `PUBLIC_SUPABASE_URL` and connects as
    `postgres.<ref>` to `SUPABASE_DB_HOST:5432` with `ssl: { rejectUnauthorized: false }`,
  - creates `_migrations (name primary key, applied_at)`, enables RLS on it and
    revokes it from `anon`,
  - runs each unapplied file inside `begin`/`commit`, rolling back and exiting 1 on
    failure while printing the failing line number from `e.position`,
  - logs `⏭ / ✅ / ❌` per file and a final applied/skipped count.

> **Trap:** the direct host `db.<ref>.supabase.co` is IPv6-only. Use the IPv4 pooler in
> **session mode on port 5432** — port 6543 is transaction mode and cannot run DDL.

### Data-reset workflow (`npm run reset`)

`scripts/reset-data.mjs` — dry-run by default, `--yes` then requires typing `RESET` at a
TTY. Holds explicit `WIPE` and `KEEP` table lists, queries
`information_schema` for any table with an FK *into* the wipe list that is in neither
list and **refuses to run** if it finds one, truncates in one transaction, then clears
`.wrangler/state/v3/r2`. The in-app equivalent (`rpc('reset_test_data')` + R2 `list`/`delete`
loop) exists because only the Worker holds the bucket binding.

---

## 8. API & form-handling convention

### The default is a form POST to the page itself, not an API route

There are exactly **two** API routes in the whole app (`/api/admin/photos`, `/img/[...key]`)
plus `logout.ts`, `robots.txt.ts`, `sitemap.xml.ts`. Everything else is handled in the
`.astro` page's own frontmatter.

**The canonical page-POST shape:**

```ts
const supabase = Astro.locals.supabase!
let notice = ''
let error = ''

if (Astro.request.method === 'POST') {
  const form = await Astro.request.formData()
  const intent = String(form.get('intent') ?? 'save')

  if (intent === 'sell') {
    …validate…
    if (bad) error = 'Enter what it sold for.'
    else {
      const { error: e } = await supabase.from('sales').insert({ … })
      if (e) error = e.message
      // Redirect rather than render: this page rendered its own POST result,
      // so a refresh re-submitted the form and recorded the sale a second time.
      else return Astro.redirect(`/admin/products/${id}?sold=${qty}&at=${price}`, 303)
    }
  } else if (intent === 'delete') {
    await supabase.from('products').update({ status: 'deleted' }).eq('id', id)
    return Astro.redirect('/admin/products?deleted=1', 303)
  } else if (!form.has('name')) {
    // Defence in depth: the edit form is the only thing that carries `name`.
    // Treating absent fields as "set these to empty" silently erases a product.
    error = 'That submission did not include the product fields — nothing was changed.'
  } else {
    …build patch, update, redirect 303…
  }
}
```

Rules, in order of importance:

1. **Every mutation redirects with 303.** Rendering the result of a POST leaves the
   browser holding a form submission, so a refresh silently repeats it. There is a
   comment to this effect at every single redirect in the codebase.
2. **`intent` is a submit-button `name`/`value`**, never a hidden field on the form
   (except where `ConfirmAction` injects one).
3. **Outcome travels in query params, and the GET turns them back into prose:**
   ```ts
   const q = Astro.url.searchParams
   if (q.has('saved')) notice = 'Saved.'
   else if (q.has('sold')) notice = `Recorded: ${q.get('sold')} sold at ${formatCents(Number(q.get('at')))}.`
   ```
   Messages are pluralised inline (`${n} product${n === 1 ? '' : 's'}`) and tell the user
   what to do next, not just what happened.
4. **Errors surface as `error` / `notice` locals** rendered as the alert `<p>` at the top
   of the page body. Supabase errors are surfaced raw: `error = e.message`.
5. **Handlers refuse a submission missing the fields they intend to write** (see the
   `!form.has('name')` branch) — a defence against the disabled-submitter bug.
6. Bulk operations read `form.getAll('ids').map(String).filter(Boolean)`, with a
   `single_id` field overriding when a per-row button was used.
7. Dynamic field names for per-row editing: `name={`price_${p.id}`}`, read back with
   `for (const [key, value] of form.entries()) if (key.startsWith('price_')) …`.

### REST API routes (`src/pages/api/**`)

Named exports per method (`POST`, `DELETE`, `GET`) typed `APIRoute`. A local `json`
helper is declared at the top of each file:

```ts
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
```

Conventions:

- Return `{ error: 'Sentence in plain English.' }` with a real status code
  (400 / 401 / 404 / 413 / 415 / 500 / 503). Error strings are user-facing prose, e.g.
  `` `Cannot store ${file.type} — this browser could not encode WebP or JPEG.` ``
- Read the R2 binding as `import { env } from 'cloudflare:workers'` then `env.PHOTOS`.
  (Astro 6+ removed `Astro.locals.runtime.env`.) Always null-check the binding.
- Validate ownership **before** writing to storage: confirm the parent row exists and is
  visible to this user, so a bad id cannot leave orphaned objects.
- **Compensating deletes on failure:** track `written: string[]` and delete every object
  if the DB insert throws, wrapped in `try {} catch { /* best effort */ }`.
- Ordering rule for deletes: delete the **row first**, then the object. An orphaned object
  costs a fraction of a cent; a row pointing at a deleted object renders as a broken image.
- Cache headers: uploaded objects get
  `cacheControl: 'public, max-age=31536000, immutable'` (keys carry a uuid so they never
  change); the `/img` route honours `if-none-match` and returns 304.

---

## 9. Testing convention

- Runner: **`node --test`**, no framework. `"test": "node --test --test-concurrency=1 \"tests/*.test.ts\""` —
  concurrency 1 because the tests share one real database.
- Files: `tests/<topic>.test.ts`, flat, no nesting. `tests/helpers.ts` is shared, not a test.
- Imports: `import { describe, it } from 'node:test'` and `import assert from 'node:assert/strict'`.
- **Integration by design, against the real Supabase database.** Every test body runs
  inside a transaction that is always rolled back, so nothing is ever left behind and no
  separate test database is needed. The rationale, stated in the source: the logic under
  test lives in Postgres functions, so mocking the database would test nothing that matters.

```ts
/** Run a test body in a transaction and always roll it back. */
export async function withRollback(body: (db: pg.Client) => Promise<void>): Promise<void> {
  const db = await connect()
  try {
    await db.query('begin')
    await body(db)
  } finally {
    try { await db.query('rollback') } catch { /* may already be aborted */ }
    await db.end()
  }
}

export const one = async (db: pg.Client, sql: string, params: unknown[] = []) =>
  (await db.query(sql, params)).rows[0]

export const count = async (db: pg.Client, sql: string, params: unknown[] = []) =>
  Number((await db.query(sql, params)).rows[0].n)
```

- Test shape — one `it` per behaviour, body is an arrow returning `withRollback`:

```ts
describe('recording a sale', () => {
  it('snapshots the asking price', async () =>
    withRollback(async (db) => {
      const lot = await makeLot(db, { code: 'SL-1', items: [['S1', 2, 100000]] })
      const id = lot.productIds[0]
      await db.query(`update products set price_cents=49900 where id=$1`, [id])
      await sell(db, id, 1, 45000, 'haggled')
      const s = await one(db, `select * from sales where product_id=$1`, [id])
      assert.equal(s.list_price_cents, 49900, 'asking price is captured')
    }))
})
```

- **Fixture builders go through the real code path.** `makeLot()` inserts a lot, stages
  rows, and calls `commit_import()` — the same path the app uses — rather than
  hand-inserting products.
- Asserting a constraint refuses something needs a savepoint, because a failed statement
  aborts the surrounding transaction:

```ts
async function refuses(db, fn, re, msg?) {
  await db.query('savepoint guard')
  await assert.rejects(fn, re, msg)
  await db.query('rollback to savepoint guard')
}
```

- Pure logic (money parsing, model extraction, image `fit()`, URL builders) is tested
  without a database in the same file style.
- Assertion messages are written as sentences: `assert.equal(x, y, 'history is immutable')`.
- Test files carry the same explanatory header comment as source files.
- Biome disables `noNonNullAssertion` under `tests/`.

---

## 10. Deployment

### Commands

```bash
npm install
cp .env.example .env         # fill in Supabase values
node scripts/migrate.mjs     # apply SQL migrations
npm run dev                  # http://localhost:4321 (4322 via .claude/launch.json)
npm run check                # astro check — TS + Astro diagnostics
npm run lint                 # biome check .
npm run format               # biome check --write .
npm test                     # node --test, concurrency 1
npm run build                # astro build -> dist/
npx wrangler deploy          # or: git push, Cloudflare builds on push
```

### Hosting

- **GitHub (private) → Cloudflare Workers, automatic on push.** `main` → production;
  any other branch → a private preview URL. A failed build leaves the previous version
  live.
- Build command `npm run build`, output `dist/`.
- Custom domains are declared in `wrangler.jsonc` `routes` with `"custom_domain": true`
  (apex + www); the middleware 301s www → apex.

### Cache strategy

| Surface | Header |
|---|---|
| Public pages | `public, s-maxage=60, stale-while-revalidate=86400` (edge) |
| `/admin/*`, `/api/admin/*` | `private, no-store` — set by the middleware |
| R2 objects and `/img/*` | `public, max-age=31536000, immutable` |
| `sitemap.xml` | `public, max-age=600` |

### R2 binding usage

```ts
import { env } from 'cloudflare:workers'
const bucket = env.PHOTOS
await bucket.put(key, bytes, { httpMetadata: { contentType, cacheControl } })
const object = await bucket.get(key)       // object.body, object.httpEtag, object.httpMetadata
await bucket.delete(keys)                   // accepts an array
const page = await bucket.list({ prefix: 'products/', cursor, limit: 1000 })
// page.objects[].key, page.truncated, page.cursor
```

Key layout: `products/{product_id}/{uuid}-{size}.{webp|jpeg}` where size ∈
`thumb | card | full`. The DB stores only the **stem**; the size and extension are
appended when a URL is built.

### Environment variables

Deployed to the Worker: `PUBLIC_SUPABASE_URL`, `PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
`PUBLIC_SITE_URL`, `PUBLIC_IMAGE_BASE_URL`, optionally `ALLOW_DATA_RESET`.

Local tooling only (never deployed): `SUPABASE_DB_HOST`, `SUPABASE_DB_PASSWORD`,
`SUPABASE_SECRET_KEY`.

Secrets go in via `wrangler secret put NAME`. `import.meta.env` reads non-public vars
from the Worker environment at runtime rather than compiling them into the bundle —
verified against a production build.

> **Keep-alive:** the Supabase free tier pauses after 7 days idle; a Cloudflare Cron
> Trigger pings it weekly.

---

## 11. House rules (inferred conventions)

### File organisation

```
src/
  pages/           # routes; .astro pages handle their own POSTs
    api/admin/     # only for things a fetch() must call
    admin/         # back office, guarded by middleware
  components/
    public/        # storefront, zero JS
    admin/         # back office
  layouts/         # Public.astro, Admin.astro
  lib/
    supabase/      # server.ts — client factories only
    images/        # keys.ts (URL building), resize.ts (browser-only)
    import/        # csv.ts, parse.ts, stage.ts — one concern per file
    money.ts  public.ts  condition.ts
  middleware.ts
  styles/global.css
  env.d.ts
supabase/migrations/   # NNNN_slug.sql
scripts/               # *.mjs, plain node, parse .env by hand
tests/                 # *.test.ts + helpers.ts
docs/                  # REQUIREMENTS.md, TECHNICAL_PLAN.md
samples/               # real input files for testing
```

### Naming

- Files: `kebab-case.ts` for libs, `PascalCase.astro` for components and layouts,
  `lowercase.astro` for pages, `[param].astro` / `[...rest].ts` for dynamic routes.
- DB columns: `snake_case`, money always suffixed `_cents`, timestamps `_at`,
  booleans `is_*` / `show_*`.
- TS: `camelCase` functions and locals, `PascalCase` types/interfaces,
  `SCREAMING_SNAKE` module constants (`SIZES`, `CONDITIONS`, `FIELDS`, `MAX_BYTES`,
  `ACCEPTED`, `WIPE`, `KEEP`).
- Component props interface is always literally `interface Props { … }` (Astro's contract).
- Derived-value locals are short and domain-flavoured: `list`, `shots`, `facts`, `tiles`,
  `blocks`, `kept`, `sold`, `ordered`.

### TypeScript

- `astro/tsconfigs/strict`. No `any` in application code except two deliberate escapes:
  `(l.lots as any)?.lot_code` for PostgREST embedded joins, and `(window as any).__…`
  for the cross-script globals.
- `!` non-null assertion is used exactly where the middleware has already proven the
  value: `Astro.locals.supabase!`.
- Imports carry explicit extensions: `from '../../lib/money.ts'`, `from './helpers.ts'`.
- Interfaces for props and domain shapes; `type` for unions (`type Condition = 'new' | …`).
- Typed lookup tables: `const LABELS: Record<Condition, string> = { … }`.

### Comment density — the most distinctive convention

This codebase comments **heavily, and always about *why*, never *what***. Copying the
style matters as much as copying the classes.

- **Every** non-trivial file opens with a JSDoc block stating the file's purpose and the
  decision behind it. Example openers: *"The storefront shell."*, *"All money in this
  system is INTEGER CENTS. Never floats."*, *"Condition, in the customer's words."*
- Inline comments record **the bug that was fixed and how it manifested**, not the
  mechanism. Representative examples:
  - *"A disabled control is left out of the submitted form data — and that includes the button that was just pressed… so `intent=sell` never reached the server."*
  - *"Redirect rather than render: this page rendered its own POST result, so a refresh re-submitted the form and recorded the sale a second time. Two identical sales, and stock quietly one short."*
  - *"`block: 'nearest'` is the whole reason this script exists: the bare anchor works, but scrolls the page vertically to reach the slide."*
  - *"Safari hands back JPEG when asked for WebP, and mislabelling it here is what made an iPhone upload look like an oversized WebP."*
- **Deliberate absences are documented.** `server.ts` ends with a 10-line comment
  explaining why there is no service-role client. `wrangler.jsonc` carries a paragraph on
  why `preview_bucket_name` is deliberately unset.
- Prose is plain English aimed at the business owner, with en-dashes and no jargon.
  Even UI copy follows this: *"Only 1 left"* vs *"2 in stock"* — "both are true", one
  reads as urgency and one as choice.

### No-client-JS preference

- **Public pages ship zero framework JavaScript.** Filters, search and sorting are plain
  GET forms and links with server-rendered results — faster, shareable, and Google
  indexes every filtered view.
- The only public JS is the PhotoGallery enhancement, which is strictly progressive:
  the thumbnails are real in-page anchors that work with JS off, and the arrow buttons
  ship `hidden` and are un-hidden by the script.
- Admin JS is four small scripts and no framework: the layout busy-bar, ConfirmAction,
  the bulk-select syncer, and the photo uploader. `<script is:inline>` is used for the
  ones that need no bundling; a bare `<script>` (bundled, TS) is used where a module
  import is needed (`PhotoUploader` imports `resize.ts`).
- Cross-script communication uses globals with a wired-once guard
  (`window.__confirmActionWired`, `window.__tomaBusy`) and bubbling CustomEvents
  (`photos:changed`).

### Styling

- Utility classes inline, always. **No `@apply`, no component CSS, no CSS modules.**
- Repeated strings are hoisted to a frontmatter const (`field`, `card`, `pill`) — this is
  the only abstraction used.
- Conditional classes always via Astro's `class:list={[...]}`, with the base string first
  and conditionals after. Falsy entries are dropped, so `sold && 'opacity-60'` is idiomatic.
- Mobile-first: unprefixed is the phone, `sm:` / `lg:` add up. `sm:` is the main
  breakpoint; `md:` is essentially unused.
- Logical/modern utilities preferred: `size-4` over `h-4 w-4`, `min-h-dvh` over `min-h-screen`,
  `gap-*` over margins, `text-balance` / `line-clamp-2` where they help.
- Icons are hand-written inline `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" …
  aria-hidden="true">`. **No icon library.**
- Accessibility is done inline and consistently: skip link, `aria-label` on icon-only
  controls, `<span class="sr-only">` companions, `role="status" aria-live="polite"` on
  progress text, `aria-hidden="true"` on decorative separators and svgs, real
  `<nav aria-label="Breadcrumb">`.

### Git

Commit messages are **sentence-case phrases describing the user-visible change**, not
conventional-commits. Actual log:

```
Returns, and the difference between a return and a mistake
Mark sold, one tap from the listing
Edit the listing you are looking at
A gallery, not a set of links to new tabs
A quiet way back into the admin
Put the listing link in the enquiry text
The storefront
Sign out, and a session worth keeping
Store the format the browser could actually encode
Survive a phone-sized photo
Guard the reset, and give the admin its own
Toma Appliances: catalog site and admin back-office
```

12 commits for the whole app — large, coherent, feature-shaped commits rather than
granular ones.

### Known traps to carry forward

1. Never gitignore `src/` — Tailwind v4 skips gitignored paths and ships an unstyled site that still "builds successfully".
2. Don't set `preview_bucket_name` — it renames the **local** miniflare store and strands existing objects.
3. Don't disable a submit button in its own `submit` handler without first copying its `name`/`value` into a hidden input.
4. `security_invoker` views silently return 0 for aggregates over tables the caller can't read. Test permission-sensitive SQL **as `anon`**.
5. Revoke `anon` explicitly; don't rely on RLS alone.
6. Workers is not Node — no `fs`, no `Buffer` by default. Check edge-compatibility before adding a dependency. (This is why `csv.ts` is hand-written.)
7. Astro 7 needs Node ≥ 22.12.
8. Supabase's direct DB host is IPv6-only; use the pooler on port 5432 (session mode).
9. Add `--color-ink-200` to `@theme` or stop using `border-ink-200` (currently 5 dead utilities).

---

## Appendix — helper modules worth copying verbatim

### `src/lib/money.ts`

```ts
/** "719.99" | "$1,149.99" -> 71999 | 114999. Returns null if unparseable. */
export function toCents(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value * 100) : null
  const cleaned = value.replace(/[$,\s]/g, '').trim()
  if (!cleaned) return null
  const n = Number.parseFloat(cleaned)
  return Number.isFinite(n) ? Math.round(n * 100) : null
}

/** 71999 -> "$719.99" */
export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—'
  return `$${(cents / 100).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

/** step 900 => always ends in .99 at the nearest whole dollar below. */
export function roundToPricePoint(cents: number, step = 900): number {
  if (step <= 0) return cents
  const base = Math.floor(cents / 10000) * 10000
  const candidate = base + step
  return candidate >= cents - 5000 ? candidate : candidate + 10000
}
```

Display helper repeated in every form page: `const dollars = (c: number | null) => (c ? (c / 100).toFixed(2) : '')`.
Em-dash `—` is the universal "no value" glyph.

### `src/lib/images/keys.ts`

```ts
export function photoUrl(stem: string, size: PhotoSize = 'card', format: PhotoFormat = 'webp'): string {
  // Optional-chained: outside Vite -- the test runner, say -- `import.meta.env`
  // does not exist at all, and a URL builder has no business throwing over it.
  const base = import.meta.env?.PUBLIC_IMAGE_BASE_URL?.replace(/\/$/, '') || '/img'
  return `${base}/${stem}-${size}.${format}`
}

export const photoObjectKeys = (stem: string, format: PhotoFormat = 'webp'): string[] =>
  (['thumb', 'card', 'full'] as PhotoSize[]).map((s) => `${stem}-${s}.${format}`)
```

### `src/lib/images/resize.ts` — size ladder

```ts
export type PhotoSize = 'thumb' | 'card' | 'full'

/** Longest edge, in pixels. Anything already smaller is left alone. */
export const SIZES: Record<PhotoSize, { edge: number; quality: number }> = {
  thumb: { edge: 400,  quality: 0.72 }, // grids
  card:  { edge: 800,  quality: 0.78 }, // listing cards
  full:  { edge: 1600, quality: 0.82 }, // detail view
}

/** Longest edge capped at `edge`, aspect ratio kept, never upscaled. */
export function fit(width: number, height: number, edge: number) {
  const longest = Math.max(width, height)
  if (longest <= edge) return { width, height }
  const scale = edge / longest
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}
```

Also exports `readImageSize(file)`, which reads the first 64 KB and parses the PNG/JPEG/WebP
header — file size cannot tell you pixel dimensions, and decoding a 48 MP image whole is
what kills an iOS tab. HEIC gets a specific, actionable error message.

### `src/lib/public.ts` — tel/sms helpers

```ts
/** Digits only, with a leading +1 when it looks like a US number. */
export function telHref(phone: string): string {
  const digits = phone.replace(/\D/g, '')
  if (!digits) return ''
  return `+${digits.length === 10 ? '1' : ''}${digits}`
}

/** `?&body=` is not a typo: iOS needs the `&`, Android is happy either way. */
export function smsHref(phone: string, message: string): string {
  const to = telHref(phone)
  return to ? `sms:${to}?&body=${encodeURIComponent(toPlainText(message))}` : ''
}

/** "1 left" reads as urgency; "2 in stock" reads as choice. Both are true. */
export function stockLabel(qty: number, exact: boolean): string {
  if (qty <= 0) return 'Sold'
  if (!exact) return 'In stock'
  return qty === 1 ? 'Only 1 left' : `${qty} in stock`
}
```

`toPlainText()` flattens curly quotes, en/em dashes, ellipses and nbsp — characters
outside GSM-7 force a text into UCS-2 and cut the per-segment budget from 160 to 70.
