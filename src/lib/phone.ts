/**
 * Phone numbers, in one place, because two parsers would be two behaviours.
 *
 * `toE164` was written inside claims.ts to answer one question: is this census
 * row's number worth spending a verification SMS on? That is the same question
 * every phone number in this product has to survive. A driver's number is where
 * a deadline reminder is delivered; a broker's is what a dispatcher dials at
 * 5am when a load is sitting. Writing a second, gentler parser for the driver
 * form would mean two definitions of "dialable", and the day they disagree is
 * the day an alert is queued against a number the provider silently refuses —
 * a missed deadline caused by the one feature that exists to prevent them.
 *
 * So the strict one moved here and claims.ts re-exports it. Nothing that
 * already imported it had to change, and there is still exactly one answer.
 */

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string }

/**
 * A phone number as E.164, or null when it is not a number we can send to.
 *
 * Strict on purpose, for two separate reasons that happen to want the same
 * rule: Twilio rejects anything that is not E.164 (and reports it as a failed
 * send long after the page has told the user a message is on its way), and a
 * mask that shows the last four digits of a five-digit field has revealed
 * almost all of it. A value that is not a plausible North American number is
 * therefore not a channel at all — better an honest refusal on the form than a
 * message sent into the void with a confident sentence on screen.
 */
export function toE164(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '')
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits
  if (national.length !== 10) return null

  // NANP: neither the area code nor the exchange may start with 0 or 1. This
  // rejects the placeholder rubbish in the older census rows — 1111111111 and
  // friends — before we spend a message on it.
  if (!/^[2-9]\d\d[2-9]\d{6}$/.test(national)) return null

  // Ten of the same digit passes the rule above (9999999999) and is never a
  // real line. The census has these.
  if (/^(\d)\1{9}$/.test(national)) return null

  return `+1${national}`
}

/**
 * A phone number as somebody typed it into a form: E.164, NULL, or a refusal.
 *
 * BLANK STAYS BLANK, and that is the first branch for a reason. This product
 * asks for a driver on the strength of a name and lets the paperwork follow;
 * turning the phone box into a required field would be the same mistake as a
 * required GVWR, and the value it collects would be invented. '' must reach
 * Postgres as NULL rather than as an empty string — an empty string is a VALUE,
 * it reads as answered, and it would be picked up by any later "who can we
 * text?" query as a number we hold.
 *
 * Everything else is refused rather than stored. Letters inside a phone number
 * — 'call cell 818 334 0168', '818-334-0168 ext 2' — are the shape this
 * actually arrives in, and every one of them is a number nobody can dial from
 * the record. Storing it means the office manager believes she has a number for
 * that driver right up until the morning an alert does not arrive.
 *
 * `label` names the field so one message can serve the driver form and the
 * customer form without either of them reading like it was written for the
 * other.
 */
export function parsePhone(
  raw: FormDataEntryValue | string | null,
  label = 'Phone number',
): Parsed<string | null> {
  const typed = String(raw ?? '').trim()
  if (typed === '') return { ok: true, value: null }

  const e164 = toE164(typed)
  if (!e164) {
    return {
      ok: false,
      message:
        `${label}: we could not read that as a number we can dial. Type ten digits, like ` +
        '(818) 334-0168. Take out any extension or note. Leave the box blank if you do not ' +
        'have the number.',
    }
  }
  return { ok: true, value: e164 }
}

/**
 * E.164 back into the shape a person reads: '+18183340168' → '(818) 334-0168'.
 *
 * Storage and display are deliberately different here. E.164 is what a provider
 * needs and what makes two spellings of one number compare equal; it is also
 * what nobody recognises as their own dispatcher's line at a glance on a roster
 * of forty drivers. Anything this cannot parse is handed back exactly as it is
 * stored, because rows written before the form started normalising are still
 * real numbers and blanking them on screen would look like data loss.
 */
export function formatPhone(raw: string | null | undefined): string {
  const e164 = toE164(raw)
  if (!e164) return (raw ?? '').trim()
  return `(${e164.slice(2, 5)}) ${e164.slice(5, 8)}-${e164.slice(8)}`
}

/**
 * The same rule on an EDIT form, where the row is older than the rule.
 *
 * `parsePhone` is right for a box somebody is filling in for the first time and
 * wrong for a box that was already full when the rule arrived. Every phone we
 * hold today predates it — seven-digit placeholders like '555-0142' — and the
 * save handlers refuse the whole submit on a bad phone, so under the strict
 * parser an owner opening a driver to type a MEDICAL CARD DATE is refused over a
 * field she never touched, on a page that will not tell her which field it is
 * really about. A compliance date that cannot be saved is the one failure this
 * product exists to prevent, and it would be caused by a number nobody is
 * dialing today: SMS is not switched on yet, so refusing the legacy value buys
 * nothing at all this morning and costs a deadline.
 *
 * So: refuse only a phone the person actually CHANGED. An untouched legacy value
 * goes back to the column exactly as it came out, unrewritten and unblanked —
 * the advisory beside the field is what asks for it to be fixed, not a refusal.
 *
 * `stored` MUST be the column, and the comparison is against `formatPhone` OF
 * it, never the column itself. The edit forms render `value={formatPhone(...)}`,
 * so the browser posts back the DISPLAYED string; compare against the raw column
 * and an untouched field reads as changed, which is the exact refusal this
 * exists to stop. Both sides are trimmed and nothing else is normalised: two
 * spellings that differ by more than whitespace are two different answers, and
 * one of them was typed.
 */
export function parsePhoneEdit(
  raw: FormDataEntryValue | string | null,
  stored: string | null | undefined,
  label = 'Phone number',
): Parsed<string | null> {
  const strict = parsePhone(raw, label)
  // Blank and anything dialable are settled by the strict parser and must stay
  // settled by it. Grandfathering is a last resort, not a second opinion.
  if (strict.ok) return strict

  const typed = String(raw ?? '').trim()
  const shown = formatPhone(stored).trim()
  // `stored`, not `typed`: what goes back is the bytes that came out of the
  // column. `formatPhone` trims for display, so writing `typed` would quietly
  // rewrite a legacy value on every unrelated save until it no longer matches
  // whatever the office has written on paper.
  if (typed === shown) return { ok: true, value: stored ?? null }

  return strict
}
