/**
 * A throttle on the one endpoint in this product that takes an anonymous write.
 *
 * WHY THIS EXISTS WHEN /proof HAS NOTHING. A proof link leans entirely on 256
 * bits of entropy, and for a READ that is defensible: guessing is hopeless and a
 * successful guess costs one page render. This endpoint accepts files and writes
 * a row. The exposure is not guessing — it is a link that has been forwarded,
 * screenshotted or left on a lost phone, where the holder already has the token
 * and friction is the only thing left.
 *
 * TWO KEYS, because they catch different things. The token key catches somebody
 * hammering one link; the address key catches somebody walking a list of them.
 * Either one tripping is a refusal.
 *
 * FAILS OPEN, deliberately, and this is the one place in this codebase that
 * does. Everywhere else an unreadable configuration means "no" — see
 * `isOperatorRequest`. Here a KV outage would mean a driver standing in a yard
 * cannot send his medical card to a carrier who asked for it, which is the exact
 * failure the feature exists to remove; and the thing behind this door is a
 * queue an owner reads, not a compliance record. The single-use link is the real
 * control. This is friction on top of it.
 */

const WINDOW_SECONDS = 600
/** Ten minutes is plenty for a man re-taking a photo that came out blurred. */
const MAX_PER_TOKEN = 8
/** One address, many links — a yard office sending several drivers at once is
 *  real, so this is loose enough not to catch it. */
const MAX_PER_CALLER = 40

interface Counter {
  get(key: string, type: 'text'): Promise<string | null>
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>
}

/** The KV namespace bound as SESSION, or null outside the Worker runtime. */
async function store(): Promise<Counter | null> {
  let workerEnv: Record<string, unknown> = {}
  try {
    workerEnv = (await import('cloudflare:workers')).env as unknown as Record<string, unknown>
  } catch {
    // Not the Worker runtime — dev under node, or a test. No store, no throttle.
  }
  const kv = workerEnv.SESSION as Counter | undefined
  if (!kv || typeof kv.get !== 'function' || typeof kv.put !== 'function') return null
  return kv
}

async function bump(kv: Counter, key: string, ceiling: number): Promise<boolean> {
  const seen = Number((await kv.get(key, 'text')) ?? '0')
  const next = Number.isFinite(seen) ? seen + 1 : 1
  // Written before the verdict so a refused attempt still counts. Otherwise the
  // ceiling is a speed limit somebody can sit exactly on top of for ever.
  await kv.put(key, String(next), { expirationTtl: WINDOW_SECONDS })
  return next <= ceiling
}

/**
 * Whether this attempt may proceed.
 *
 * `tokenHashPrefix` rather than the token: a rate-limit key is stored, and a
 * store of raw tokens is a store of working credentials. The first sixteen hex
 * characters of the digest are unique enough to count with and useless to
 * anybody who reads the namespace.
 */
export async function allowDriverSubmit(args: {
  tokenHashPrefix: string
  callerHash: string | null
}): Promise<boolean> {
  const kv = await store()
  if (!kv) return true

  try {
    const okToken = await bump(kv, `dl:t:${args.tokenHashPrefix}`, MAX_PER_TOKEN)
    if (!okToken) return false
    if (args.callerHash) {
      return await bump(kv, `dl:c:${args.callerHash}`, MAX_PER_CALLER)
    }
    return true
  } catch {
    // See the header: this one fails open.
    return true
  }
}
