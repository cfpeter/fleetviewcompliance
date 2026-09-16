/**
 * Supabase clients.
 *
 * Two of them, and deliberately no third:
 *
 *   sessionClient(...)  every signed-in request. Runs AS THE USER, so RLS is
 *                       what decides which rows come back.
 *   anonClient()        the marketing site. Reads nothing that needs a session.
 *
 * There is no service-role client in this application, and adding one would
 * undo the entire security model. A service-role key bypasses RLS completely:
 * from that moment a single missing `.eq('carrier_id', ...)` anywhere in the
 * codebase leaks one carrier's driver medical certificates to another. The
 * database refusing is worth more than remembering to filter.
 *
 * Migrations and tests reach the database over raw `pg` instead, with the
 * connection string kept out of the Worker entirely.
 */
import { createServerClient } from '@supabase/ssr'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { AstroCookies } from 'astro'

const URL = import.meta.env.PUBLIC_SUPABASE_URL
const KEY = import.meta.env.PUBLIC_SUPABASE_PUBLISHABLE_KEY

function assertConfigured() {
  if (!URL || !KEY) {
    throw new Error(
      'PUBLIC_SUPABASE_URL and PUBLIC_SUPABASE_PUBLISHABLE_KEY must be set. See .env.example.',
    )
  }
}

/**
 * A client bound to this request's cookies, so the session refreshes and
 * every query carries the user's identity into RLS.
 */
export function sessionClient(cookies: AstroCookies, headers: Headers): SupabaseClient {
  assertConfigured()
  return createServerClient(URL, KEY, {
    cookies: {
      getAll() {
        // Astro's cookie API has no "all" accessor, so parse the header.
        const raw = headers.get('cookie') ?? ''
        return raw
          .split(';')
          .map((p) => p.trim())
          .filter(Boolean)
          .map((p) => {
            const i = p.indexOf('=')
            return { name: p.slice(0, i), value: decodeURIComponent(p.slice(i + 1)) }
          })
      },
      setAll(list) {
        for (const { name, value, options } of list) {
          cookies.set(name, value, {
            path: '/',
            httpOnly: true,
            sameSite: 'lax',
            secure: import.meta.env.PROD,
            // 400 days is the browser cap. A compliance tool the office manager
            // is logged out of every fortnight is a compliance tool she stops
            // opening.
            maxAge: 400 * 24 * 60 * 60,
            ...options,
          })
        }
      },
    },
  })
}

/** No session, no cookies. For public pages only. */
export function anonClient(): SupabaseClient {
  assertConfigured()
  return createClient(URL, KEY, { auth: { persistSession: false } })
}
