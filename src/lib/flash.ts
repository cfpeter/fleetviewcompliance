/**
 * The one-line message a page shows after its own POST, read back safely.
 *
 * Most forms in this app end in `303 → /same/page?error=<sentence>`, and the
 * page prints whatever `error` says. That is convenient and it is also a
 * weapon: anybody can hand a customer a link to their own settings page that
 * reads "Your account is locked, call 555-0100", in our styling, on our domain,
 * behind our padlock. Astro escapes the value, so it is not script injection —
 * it is worse in practice, because the words ARE the attack and escaping does
 * nothing to them. settings.astro solved this for itself by carrying codes
 * instead of text. Dozens of other pages carry sentences built at runtime —
 * "That VIN is 34 characters", "Miles in AZ should be…" — and rewriting every
 * one of them as a code table is a larger change than the risk warrants today.
 *
 * So this reads the message ONLY when the request plainly came from this site.
 * The browser says so itself: `Sec-Fetch-Site` is `same-origin` on the GET that
 * follows our own 303, and `cross-site` or `none` on a link opened from an
 * email, a text message or another site. A browser cannot be made to lie in
 * that header, and every current browser sends it (Chrome 76, Firefox 90,
 * Safari 16.4). Where it is absent — an old browser — the Referer is tried,
 * and where that is absent too the message is shown as before, because the
 * alternative is a whole class of devices that never see a form error.
 *
 * What this costs the customer: nothing he can see. The message still appears
 * after every submit. It does not appear if he pastes the URL into a new tab or
 * a bookmark, which is the right answer — the error was about a submit that is
 * no longer happening.
 */

/**
 * The value of `key` from the query string, or null when the request did not
 * come from this site.
 */
export function flashText(url: URL, request: Request, key = 'error'): string | null {
  const value = url.searchParams.get(key)
  if (value === null || value === '') return null
  return cameFromThisSite(url, request.headers) ? value : null
}

/**
 * Whether the browser says this navigation started on our own origin.
 *
 * `same-origin` is the only Sec-Fetch-Site value that passes. `same-site`
 * would admit a sibling subdomain, and the sibling here is the dev deployment
 * of this same application, which is not the same thing as this site.
 */
export function cameFromThisSite(url: URL, headers: Headers): boolean {
  const site = headers.get('sec-fetch-site')
  if (site !== null) return site.trim().toLowerCase() === 'same-origin'

  const referer = headers.get('referer')
  if (referer === null || referer === '') return true
  try {
    return new URL(referer).origin === url.origin
  } catch {
    return false
  }
}
