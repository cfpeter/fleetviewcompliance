/**
 * Working a page without throwing it away.
 *
 * THE OWNER'S WORDS, twice. First: "all i care is about the forms and buttons
 * we click, i just dont like the refresh on those... i dont care if going from
 * one page to another to render from server is fine... but the actual content
 * like updates, create, done, finish, add date, add driver, mark done — this is
 * what we need." Then, after the forms were done: "even like when clicking the
 * option on the reminder it refresh the page, its so annoying."
 *
 * THE LINE IS NOT FORM VERSUS LINK. It is "am I still on the same page". A
 * suggestion chip, a filter, a show/hide toggle and a tab are all `<a href>`
 * that change only the query string — the reader has not gone anywhere, and
 * reloading the document under him is the same annoyance as reloading it after
 * a save. A link to another driver IS going somewhere, and that stays a real
 * document request, which is what keeps the app honest on one bar of signal
 * and keeps the left-hand navigation pointing at the right thing.
 *
 * So: same path, swap. Different path, let the browser go.
 *
 * THIS WORKS BECAUSE OF THE ARCHITECTURE, NOT IN SPITE OF IT. Every form posts
 * to its own address and every page answers with a whole document. There is
 * nothing to invent — fetch the same address, take the `<main>` out of the
 * answer, put it where the old one was. No JSON endpoint, no client-side state,
 * no second copy of any rule. The server still decides everything, and if this
 * script never runs the page behaves exactly as it does today.
 *
 * OPT-IN, ONE PAGE AT A TIME, on `data-live` from the App layout.
 */

/**
 * Does `new FormData(form, submitter)` actually carry the button's own name?
 *
 * THIS CHECK IS NOT OPTIONAL AND IT IS NOT DEFENSIVE. Every write in this app
 * is chosen by `name="intent"` on the BUTTON, not by a field in the form. A
 * browser that ignores the second argument does not throw — it quietly returns
 * a body with no `intent`, the handler falls through to its "unknown intent"
 * branch, and the owner watches Done do nothing at all. So the capability is
 * proved against a real form before anything is intercepted, and where it is
 * missing this file does nothing whatsoever.
 */
const CARRIES_THE_BUTTON = (() => {
  try {
    const form = document.createElement('form')
    const button = document.createElement('button')
    button.type = 'submit'
    button.name = 'intent'
    button.value = 'probe'
    form.appendChild(button)
    return new FormData(form, button).get('intent') === 'probe'
  } catch {
    return false
  }
})()

/** Marks a form we have already given up on, so the retry is not intercepted again. */
const GAVE_UP = 'data-live-gave-up'

/**
 * The address the `<main>` on screen was rendered for — path and query, never
 * the fragment.
 *
 * THIS EXISTS BECAUSE OF A BUG THE TEST CAUGHT. Following a plain `#anchor`
 * link is a same-document navigation, and browsers fire `popstate` for those
 * as well as for the Back button. So every in-page jump — every "skip to the
 * form" link on the page — was refetching and rebuilding the whole `<main>`:
 * a wasted round trip, and worse, anything typed into a form on that page
 * would have been thrown away by the swap.
 *
 * A fragment moves the reader inside the page we already have. Only a change
 * of path or query is a different page.
 */
let rendered = location.pathname + location.search
const addressOnScreen = () => location.pathname + location.search

/**
 * WHICH ANSWER IS STILL THE CURRENT ONE.
 *
 * The page is NOT frozen while a request is in flight — that is the whole
 * point of doing this with `fetch` — so he can press a second button before
 * the first has answered. Both come back, and without this the one that
 * happens to land LAST wins, which may well be the older of the two: a screen
 * quietly showing the state before the thing he just did.
 *
 * Every request takes a ticket. An answer whose ticket is no longer the latest
 * is dropped on the floor — the write it came from already happened on the
 * server, and the newer answer is a fresher picture of the same database.
 */
let sequence = 0

/**
 * THE ONE THING A FETCH DOES NOT GET FOR FREE.
 *
 * A real form post gives the browser's own progress: the tab spins, the bar
 * moves, and the reader knows the click landed. A fetch gives him nothing at
 * all, so on a slow connection the button looks ignored and he presses it
 * again. That is worse than the reload he asked us to remove.
 *
 * Delayed, deliberately: an answer that arrives in 80ms must not flash a bar
 * across the screen on its way past. Anything slower than a blink says so.
 */
let showBusyAfter: number | undefined

function startWorking(main: Element): void {
  main.setAttribute('aria-busy', 'true')
  clearTimeout(showBusyAfter)
  showBusyAfter = window.setTimeout(() => {
    document.documentElement.setAttribute('data-working', '')
  }, 150)
}

function stopWorking(): void {
  clearTimeout(showBusyAfter)
  document.documentElement.removeAttribute('data-working')
}

/** Still the same page: same origin, same path. Only the query may differ. */
function sameDocument(href: string): boolean {
  try {
    const to = new URL(href, location.href)
    return to.origin === location.origin && to.pathname === location.pathname
  } catch {
    return false
  }
}

/**
 * Where to put the reader once the answer is on screen.
 *
 * A refusal has to be READ, so it takes the screen and the keyboard. A link
 * that named a place goes to that place. Everything else leaves him exactly
 * where he was, which is the whole point of the exercise.
 */
function settle(main: Element, previousY: number, hash: string): void {
  const refusal = main.querySelector<HTMLElement>('[role="alert"]')
  if (refusal) {
    refusal.scrollIntoView({ block: 'center' })
    // `tabindex="-1"` is already on the shared error summary, so this moves a
    // screen reader to the sentence rather than leaving it where it was.
    refusal.focus?.()
    return
  }
  if (hash) {
    const target = document.getElementById(decodeURIComponent(hash.slice(1)))
    // `scroll-padding-top` in global.css clears the sticky header for this.
    if (target) {
      target.scrollIntoView()
      return
    }
  }
  window.scrollTo(0, previousY)
}

/**
 * Lift a confirmation out of the page and into the corner.
 *
 * WHY: "Saved" is written at the top of `<main>`, which was in front of the
 * reader's eyes back when a save reloaded the page and put him there. He stays
 * exactly where he was now, so that line can be a screen and a half above him,
 * confirming a thing he cannot see.
 *
 * MOVED, NEVER COPIED. The server wrote the sentence and there is one of it;
 * printing it inline AND in the corner would say the same thing twice, and the
 * two could drift the moment anybody edits one. With no JavaScript nothing is
 * lifted and the message renders where it is written, as it always did.
 *
 * REFUSALS ARE NOT LIFTED. They carry `role="alert"`, stay beside the form
 * that was refused, and `settle()` puts the screen and the keyboard on them —
 * a message that slides away after five seconds is the wrong shape for "we did
 * not save that".
 */
const TOAST_LIFE = 6000

function hoistFlash(root: ParentNode): void {
  const region = document.getElementById('toasts')
  if (!region) return
  for (const flash of Array.from(root.querySelectorAll<HTMLElement>('[data-flash]'))) {
    // The inline spacing belongs to the top of a page, not to a stack in a
    // corner; the region's own CSS does the gaps.
    flash.classList.remove('mb-5')
    region.appendChild(flash)

    const dismiss = () => {
      flash.setAttribute('data-leaving', '')
      // Long enough for the fade in global.css, short enough that a second
      // confirmation is not queued behind a ghost.
      window.setTimeout(() => flash.remove(), 200)
    }
    flash.addEventListener('click', dismiss)
    window.setTimeout(dismiss, TOAST_LIFE)
  }
}

/** The `<main>` out of a whole page, and its title. Null if this is not one of ours. */
async function pageFrom(response: Response): Promise<{ main: Element; title: string } | null> {
  try {
    const parsed = new DOMParser().parseFromString(await response.text(), 'text/html')
    const main = parsed.querySelector('#main')
    return main ? { main, title: parsed.title } : null
  } catch {
    return null
  }
}

/**
 * Put an answer on screen.
 *
 * `push` is the one difference between following a link and submitting a form.
 * A link is somewhere he can come Back from, so it gets its own history entry.
 * A form's answer REPLACES the page that submitted it, so Back goes back a
 * page rather than re-offering a form he has already sent.
 */
async function land(
  response: Response,
  options: { push: boolean; previousY: number; hash: string; address?: string; ticket: number },
): Promise<void> {
  // Somebody pressed something else while this was in the air. That write has
  // already happened; this picture of it is simply out of date.
  if (options.ticket !== sequence) return
  stopWorking()
  const here = document.getElementById('main')
  if (!here) {
    location.href = response.url
    return
  }

  // A handler that sends him somewhere else — deleted the row, started a
  // checkout, signed him out — is a real navigation, and he asked for those to
  // stay real.
  if (!sameDocument(response.url)) {
    location.href = response.url
    return
  }

  const page = await pageFrom(response)
  if (!page) {
    location.href = response.url
    return
  }

  here.replaceWith(page.main)
  if (page.title) document.title = page.title
  hoistFlash(page.main)
  // The address has to match what is on screen, or a refresh shows something
  // else. `response.url` drops the fragment, so a link's own hash is passed in.
  const address = options.address ?? response.url
  if (options.push) history.pushState(null, '', address)
  else history.replaceState(null, '', address)
  rendered = addressOnScreen()
  settle(page.main, options.previousY, options.hash)
}

// --------------------------------------------------------------- the forms

document.addEventListener('submit', (event) => {
  if (!CARRIES_THE_BUTTON) return
  const form = event.target
  if (!(form instanceof HTMLFormElement)) return
  if (event.defaultPrevented) return
  if (form.hasAttribute(GAVE_UP)) return

  // Opt-in, and a form that posts somewhere else is somebody leaving the page.
  // `/logout` is the live example: it posts to another address and answers with
  // the public site, and swapping that into the signed-in shell would leave a
  // logged-out page wearing the app's navigation.
  if (!form.closest('[data-live]')) return
  if (form.method.toLowerCase() !== 'post') return
  if (form.getAttribute('action')) return

  const submitter = event.submitter
  if (!(submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement)) return

  let body: FormData
  try {
    body = new FormData(form, submitter)
  } catch {
    return
  }

  event.preventDefault()

  const main = document.getElementById('main')
  if (!main) return

  const previousY = window.scrollY
  const wasDisabled = submitter.disabled
  submitter.disabled = true
  const ticket = ++sequence
  startWorking(main)

  /** The browser's own submit, for anything this script cannot finish. */
  const handOver = () => {
    stopWorking()
    form.setAttribute(GAVE_UP, '1')
    submitter.disabled = wasDisabled
    form.requestSubmit(submitter)
  }

  void (async () => {
    let response: Response
    try {
      // Same-origin, so the browser sends the Origin header that `checkOrigin`
      // checks and the `Sec-Fetch-Site` that `flashText` checks. Nothing about
      // the request the handler sees differs from a real form post.
      response = await fetch(form.action || location.href, {
        method: 'POST',
        body,
        credentials: 'same-origin',
        redirect: 'follow',
      })
    } catch {
      // Signal dropped mid-flight. Hand it to the browser, which has a better
      // story for that than we do.
      handOver()
      return
    }
    await land(response, { push: false, previousY, hash: '', ticket })
  })()
})

// --------------------------------------------------------------- the links

document.addEventListener('click', (event) => {
  if (event.defaultPrevented) return
  if (event.button !== 0) return
  // A modified click is a request for a new tab or a saved file, and it belongs
  // to the browser.
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return

  const target = event.target
  const link = target instanceof Element ? target.closest('a') : null
  if (!(link instanceof HTMLAnchorElement)) return
  if (!link.closest('[data-live]')) return
  if (link.hasAttribute('download')) return
  if (link.target && link.target !== '_self') return
  if (!sameDocument(link.href)) return

  const to = new URL(link.href, location.href)
  // Only the hash changed, so this is an in-page jump and the browser already
  // does it better than we would — natively, and with no request at all.
  if (to.search === location.search) return

  event.preventDefault()

  const main = document.getElementById('main')
  if (!main) return
  const previousY = window.scrollY
  const ticket = ++sequence
  startWorking(main)

  void (async () => {
    let response: Response
    try {
      response = await fetch(to.href, { credentials: 'same-origin' })
    } catch {
      location.href = to.href
      return
    }
    await land(response, { push: true, previousY, hash: to.hash, address: to.href, ticket })
  })()
})

// -------------------------------------------------------------- going back

/**
 * The Back button, for the entries this script created.
 *
 * `pushState` without this is the bug it would have shipped: the address bar
 * changes and the page does not, so Back looks like it did nothing. Only our
 * own same-document entries reach here — an entry made by a real navigation is
 * a real navigation again, and the browser handles it without telling us.
 */
window.addEventListener('popstate', () => {
  const main = document.getElementById('main')
  if (!main?.closest('[data-live]')) return
  // Only the fragment moved, so the page on screen is already the right one and
  // the browser has already scrolled it. Rebuilding it here would be a round
  // trip for nothing and would throw away whatever is typed into a form.
  if (addressOnScreen() === rendered) return
  const ticket = ++sequence
  startWorking(main)
  void (async () => {
    let response: Response
    try {
      response = await fetch(location.href, { credentials: 'same-origin' })
    } catch {
      location.reload()
      return
    }
    if (ticket !== sequence) return
    stopWorking()
    // No history write: the browser has already moved the entry.
    const page = await pageFrom(response)
    if (!page) {
      location.reload()
      return
    }
    main.replaceWith(page.main)
    if (page.title) document.title = page.title
    hoistFlash(page.main)
    rendered = addressOnScreen()
    settle(page.main, window.scrollY, location.hash)
  })()
})

/*
 * ON THE TWO PRINT BUTTONS, when their pages eventually opt in.
 *
 * `settlements/[id]` and `drivers/[id]/file` each bind `window.print()` to one
 * element on page load. That listener dies the moment `<main>` is replaced
 * under it, and the button then does nothing with nothing on screen to say so.
 * When either page gets `live`, move its listener here as a delegated click on
 * `#print` and delete the inline one — both, in the same change, or the button
 * prints twice. tests/live-forms.test.ts refuses the half of that change.
 */

// A page reached the ordinary way — a real navigation with `?saved=1` on it —
// carries its confirmation too, and it belongs in the same corner as the rest.
hoistFlash(document)
