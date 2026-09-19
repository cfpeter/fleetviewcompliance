/**
 * Submitting without throwing the page away, and the four ways it must not.
 *
 * THE OWNER'S WORDS: "all i care is about the forms and buttons we click, i
 * just dont like the refresh on those... i dont care if going from one page to
 * another to render from server, this is fine... but the actual content like
 * updates, create, done, finish, add date, add driver, mark done".
 *
 * So this is not a router and must never become one. It intercepts the submit
 * of a form that posts back to its own address, and nothing else. Links are
 * untouched, and a handler that sends the reader somewhere else is still a real
 * navigation.
 *
 * These are source assertions because the behaviour lives in the browser and
 * this suite has no DOM. The three paths — swap, refuse, navigate away — were
 * driven in a real browser against a throwaway page before this file was
 * written; what is pinned here is the set of conditions that made that safe.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const script = read('../src/scripts/live-forms.ts')
const layout = read('../src/layouts/App.astro')

const code = script.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

test('the button that chooses the write is proved to survive, before anything is intercepted', () => {
  /*
   * THE BUG THIS EXISTS TO PREVENT, and it is silent.
   *
   * Every write in this app is chosen by `name="intent"` on the BUTTON, not by
   * a field in the form. `new FormData(form)` does not include it — only
   * `new FormData(form, submitter)` does, and a browser that ignores the second
   * argument returns a body with no intent rather than throwing. The handler
   * then falls through to its "unknown intent" branch, 303s back, and the owner
   * watches Done do nothing at all, with no error anywhere.
   */
  assert.match(code, /new FormData\(form, button\)\.get\('intent'\) === 'probe'/)
  assert.match(code, /if \(!CARRIES_THE_BUTTON\) return/)
  // And the real submit carries it too.
  assert.match(code, /body = new FormData\(form, submitter\)/)

  /*
   * THE SECOND REASON IT MUST BE FormData AND NEVER A WALK OF THE FORM'S OWN
   * CHILDREN. The dashboard collects one date from every section into a single
   * save, and it does that with the HTML `form=` attribute — the inputs sit
   * OUTSIDE the form they submit into, because a form per row would be one
   * full page load per date. `new FormData(form)` includes controls associated
   * that way; walking `form.children` does not, and the failure is silent: he
   * types six dates, presses Save, and the server is handed none of them.
   *
   * Driven in a browser against that exact markup before this was written —
   * two inputs outside the form, both arrived.
   */
  const dashboard = read('../src/pages/app/index.astro')
  assert.match(dashboard, /form="row-dates"/, 'the dashboard still submits from outside the form')
  assert.doesNotMatch(code, /form\.(children|elements)\b/, 'the body is never assembled by hand')
})

test('only a form that posts back to its own page is intercepted', () => {
  // Opt-in, POST, and no `action`. The third is what excludes /logout, which
  // posts to another address and answers with the public site — swapped into
  // this shell that would be a signed-out page wearing the app's navigation.
  assert.match(code, /if \(!form\.closest\('\[data-live\]'\)\) return/)
  assert.match(code, /if \(form\.method\.toLowerCase\(\) !== 'post'\) return/)
  assert.match(code, /if \(form\.getAttribute\('action'\)\) return/)
})

test('a handler that sends the reader elsewhere is a real navigation', () => {
  // He asked for page-to-page to stay a real load, and it is also what keeps
  // the left-hand navigation honest: another page's `<main>` under this page's
  // header highlights the wrong thing. Deleting a driver, starting a Stripe
  // checkout and signing out all take this path.
  assert.match(code, /to\.origin === location\.origin && to\.pathname === location\.pathname/)
  assert.match(code, /if \(!sameDocument\(response\.url\)\) \{\s*location\.href = response\.url/)
  // And anything that comes back without a `<main>` is not something to swap.
  assert.match(code, /if \(!page\) \{\s*location\.href = response\.url/)
})

test('every failure falls back to the form the browser already had', () => {
  // The whole safety argument: nothing on the server changed, so the worst case
  // is the behaviour we have today. A dropped connection hands the submit back
  // to the browser, and the marker stops that retry being intercepted again.
  assert.match(code, /form\.requestSubmit\(submitter\)/)
  assert.match(code, /if \(form\.hasAttribute\(GAVE_UP\)\) return/)
  assert.match(code, /form\.setAttribute\(GAVE_UP, '1'\)/)
  // The address on screen has to match what is on screen, and REPLACE rather
  // than push, so Back does not re-offer a form that has already been sent.
  assert.match(code, /history\.replaceState\(null, '', address\)/)
})

test('a link that stays on the page swaps; a link that leaves it does not', () => {
  // The line is not form versus link, it is "am I still on the same page". A
  // suggestion chip, a filter and a show/hide toggle are all `<a href>` that
  // change only the query — the reader has not gone anywhere. A link to another
  // driver has, and that stays a real document request.
  assert.match(code, /if \(!sameDocument\(link\.href\)\) return/)
  assert.match(code, /if \(to\.search === location\.search\) return/)
  // A modified click belongs to the browser: it means a new tab or a saved file.
  assert.match(code, /if \(event\.metaKey \|\| event\.ctrlKey \|\| event\.shiftKey \|\| event\.altKey\) return/)
  assert.match(code, /if \(link\.hasAttribute\('download'\)\) return/)
  assert.match(code, /if \(link\.target && link\.target !== '_self'\) return/)
})

test('an in-page anchor costs nothing, and Back still works', () => {
  /*
   * A BUG THE BROWSER TEST CAUGHT, and it is not obvious.
   *
   * Following a plain `#anchor` link is a same-document navigation, and
   * browsers fire `popstate` for those as well as for the Back button. So
   * every in-page jump was refetching and rebuilding the whole `<main>` — a
   * round trip for nothing, and worse, it threw away anything typed into a
   * form on that page.
   *
   * Measured after the fix: an in-page anchor makes 0 requests; Back makes 1
   * and re-renders.
   */
  assert.match(code, /let rendered = location\.pathname \+ location\.search/)
  assert.match(code, /if \(addressOnScreen\(\) === rendered\) return/)
  // And the marker is updated everywhere a swap lands, or the guard goes stale
  // and starts refusing real navigations.
  assert.equal((code.match(/rendered = addressOnScreen\(\)/g) ?? []).length, 2)
  // Back needs its own handler at all: `pushState` without one changes the
  // address bar and not the page, so Back looks like it did nothing.
  assert.match(code, /window\.addEventListener\('popstate'/)
  // A link gets its own history entry; a form's answer replaces the page that
  // submitted it, so Back does not re-offer a form already sent.
  assert.match(code, /if \(options\.push\) history\.pushState/)
  assert.match(code, /else history\.replaceState/)
})

test('the page is not frozen while the server works, and it says so', () => {
  /*
   * "Does this mean the browser is frozen until it fetches?" — no, and that is
   * the reason for both of these.
   *
   * NOT FROZEN means he can press a second button before the first answers.
   * Both come back, and without a ticket the one that lands LAST wins, which
   * may be the older of the two: a screen quietly showing the state before the
   * thing he just did. Measured in a browser: a slow write followed by a fast
   * one leaves the fast one's answer on screen.
   *
   * NOT FROZEN also means the browser shows nothing at all. A real form post
   * spins the tab; a fetch does not, so on a slow connection the button looks
   * ignored and gets pressed again.
   */
  assert.match(code, /let sequence = 0/)
  assert.match(code, /const ticket = \+\+sequence/)
  assert.match(code, /if \(options\.ticket !== sequence\) return/)
  assert.match(code, /if \(ticket !== sequence\) return/)
  // Delayed, so a fast answer never flashes a bar across the screen.
  assert.match(code, /}, 150\)/)
  assert.match(code, /document\.documentElement\.setAttribute\('data-working', ''\)/)
  const css = read('../src/styles/global.css')
  assert.match(css, /html\[data-working\]::after/)
  assert.match(css, /@keyframes live-working/)
})

test('a confirmation is lifted where it can be read, and a refusal is not', () => {
  /*
   * "Saved" is written at the top of `<main>`, which was in front of the
   * reader's eyes back when a save reloaded the page and put him there. He
   * stays exactly where he was now, so that line can be a screen and a half
   * above him, confirming something he cannot see.
   *
   * MOVED, NEVER COPIED — one sentence, written by the server. With no
   * JavaScript nothing is lifted and it renders where it is written.
   */
  assert.match(code, /region\.appendChild\(flash\)/)
  assert.match(code, /querySelectorAll<HTMLElement>\('\[data-flash\]'\)/)
  // On a swap, on the Back button, and on an ordinary page load carrying
  // `?saved=1` — all three, or a confirmation goes missing on one of them.
  assert.equal((code.match(/hoistFlash\(/g) ?? []).length, 4)

  // A refusal stays beside the form that was refused and keeps the screen and
  // the keyboard. It must never be a thing that slides away after 6 seconds.
  // Comments stripped first: that file EXPLAINS that a refusal keeps
  // `role="alert"` and this one does not, and prose naming the thing it rules
  // out must not read as the thing itself.
  const flash = read('../src/components/ui/Flash.astro').replace(/\/\*[\s\S]*?\*\//g, '')
  assert.doesNotMatch(flash, /role="alert"/, 'a confirmation is not an alert')
  assert.match(flash, /data-flash=\{tone\}/)
  assert.match(code, /querySelector<HTMLElement>\('\[role="alert"\]'\)/, 'refusals take the screen')

  const layout = read('../src/layouts/App.astro')
  assert.match(layout, /<div id="toasts" aria-live="polite" \/>/, 'and it is spoken, not only shown')
})

test('the script ships only on a page that asked for it', () => {
  assert.match(layout, /live\?: boolean/, 'the layout takes the flag')
  assert.match(layout, /const \{ title, subtitle, live = false \} = Astro\.props/, 'and it is off by default')
  assert.match(layout, /data-live=\{live \? '' : undefined\}/, 'the marker is on main')
  assert.match(
    layout.replace(/\{\/\*[\s\S]*?\*\/\}/g, ''),
    /live && \(\s*<script>/,
    'and the script tag itself is conditional, so a page without it ships nothing',
  )
})

test('one page at a time, and today that is one page', () => {
  // A mechanism that turned itself on for all 78 forms at once would be 78
  // things to check at once. When this list grows, it should grow because
  // somebody used the page and decided it was better.
  const pages = './../src/pages/app'
  const live: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${dir}/${entry.name}`)
      else if (entry.name.endsWith('.astro')) {
        const body = read(`${dir}/${entry.name}`)
        if (/<App\b[^>]*\slive\b/.test(body)) live.push(`${dir}/${entry.name}`)
      }
    }
  }
  walk(pages)
  assert.deepEqual(live.sort(), [
    './../src/pages/app/index.astro',
    './../src/pages/app/reminders/index.astro',
  ])
})

test('a page with a print button does not go live while its listener is inline', () => {
  /*
   * A trap worth a test rather than a comment.
   *
   * `settlements/[id]` and `drivers/[id]/file` each bind window.print() to one
   * element when the page loads. Replace `<main>` under that listener and the
   * button silently stops working. Whoever makes one of those pages live has to
   * move the listener into the script in the same change — and if they move it
   * without deleting the inline one, the dialog opens twice.
   */
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(new URL(dir, import.meta.url), { withFileTypes: true })) {
      if (entry.isDirectory()) walk(`${dir}/${entry.name}`, out)
      else if (entry.name.endsWith('.astro')) out.push(`${dir}/${entry.name}`)
    }
    return out
  }
  for (const path of walk('./../src/pages/app')) {
    const body = read(path)
    if (!/window\.print\(\)/.test(body)) continue
    assert.doesNotMatch(
      body,
      /<App\b[^>]*\slive\b/,
      `${path} is live and still binds print inline — move it into live-forms.ts`,
    )
  }
})
