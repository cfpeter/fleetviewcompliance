/**
 * Connection settings for migrations and tests.
 *
 * Accepts either SUPABASE_DB_URL (the URI the dashboard hands you, pasted
 * verbatim) or the four discrete SUPABASE_DB_* fields. The URI wins when both
 * are present.
 */
export function dbConfig(e) {
  const url = e.SUPABASE_DB_URL
  if (url && url.trim()) {
    const u = new URL(url.trim())
    return {
      host: u.hostname,
      port: Number(u.port || 5432),
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, '') || 'postgres',
      ssl: { rejectUnauthorized: false },
    }
  }
  if (!e.SUPABASE_DB_HOST || !e.SUPABASE_DB_PASSWORD || !e.SUPABASE_DB_USER) return null
  return {
    host: e.SUPABASE_DB_HOST,
    port: Number(e.SUPABASE_DB_PORT ?? 5432),
    user: e.SUPABASE_DB_USER,
    password: e.SUPABASE_DB_PASSWORD,
    database: e.SUPABASE_DB_NAME ?? 'postgres',
    ssl: { rejectUnauthorized: false },
  }
}
