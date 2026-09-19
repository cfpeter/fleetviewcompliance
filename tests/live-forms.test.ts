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
  assert.match(code, /if \(!next\) \{\s*location\.href = response\.url/)
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
  assert.match(code, /history\.replaceState\(null, '', response\.url\)/)
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
  assert.deepEqual(live, ['./../src/pages/app/reminders/index.astro'])
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
