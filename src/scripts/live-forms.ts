/**
 * Submitting a form without throwing the page away.
 *
 * THE OWNER'S WORDS: "all i care is about the forms and buttons we click, i
 * just dont like the refresh on those... going from one page to another to
 * render from server is fine... but the actual content like updates, create,
 * done, finish, add date, add driver, mark done — this is what we need."
 *
 * So links are untouched. A click that goes somewhere else is still a real
 * document request, which is what keeps the app honest on one bar of signal.
 * Only the submit of a form that posts back to the page it is standing on is
 * intercepted, and all that changes is that the answer arrives without the
 * white flash and without losing where he was on the page.
 *
 * THIS WORKS BECAUSE OF THE ARCHITECTURE, NOT IN SPITE OF IT. Every form here
 * posts to its own address and the server answers with a whole page after a
 * 303. So there is nothing to invent: fetch the same POST, take the `<main>`
 * out of the page that comes back, and put it where the old one was. No JSON
 * endpoint, no client-side state, no second copy of any rule. The server is
 * still the only thing that decides what is true, and it is still the same
 * handler doing it — if this script never runs, the form works exactly as it
 * does today.
 *
 * OPT-IN, ONE PAGE AT A TIME. Nothing happens unless a form sits inside an
 * element carrying `data-live`, which the App layout puts on `<main>` when a
 * page asks for it. A mechanism that turned itself on for all 78 forms at once
 * would be 78 things to check at once.
 */

/**
 * Does `new FormData(form, submitter)` actually carry the button's own name?
 *
 * THIS CHECK IS NOT OPTIONAL AND IT IS NOT DEFENSIVE. Every write on this app
 * is chosen by `name="intent"` on the BUTTON, not by a field in the form. A
 * browser that ignores the second argument does not throw — it quietly returns
 * a body with no `intent` in it, the handler falls through to its "unknown
 * intent" branch, and the owner watches a button do nothing at all. So the
 * capability is proved against a real form before anything is intercepted, and
 * where it is missing this file does nothing whatsoever.
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

function sameDocument(a: string): boolean {
  try {
    const to = new URL(a, location.href)
    return to.origin === location.origin && to.pathname === location.pathname
  } catch {
    return false
  }
}

/**
 * Where to put the reader after the answer lands.
 *
 * A refusal has to be READ, so it takes the screen. Anything else leaves him
 * exactly where he was — which is the entire point of the exercise, and why
 * this restores the scroll position rather than jumping to an anchor.
 */
function settle(main: Element, previousY: number): void {
  const refusal = main.querySelector<HTMLElement>('[role="alert"], [data-refusal]')
  if (refusal) {
    refusal.scrollIntoView({ block: 'center' })
    // `tabindex="-1"` is already on the shared error summary, so this moves a
    // screen reader to the sentence rather than leaving it at the top.
    refusal.focus?.()
    return
  }
  window.scrollTo(0, previousY)
}

document.addEventListener('submit', (event) => {
  if (!CARRIES_THE_BUTTON) return
  const form = event.target
  if (!(form instanceof HTMLFormElement)) return
  if (event.defaultPrevented) return
  if (form.hasAttribute(GAVE_UP)) return

  // Opt-in, and a form that posts somewhere else is somebody leaving the page.
  // `/logout` is the live example: it posts to its own address and answers with
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
  main.setAttribute('aria-busy', 'true')

  /** The browser's own submit, for anything this script cannot finish. */
  const handOver = () => {
    form.setAttribute(GAVE_UP, '1')
    submitter.disabled = wasDisabled
    form.requestSubmit(submitter)
  }

  void (async () => {
    let response: Response
    try {
      // Same-origin, so the browser sends the Origin header that `checkOrigin`
      // checks and the `Sec-Fetch-Site` that `flashText` checks. Nothing about
      // the request the handler sees is different from a real form post.
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

    // A handler that sends him somewhere else — deleted the row, started a
    // checkout, signed him out — is a real navigation, and he asked for those
    // to stay real. This is also what keeps the left-hand navigation honest:
    // swapping another page's `<main>` under this page's header would highlight
    // the wrong thing.
    if (!sameDocument(response.url)) {
      location.href = response.url
      return
    }

    let next: Element | null = null
    try {
      const html = await response.text()
      next = new DOMParser().parseFromString(html, 'text/html').querySelector('#main')
      if (next) {
        const title = new DOMParser().parseFromString(html, 'text/html').title
        if (title) document.title = title
      }
    } catch {
      next = null
    }

    if (!next) {
      location.href = response.url
      return
    }

    main.replaceWith(next)
    // The address has to match what is on screen, or a refresh shows something
    // else. `replaceState` and not `push`: the POST answer takes the place of
    // the page that submitted it, so Back still goes back a page rather than
    // re-offering a form that has already been sent.
    history.replaceState(null, '', response.url)
    next.removeAttribute('aria-busy')
    settle(next, previousY)
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
 * prints twice.
 */
