/**
 * Reading the Stripe settings out of the Worker environment.
 *
 * HOW SECRETS REACH THE WORKER. `Astro.locals.runtime.env` was removed in Astro
 * v6; bindings and secrets now come from the `cloudflare:workers` module, which
 * does not exist outside the Worker runtime — hence the dynamic import. In
 * production the values are put there by `wrangler secret`, never by a file.
 *
 * `import.meta.env` IS NOT USED HERE, AND THAT IS THE WHOLE POINT OF THIS FILE.
 *
 * It is tempting, because src/pages/api/cron/digest.ts reads it as a dev
 * fallback and appears to dodge the inliner by indexing it with a variable. It
 * does not. VERIFIED AGAINST THIS REPO'S OWN BUILD OUTPUT: Vite replaces the
 * `import.meta.env` EXPRESSION — not the property access — with an object
 * literal holding every variable the build machine's .env had. `npm run build`
 * on this machine produced dist/server/chunks/digest_*.mjs containing
 * `{ CRON_SECRET: "…", … }` in plain text, and the dynamic index made no
 * difference at all: the object was inlined whole and then indexed at runtime.
 *
 * A Stripe secret key read that way would therefore be compiled into the
 * JavaScript that is uploaded to Cloudflare and kept in `dist/`, where a build
 * artefact, a CI cache or a shared machine is enough to leak it — and a leaked
 * `sk_live_` key can move money. So the fallback here is `process.env`, which
 * Vite leaves alone under a variable key, and which the Workers runtime
 * populates from the real bindings under `nodejs_compat`.
 *
 * WHAT THIS COSTS. `astro dev` loads .env into `import.meta.env` and NOT into
 * `process.env`, so plain `astro dev` sees no Stripe keys and the billing screen
 * degrades to "card payment is not switched on" — which is a correct, honest
 * screen rather than a broken one. To exercise Stripe locally, either export the
 * variables into the shell before `astro dev`, or run the built Worker under
 * `wrangler dev`, where `.dev.vars` reaches it the same way a real secret does.
 */

export type EnvReader = (key: string) => string | undefined

/**
 * A reader over the Worker environment.
 *
 * Never reads `import.meta.env` — see the note above. `process.env` is indexed
 * with a variable so that nothing is statically replaceable, and is guarded
 * because it does not exist in every runtime this code is type-checked for.
 */
export async function runtimeEnv(): Promise<EnvReader> {
  let workerEnv: Record<string, string> = {}
  try {
    workerEnv = (await import('cloudflare:workers')).env as unknown as Record<string, string>
  } catch {
    // Not running in the Worker runtime.
  }
  const processEnv: Record<string, string | undefined> =
    typeof process !== 'undefined' && process.env ? process.env : {}
  return (k: string) => workerEnv[k] ?? processEnv[k] ?? undefined
}

export interface StripeConfig {
  /** Null when absent, malformed, or refused by the live-key guard. */
  secretKey: string | null
  priceId: string | null
  webhookSecret: string | null
  /** 'live' only when a real `sk_live_` key passed every check. */
  mode: 'test' | 'live' | 'unknown'
  /**
   * What is wrong, in short operator English. Empty when nothing is.
   *
   * These are for the deployment log and the settings screen's honest notice —
   * never shown to a carrier, who cannot act on any of them.
   */
  problems: string[]
}

/** Trimmed, or null. An env var set to an empty string is not set. */
function value(raw: string | undefined): string | null {
  const s = (raw ?? '').trim()
  return s === '' ? null : s
}

/**
 * Read and check the Stripe settings.
 *
 * SHAPES ARE CHECKED HERE rather than discovered as a 401 from Stripe on the
 * one screen where a customer is trying to give us money. The commonest paste
 * accident by a wide margin is the publishable key (`pk_…`) into the secret slot
 * — they sit next to each other in the dashboard and differ by one letter.
 *
 * THE LIVE-KEY GUARD mirrors the rule src/lib/notify/guard.ts enforces on email
 * and SMS: outside production, a live key is refused rather than used. Without
 * it, a developer pressing the checkout button on the dev Worker creates real
 * customers and real subscriptions against the real business, and the first
 * anyone knows about it is a charge on somebody's card.
 */
export function readStripeConfig(get: EnvReader): StripeConfig {
  const problems: string[] = []

  let secretKey = value(get('STRIPE_SECRET_KEY'))
  const priceId = value(get('STRIPE_PRICE_ID'))
  const webhookSecret = value(get('STRIPE_WEBHOOK_SECRET'))
  const deployEnv = value(get('DEPLOY_ENV'))

  let mode: 'test' | 'live' | 'unknown' = 'unknown'
  if (secretKey) {
    // `rk_` is a restricted key, which is a perfectly good thing to run this on.
    if (!/^(sk|rk)_(test|live)_/.test(secretKey)) {
      problems.push('STRIPE_SECRET_KEY is not a Stripe secret key (expected sk_… or rk_…)')
      secretKey = null
    } else {
      mode = secretKey.includes('_live_') ? 'live' : 'test'
      if (mode === 'live' && deployEnv !== 'production') {
        problems.push(
          `STRIPE_SECRET_KEY is a LIVE key and DEPLOY_ENV is ${deployEnv ?? 'unset'}. Refusing to use it.`,
        )
        secretKey = null
        mode = 'unknown'
      }
    }
  }

  if (priceId && !/^price_/.test(priceId)) {
    problems.push('STRIPE_PRICE_ID is not a Stripe price id (expected price_…)')
  }
  if (webhookSecret && !/^whsec_/.test(webhookSecret)) {
    problems.push('STRIPE_WEBHOOK_SECRET is not a signing secret (expected whsec_…)')
  }

  return {
    secretKey,
    priceId: priceId && /^price_/.test(priceId) ? priceId : null,
    webhookSecret: webhookSecret && /^whsec_/.test(webhookSecret) ? webhookSecret : null,
    mode,
    problems,
  }
}

/** Enough to send somebody to Stripe Checkout. */
export function canCheckout(
  c: StripeConfig,
): c is StripeConfig & { secretKey: string; priceId: string } {
  return c.secretKey !== null && c.priceId !== null
}

/**
 * Enough to accept a webhook.
 *
 * The signing secret is required, not optional. An endpoint that accepted
 * unsigned events would let anyone grant themselves a subscription, so the
 * absence of this value means the endpoint refuses everything rather than
 * trusting what arrives.
 */
export function canReceiveWebhooks(
  c: StripeConfig,
): c is StripeConfig & { secretKey: string; webhookSecret: string } {
  return c.secretKey !== null && c.webhookSecret !== null
}
