/**
 * Shared facts for the legal pages, in one place so the privacy policy and the
 * terms cannot drift apart or contradict each other.
 *
 * That is the whole reason this file exists. Two documents that each name the
 * entity, the date and the list of service providers in their own prose will
 * disagree within a month, and a privacy policy that disagrees with the terms
 * beside it is worse than either one alone.
 *
 * THREE NAMES (they do not have to match — and usually do not):
 *
 *   PRODUCT_NAME  — brand customers see: "FleetView"
 *   SITE_HOST     — domain for the app and email: fleetviewcompliance.com
 *   LEGAL_ENTITY  — California LLC that operates the product (contracts, bank).
 *                   Must match the Secretary of State filing exactly.
 *
 * WHAT IS *NOT* HERE, and why. The email address, the site URL, the product
 * label and the business location are all owned by src/lib/site.ts, which the
 * marketing pages already read. They are imported and re-exported below rather
 * than retyped: a second copy of the contact address is a second address to get
 * wrong, and the one on the legal pages is the one a regulator writes to.
 */

import { site } from './site.ts'

/** Brand / product name shown in the UI and marketing. */
export const PRODUCT_NAME = 'FleetView'

/** Longer product label. Owned by site.ts — the header and footer render it. */
export const PRODUCT_NAME_LONG = site.name

/**
 * Registered California LLC that provides FleetView.
 * Must match Articles of Organization, SOS business search, and bank.
 * If the SOS spelling differs by even a comma, update this string to match.
 *
 * NOTE FOR WHOEVER OWNS site.ts: `site.legalEntity` is still an empty TODO and
 * is read by nothing. This is the live value. Delete that field, or point it
 * here — two places to hold one company name is exactly what this file exists
 * to prevent.
 */
export const LEGAL_ENTITY = 'Papajanian Software LLC'

/** Public website hostname (no scheme). Derived, so it cannot drift from site.url. */
export const SITE_HOST = new URL(site.url).host

/** Canonical site URL for legal notices. */
export const SITE_URL = site.url

/** The address customers and regulators write to. Owned by site.ts. */
export const CONTACT_EMAIL = site.email

/**
 * Privacy requests.
 *
 * Deliberately the same mailbox as CONTACT_EMAIL rather than a privacy@ alias
 * that nobody has created yet. A published address that bounces is worse than a
 * shared one: a CCPA request has a 45-day clock on it, and the clock does not
 * care that the alias was never set up.
 */
export const PRIVACY_EMAIL = site.email

/** City and state. The only place the business address appears on the site. */
export const LEGAL_LOCATION = site.legalLocation

/** Shown on both documents. Change whenever either is materially revised. */
export const EFFECTIVE_DATE = '16 September 2026'

export const JURISDICTION = 'the State of California'
export const VENUE = 'Los Angeles County, California'

/**
 * The product in one line, so the legal pages describe the same business as the
 * marketing pages.
 *
 * REWRITTEN from the old wording, which described a product that no longer
 * exists. It said "collect supporting documents" — there is no document upload
 * anywhere in this app — and it stopped at deadlines, which is now less than
 * half of what ships. Dispatch, loads, customers, settlements and IFTA are all
 * in the product, and a legal page that does not mention them is describing
 * somebody else's software.
 */
export const PRODUCT_DESCRIPTION =
  'software for small trucking carriers that tracks compliance deadlines, runs dispatch ' +
  'and loads, works out driver pay, prepares IFTA figures, and makes proof links you can ' +
  'send to a broker or an insurer'

/**
 * Every third party that receives customer or driver data, and why.
 *
 * THIS LIST IS A PROMISE, AND IT IS A PROMISE ABOUT TODAY. A service goes on it
 * when code in this repository actually sends it data — not when a binding is
 * declared, not when a key is in .env.example, not when it is on the roadmap.
 *
 * Two things are deliberately absent, and both were checked rather than assumed:
 *
 *   Cloudflare R2. The DOCUMENTS bucket is bound in wrangler.jsonc and a
 *   `documents` table exists in the schema (0003), but nothing in src/ reads or
 *   writes either one. There is no upload feature. Listing a store that holds
 *   nothing tells a carrier his driver's medical card is sitting in an object
 *   bucket somewhere, which is not true. (R2 is Cloudflare either way, so when
 *   uploads ship this is a change of wording on the Cloudflare row, not a new
 *   company.)
 *
 *   Stripe. There is no billing code in this repository. Naming a payment
 *   processor before one exists invites the reader to believe his card is on
 *   file with somebody, and it is not.
 *
 * STRIPE IS COMING, AND THIS IS THE TRIPWIRE. 0024_billing.sql landed while
 * this file was being written; it describes `src/lib/billing/` and
 * `src/pages/api/stripe/webhook.ts`, and neither exists yet. The day either one
 * does, three things go stale together and must move in the same commit:
 *
 *   1. a Stripe row in SUBPROCESSORS below;
 *   2. the sentence in privacy.astro that says no payment processor holds
 *      anything for us — it becomes false at that moment;
 *   3. a billing line in the "What we hold" list on the same page.
 *
 * 0023_custom_reminders.sql is the same shape: when `src/lib/reminders.ts`
 * exists, the owner's own reminder titles, notes and dates are personal data we
 * hold, and the privacy page has to say so.
 *
 * Add the row the same day the code that needs it merges, not after.
 */
export const SUBPROCESSORS: { name: string; role: string; location: string }[] = [
  {
    name: 'Supabase',
    role:
      'Database and sign-in. Holds every record in your account: carrier, drivers, vehicles, ' +
      'loads, customers, settlements, IFTA figures, and proof links.',
    location: 'United States',
  },
  {
    name: 'Cloudflare',
    role:
      'Runs the website and the app (Cloudflare Workers). Every request passes through it. ' +
      'It handles requests while you use the product; it is not where your records are kept.',
    location: 'United States (global network)',
  },
  {
    name: 'Resend',
    role:
      'Sends our email: the deadline digest, alerts, and sign-in emails. Receives the address ' +
      'we send to and what the message says.',
    location: 'United States',
  },
  {
    name: 'Twilio',
    role:
      'Sends text messages. Used to text the six-digit code that proves a USDOT number is ' +
      'yours. That code goes to the phone number on the public federal record, not to a ' +
      'number typed into our form.',
    location: 'United States',
  },
]

/**
 * Data we send OUT to a third party at the customer's (or visitor's) request,
 * as distinct from a processor acting for us.
 */
export const OUTBOUND_LOOKUPS: { name: string; sent: string }[] = [
  {
    name: 'FMCSA public data (data.transportation.gov)',
    sent:
      'A USDOT number, to read the public Motor Carrier Census and operating-authority ' +
      'record. No driver information and no load information is sent.',
  },
]
