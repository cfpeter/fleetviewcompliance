# Stack & Conventions — new fleet product

Decided, not open for research. Mirrors `toma-appliances` exactly so the two projects
share one set of habits and one visual language.

## Runtime

| Layer | Choice | Note |
|---|---|---|
| Framework | Astro 7.2, `output: 'server'` | Server-rendered. React installed but unused in Toma — **omit React entirely here** unless an island is genuinely needed. |
| Host | Cloudflare Workers via `@astrojs/cloudflare` 14.2 | `imageService: 'compile'`, `remoteBindings: true` |
| Node | >= 22.12 (`.nvmrc` 22.23.2) | Already the machine default |
| CSS | Tailwind v4.3 via `@tailwindcss/vite` | CSS-first `@theme`; **no tailwind.config.js** |
| DB + Auth | Supabase (`@supabase/ssr` + `supabase-js`) | Request-scoped session client; anon client for public; raw `pg` for migrations/tests |
| Files | Cloudflare R2 binding | Documents (med certs, registrations, rate cons, PODs) rather than photos |
| Lint/format | Biome 2.5 | single quotes, no semicolons, 100 cols |
| Types | `astro check` + `astro/tsconfigs/strict` | |
| Tests | `node --test --test-concurrency=1` against the real DB, every body in `withRollback()` | |

## Design tokens (`src/styles/global.css`, the entire stylesheet)

```css
@import "tailwindcss";

@theme {
  --color-ink-50:  #f6f7f8;
  --color-ink-100: #eaecef;
  --color-ink-200: #d4d8de;   /* ADDED — Toma uses border-ink-200 5× without defining it */
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

Semantic colour comes from stock Tailwind, not from `@theme`:
emerald = good/current · amber = warning/due soon · red = overdue/destructive ·
sky = informational · blue = neutral-done.

**This maps onto compliance status directly** — the one place this product needs a
vocabulary Toma didn't:

| Status | Pill |
|---|---|
| Current | `bg-emerald-100 text-emerald-800` |
| Due soon | `bg-amber-100 text-amber-800` |
| Overdue | `bg-red-100 text-red-700` |
| Unknown / missing data | `bg-ink-100 text-ink-500` |
| Not applicable | `bg-ink-50 text-ink-300` |

## UI vocabulary (lifted verbatim)

- Card: `rounded-xl border border-ink-100 bg-white p-5` — no shadow at rest
- Primary button: `rounded-lg bg-brand-600 px-5 py-2.5 font-medium text-white transition hover:bg-brand-700`
- Secondary: `rounded-lg border border-ink-100 px-4 py-2.5 font-medium transition hover:bg-ink-50`
- Input const `field`: `mt-1 w-full rounded-lg border border-ink-100 bg-white px-3 py-2 text-base outline-none focus:border-brand-500 focus:ring-2 focus:ring-brand-500/20`
  (`text-base` is deliberate — 16px stops iOS zooming on focus)
- Label wraps the input; no `for`/`id` except on login
- Table: border on the scrolling wrapper, never on `<table>`; `divide-y divide-ink-100`; numerics `text-right tabular-nums`
- Empty state: dashed border, centred, one sentence, at most one button
- Alerts: single `<p class="mb-5 rounded-lg …">` at the top of the body
- Every number carries `tabular-nums`; every heading carries `tracking-tight`
- **Amber means a clock is running. Blue means a standing fact to read.** They used to be
  the same colour, and on the dashboard the 45-day section sat directly above "You have to
  check these yourself" in identical amber — so a permanent duty about brake-inspector
  paperwork looked as time-critical as a medical card expiring next month, and the medical
  card looked as ignorable as the paperwork. Red → amber is the urgency scale and nothing
  else may borrow from it. A chart's `coverage` note stays amber because a gap in the data
  IS something to fix; `standingPill('unsupported')` and the "answer this elsewhere" blocks
  are blue because they will read exactly the same next year.
- Icons: hand-written inline SVG, `viewBox="0 0 24 24" fill="none" stroke="currentColor"`. **No icon library.**
- Containers: `max-w-6xl` public, `max-w-7xl` app, `max-w-3xl` prose, `max-w-sm` login. Padding always `px-4 sm:px-6`.
- Charts: `src/components/charts/`, server-rendered HTML/CSS, **no chart library and no client JS**.
  Read **`docs/charts.md`** before adding one — a wrong chart is a wrong *conclusion*, reached in a
  second, and the rules there (an unknown is never a zero; the axis is built from consecutive periods,
  never from the data; every figure declares what it does not cover) are what keep them as honest as
  the tables.

## Conventions that matter more than the classes

1. **Form POSTs go to the page itself**, dispatched on a submit button's `name="intent"`,
   and **always end in a 303 redirect** with the outcome in query params. API routes exist
   only for things a `fetch()` must call.
2. **Public pages ship zero framework JavaScript.** Filters and search are GET forms.
3. **The database is the security model** — RLS `ENABLE` + `FORCE`, plus explicit column
   `GRANT`s after a `REVOKE ALL`. No service-role client anywhere.
4. **Comments record the bug that was fixed**, in plain English, not the mechanism.
5. Migrations: hand-numbered `supabase/migrations/NNNN_slug.sql`, applied by
   `scripts/migrate.mjs` over the IPv4 pooler (`aws-0-us-west-1.pooler.supabase.com:5432`)
   — Supabase's direct host is IPv6-only and this network is not.
6. Commits are sentence-case descriptions of the user-visible change, and large.

## Traps carried over from Toma

1. Never gitignore `src/` — Tailwind v4 skips gitignored paths and ships an unstyled site
   that still builds successfully.
2. Don't set `preview_bucket_name` in wrangler.jsonc.
3. Don't disable a submit button in its own handler without copying `name`/`value` into a
   hidden input first.
4. Test permission-sensitive SQL **as `anon`** — `security_invoker` views silently return 0
   for aggregates over unreadable tables.
5. Workers is not Node: no `fs`, no `Buffer` by default. Check edge-compatibility before
   adding any dependency.

## One decision to make differently from Toma

Toma runs **one** Supabase project and **one** R2 bucket shared by local dev and
production — `"remote": true` in wrangler.jsonc means local dev writes to the live bucket,
and `npm run reset` wipes the live site. That was tolerable for a single-owner catalogue.
It is **not** tolerable for a multi-tenant product holding other carriers' compliance
records. This project needs a separate dev Supabase project and dev bucket from day one.
