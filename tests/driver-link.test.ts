/**
 * The one-time link a driver opens with no account, and everything it refuses.
 *
 * THIS IS THE FIRST ANONYMOUS WRITE IN THE PRODUCT. Every other door an
 * unauthenticated caller has — the six share functions — is read-only, and
 * tests/share-scope.test.ts asserts they are the only ones. This file does the
 * same job for the two that 0036 adds, and it has to be stricter, because a
 * mistake here is somebody moving a date on a carrier's compliance board.
 *
 * THE TEST THAT MUST NEVER BE DELETED is the 40.307(g) one. 49 CFR 40.307(g)
 * forbids the employer, the SAP and any service agent from showing a driver his
 * return-to-duty follow-up testing schedule. The repo says so in four places and
 * all four say the same thing: enforce it in the policy, not the UI. Two
 * mechanisms do, and both are asserted below.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'
import type pg from 'pg'
import { DRIVER_DOCUMENT_KINDS } from '../src/lib/documents.ts'
import {
  ASK_ANCHOR_KEYS,
  ASK_KEYS,
  askByKey,
  DRIVER_ASKS,
  NOT_ASKABLE,
  readAsks,
  sameAsk,
} from '../src/lib/driver-link/asks.ts'
import {
  clampExpiryHours,
  DEFAULT_EXPIRY_HOURS,
  MAX_EXPIRY_HOURS,
  MIN_EXPIRY_HOURS,
  newSubmissionKey,
  readAskDate,
} from '../src/lib/driver-link/link.ts'
import { hashProofToken, newProofToken } from '../src/lib/proof/token.ts'
import { resolveAnchor } from '../src/lib/rules/anchors.ts'
import {
  actAs,
  actAsAnon,
  actAsOwner,
  configured,
  makeUser,
  queryAsOwner,
  withRollback,
} from './helpers.ts'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const TODAY = new Date(Date.UTC(2026, 8, 19))

// ---------------------------------------------------------------------------
// 49 CFR 40.307(g)
// ---------------------------------------------------------------------------

test('a driver can never be asked for his return-to-duty schedule', () => {
  // Mechanism one: the key is not in the catalogue, and the catalogue is the
  // only thing the page or the function ever reads.
  assert.ok(
    !ASK_ANCHOR_KEYS.includes('return_to_duty_test_date'),
    'return_to_duty_test_date is askable — 49 CFR 40.307(g) forbids showing it to the driver',
  )
  assert.ok(
    NOT_ASKABLE.includes('return_to_duty_test_date'),
    'it must be derived as NOT askable, from the registry, not merely absent',
  )

  // Mechanism two: the database refuses to store it as an ask, so even a
  // hand-written row cannot put it in front of a driver.
  const sql = read('../supabase/migrations/0034_driver_links.sql')
  assert.match(sql, /asks <@ array\['medical', 'cdl', 'spe', 'intracity', 'diabetes', 'vision'\]/)

  // Mechanism three: the reading function has no branch that could return it.
  //
  // Comments stripped first. That file EXPLAINS 40.307(g) at length — quoting
  // the rule is the opposite of breaking it — so prose that names the thing it
  // rules out must not read as the thing itself. Same trap as asserting a page
  // ships no `role="tablist"` while its comment explains why it does not.
  const fn = read('../supabase/migrations/0036_driver_link_functions.sql').replace(
    /^\s*--.*$/gm,
    '',
  )
  assert.doesNotMatch(fn, /return_to_duty/, 'the view function must not name it in its SQL')
})

test('the carrier performs these, so the driver is never asked for them', () => {
  // Texting a man a link asking for his own Clearinghouse query date is asking
  // for a number he has no way to know. An empty answer here is a real answer:
  // there is no link worth sending for that rule.
  for (const key of [
    'annual_mvr_last_obtained',
    'annual_review_last_completed',
    'clearinghouse_query_last_run',
  ]) {
    assert.ok(!ASK_ANCHOR_KEYS.includes(key), `${key} is the carrier's to record, not the driver's`)
  }
})

test('the catalogue and the database constraint are the same six keys', () => {
  // Written twice, in two languages. Drift is invisible until a save fails.
  assert.deepEqual([...ASK_KEYS], ['medical', 'cdl', 'spe', 'intracity', 'diabetes', 'vision'])
  assert.deepEqual(
    DRIVER_ASKS.map((a) => a.key),
    [...ASK_KEYS],
  )
  const sql = read('../supabase/migrations/0034_driver_links.sql')
  for (const key of ASK_KEYS) assert.match(sql, new RegExp(`'${key}'`))
})

test('a CDL expiry goes to the column, never to a compliance record', () => {
  // A record under `cdl_expires` SILENTLY outranks drivers.cdl_expires_on — the
  // driver's own page would keep showing the right date while the rules ran off
  // the wrong one. Same reason the dashboard's row editor writes the column.
  const cdl = DRIVER_ASKS.find((a) => a.key === 'cdl')
  assert.ok(cdl)
  assert.deepEqual(cdl.target, { via: 'column', column: 'cdl_expires_on' })
  assert.ok(!ASK_ANCHOR_KEYS.includes('cdl_expires'))
})

// ---------------------------------------------------------------------------
// What a posted form can and cannot widen
// ---------------------------------------------------------------------------

test('a crafted form cannot widen what a link asks for', () => {
  assert.deepEqual(readAsks(['medical', 'ssn', 'email', 'dob', '*', '', 'MEDICAL']), ['medical'])
  assert.deepEqual(readAsks([]), [])
  for (const junk of ['ssn', 'dob', 'phone', 'toString', 'constructor', '']) {
    assert.equal(askByKey(junk), null, `${junk} is not an ask`)
  }
})

test('asks come back in catalogue order, so two identical links compare equal', () => {
  // `sameAsk` decides which live link a new one retires. Order-sensitive by
  // design, which only works because readAsks normalises it.
  assert.deepEqual(readAsks(['cdl', 'medical']), ['medical', 'cdl'])
  assert.ok(sameAsk(readAsks(['cdl', 'medical']), readAsks(['medical', 'cdl'])))
  assert.ok(!sameAsk(readAsks(['medical']), readAsks(['medical', 'cdl'])))
})

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

test('the expiry is clamped, and an unreadable one is not forever', () => {
  // This number decides how long a bearer token for an unauthenticated write
  // stays usable. Every path funnels through here, including the ones that do
  // not exist yet — the predecessor clamped in its two callers and left the
  // minting function trusting its argument.
  assert.equal(clampExpiryHours(undefined), DEFAULT_EXPIRY_HOURS)
  assert.equal(clampExpiryHours('never'), DEFAULT_EXPIRY_HOURS)
  assert.equal(clampExpiryHours(Number.NaN), DEFAULT_EXPIRY_HOURS)
  assert.equal(clampExpiryHours(Number.POSITIVE_INFINITY), DEFAULT_EXPIRY_HOURS)
  assert.equal(clampExpiryHours(0), MIN_EXPIRY_HOURS)
  assert.equal(clampExpiryHours(-40), MIN_EXPIRY_HOURS)
  assert.equal(clampExpiryHours(100_000), MAX_EXPIRY_HOURS)
  assert.equal(clampExpiryHours(72), 72)
})

test('the database enforces the ceiling too, on the row that matters', () => {
  // The predecessor's CHECK constrained the carrier's DEFAULT column and left
  // expires_at a bare timestamptz, so its own claim that the ceiling was in the
  // database was untrue of the link.
  const sql = read('../supabase/migrations/0034_driver_links.sql')
  assert.match(sql, /expires_at > created_at and expires_at <= created_at \+ interval '30 days'/)
})

// ---------------------------------------------------------------------------
// The dates he types
// ---------------------------------------------------------------------------

test('a blank box means "not this one", never "clear what you have"', () => {
  assert.deepEqual(readAskDate('', TODAY), { ok: true, value: null })
  assert.deepEqual(readAskDate('   ', TODAY), { ok: true, value: null })
  assert.deepEqual(readAskDate(null, TODAY), { ok: true, value: null })
})

test('a date that cannot be read, or is the wrong decade, comes back as a sentence', () => {
  assert.equal(readAskDate('banana', TODAY).ok, false)
  assert.equal(readAskDate('2027-02-31', TODAY).ok, false, 'a day that does not exist')
  assert.equal(readAskDate('2099-01-01', TODAY).ok, false, 'nobody renews ten years out')
  assert.equal(readAskDate('1995-01-01', TODAY).ok, false, 'nothing in his hand expired then')
  assert.deepEqual(readAskDate('2027-04-15', TODAY), { ok: true, value: '2027-04-15' })
})

test('a staged photo key carries no tenant, and nothing guessable', () => {
  // Unlike newStorageKey, which leads with the carrier id for incident tracing.
  // The page writing this key is anonymous and has no business learning one.
  const a = newSubmissionKey('jpg')
  const b = newSubmissionKey('jpg')
  assert.match(a, /^driver-submissions\/[0-9a-f]{32}\.jpg$/)
  assert.notEqual(a, b)
})

test('a date points the way its own paper points, derived and not typed twice', () => {
  /*
   * The owner ticked "Intracity zone exemption" and the form asked him for an
   * "Expiry date". A zone exemption carries the day it was GIVEN — its anchor
   * is `kind: 'last_done'` — and so do the diabetes and vision assessments.
   * Three of six asked the wrong question.
   *
   * Checked against the anchor registry rather than against a second list, so
   * the catalogue cannot drift from the engine that reads the dates back.
   */
  for (const ask of DRIVER_ASKS) {
    if (ask.target.via !== 'anchor') {
      // A CDL is an expiry and has no anchor to derive from.
      assert.equal(ask.dateIs, 'expires', `${ask.key} is a licence expiry`)
      continue
    }
    const entry = resolveAnchor(ask.target.anchorKey)
    assert.ok(entry, `${ask.key} resolves`)
    assert.equal(
      ask.dateIs,
      entry.kind === 'expires' ? 'expires' : 'issued',
      `${ask.key} asks for the wrong kind of date`,
    )
    // And the words follow the direction, so the box never says "expiry" over
    // a field that wants the day something happened.
    // The LABEL only. The hint is allowed to say "not an expiry", and one does
    // — steering a man away from the wrong date on the same piece of paper is
    // the whole job of that line.
    if (ask.dateIs === 'issued') {
      assert.doesNotMatch(ask.dateLabel, /expir/i, `"${ask.dateLabel}" is the wrong question`)
    }
  }
})

test('every ask files under a document kind that actually exists', () => {
  // "Other paper" for a zone exemption was the owner's report. It happened
  // because the catalogue named a kind the document list had no entry for, so
  // the label fell through.
  const known = new Set(DRIVER_DOCUMENT_KINDS.map((k) => k.key))
  for (const ask of DRIVER_ASKS) {
    assert.ok(
      known.has(ask.documentKind),
      `${ask.key} files as "${ask.documentKind}", which is not a kind`,
    )
    assert.notEqual(
      ask.documentKind,
      'other',
      `${ask.key} was asked for by name, so its photo must not land as "Other paper"`,
    )
  }
})

test('a photo keeps the box it came out of, and only the loose ones are "other"', () => {
  // The first version took one kind for the whole submission and fell back to
  // 'other' the moment a second file arrived — so the photo the owner asked for
  // by name lost its name because an unrelated one came with it. The form knew
  // which box each file came from and threw it away.
  const page = read('../src/pages/u/[token].astro')
  assert.match(
    page,
    /files\.push\(\{ file: f, ask: ask\.key \}\)/,
    'an asked-for file remembers its ask',
  )
  assert.match(page, /files\.push\(\{ file: f, ask: '' \}\)/, 'the loose box carries none')
  assert.match(page, /customMetadata: \{ name: safeFileName\(file\.name\) \?\? 'photo', ask \}/)

  const accept = read('../src/lib/driver-link/accept.ts')
  assert.match(accept, /object\.customMetadata\?\.ask/, 'and the accept reads it back')
  assert.match(accept, /kind: from\?\.documentKind \?\? 'other'/)
  // The date he typed goes on the paper as well as on the record.
  assert.match(accept, /expires_on: from\?\.dateIs === 'expires'/)
  assert.match(accept, /issued_on: from\?\.dateIs === 'issued'/)
})

test('an accepted photo gets a key the serving route will actually accept', () => {
  /*
   * A bug the owner found. The staged object is written under
   * `driver-submissions/<random>.<ext>` — no tenant segment, because the page
   * writing it is anonymous and has no business learning a carrier id.
   *
   * I then had the accept step REUSE that key on the documents row, so the
   * submission and the document stayed joinable. It made every accepted photo
   * undownloadable: `isStorageKey` enforces `documents/<carrierId>/<hex>.<ext>`
   * and src/pages/app/documents/[id].ts checks it before the key ever reaches
   * the bucket, so the owner got "We cannot find that file."
   *
   * The accept step now copies the bytes to a real document key. Provenance did
   * not need the shared key after all — the submission row keeps its own keys,
   * its timestamp and who decided it.
   */
  const accept = read('../src/lib/driver-link/accept.ts')
  assert.match(accept, /newStorageKey\(args\.carrierId, type\.ext\)/, 'a proper document key')
  assert.match(
    accept,
    /storage_key: newStorageKey\(args\.carrierId, type\.ext\)/,
    'the row points at the copy, under a key the serving route accepts',
  )
  assert.doesNotMatch(
    accept.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''),
    /storage_key: staged/,
    'never the staged key — the serving route refuses that shape',
  )
  // And the staging key must stay tenant-free, which is what forced the copy.
  const link = read('../src/lib/driver-link/link.ts')
  assert.match(link, /`driver-submissions\/\$\{random\}\.\$\{ext\}`/)

  // The size and type are measured, and the name is carried on the object,
  // because a row without them renders as a nameless "File" with no size.
  for (const field of ['content_type: type.mime', 'byte_size: bytes.byteLength', 'file_name:']) {
    assert.ok(accept.includes(field), `an accepted document records ${field}`)
  }
})

test('every submission is kept and shown, not only the ones still waiting', () => {
  /*
   * "He says he sent it in March" is a question an owner asks months later,
   * when a card has lapsed and nobody agrees whose fault it was. The first
   * version loaded `state = 'pending'` only, so the moment he accepted or
   * rejected something it left the screen for ever — the data was all there and
   * none of it was visible.
   *
   * A rejected row is an answer too: we asked, he sent the wrong thing, here is
   * the day we told him. So nothing is filtered out and nothing is deleted.
   */
  const page = read('../src/pages/app/drivers/[id].astro')
  assert.doesNotMatch(
    page,
    /from\('driver_submissions'\)[\s\S]{0,240}?\.eq\('state', 'pending'\)/,
    'the page must load every submission, not just the queue',
  )
  assert.match(page, /from\('driver_submissions'\)[\s\S]{0,240}?state, decided_at/)

  const panel = read('../src/components/DriverLink.astro')
  assert.match(panel, /const waiting = submissions\.filter\(\(s\) => s\.state === 'pending'\)/)
  assert.match(panel, /const answered = submissions\.filter\(\(s\) => s\.state !== 'pending'\)/)
  assert.match(panel, /has sent before/, 'and the answered ones are on screen')
  // The state is a word, never a colour alone — and "accepted" must not borrow
  // the green that means "on track" anywhere else in this product.
  assert.match(panel, /You accepted/)
  assert.match(panel, /You rejected/)
})

test('the referrer policy protects the token WITHOUT breaking the form', () => {
  /*
   * A bug I shipped and had to take back, pinned so it cannot come back.
   *
   * The token is in the URL path, so the page needs a referrer policy or the
   * first thing the driver taps gets his working credential in a Referer
   * header. `no-referrer` does that — and breaks the page, because of a rule in
   * the Fetch spec: when a document's referrer policy is `no-referrer`, the
   * browser sets `Origin: null` on its form POSTs. Astro's `checkOrigin` then
   * refuses the submission and the driver reads "Cross-site POST form
   * submissions are forbidden" instead of a thank-you.
   *
   * `same-origin` protects the token just as well — a cross-origin request gets
   * no referrer at all — and keeps the Origin header on our own POST.
   *
   * A fetch() cannot catch this. fetch computes its own referrer policy and
   * ignores the document meta, so every test I had passed while the page was
   * broken for every real browser.
   */
  const layout = read('../src/layouts/Driver.astro')
  assert.match(layout, /<meta name="referrer" content="same-origin" \/>/)
  assert.doesNotMatch(
    layout.replace(/\/\*[\s\S]*?\*\//g, ''),
    /content="no-referrer"/,
    'no-referrer sends Origin: null on a form POST and checkOrigin refuses it',
  )
  // And the page must stay a plain same-origin POST — no action attribute
  // pointing anywhere else, which would be genuinely cross-site.
  const page = read('../src/pages/u/[token].astro')
  assert.match(page, /<form method="POST" enctype="multipart\/form-data"/)
  assert.doesNotMatch(page, /<form[^>]*action=/)
})

// ---------------------------------------------------------------------------
// The database, as the real anon role
// ---------------------------------------------------------------------------

describe('the anonymous door', { skip: !configured() && 'no database configured' }, () => {
  async function carrierWithLink(c: pg.Client, name: string, dot: string, asks: string[]) {
    await actAsOwner(c)
    const user = await makeUser(c, `${name}-${Date.now()}@dl.test`)
    await actAs(c, user)
    const { rows: cc } = await queryAsOwner(c, 'select create_carrier($1,$2) as id', [dot, name])
    const carrier = cc[0].id
    const { rows: d } = await c.query(
      `insert into drivers (carrier_id, first_name, last_name) values ($1,$2,'Driver') returning id`,
      [carrier, name],
    )
    const driver = d[0].id
    // The one thing a driver must never be shown, put deliberately on file so
    // the 40.307(g) assertion has something real to fail against.
    await c.query(
      `insert into compliance_records (carrier_id, subject_type, subject_id, anchor_key, occurred_on)
       values ($1,'driver',$2,'return_to_duty_test_date','2026-01-04')`,
      [carrier, driver],
    )
    const token = newProofToken()
    await c.query(
      `insert into driver_links (carrier_id, driver_id, token_hash, asks, expires_at)
       values ($1,$2,$3,$4,now() + interval '3 days')`,
      [carrier, driver, await hashProofToken(token), asks],
    )
    return { carrier, driver, token, user }
  }

  test('the view shows a first name and never the return-to-duty date', async () => {
    await withRollback(async (c) => {
      const { token } = await carrierWithLink(c, 'rtd', '9100001', ['medical'])
      await actAsAnon(c)
      const { rows } = await c.query('select * from driver_link_view($1)', [token])
      assert.equal(rows.length, 1)
      assert.equal(rows[0].first_name, 'rtd')
      assert.deepEqual(rows[0].asks, ['medical'])
      // The whole row, serialised, must not mention it anywhere.
      assert.doesNotMatch(JSON.stringify(rows[0]), /return_to_duty|2026-01-04/)
    })
  })

  test('the database refuses to store an ask outside the six', async () => {
    await withRollback(async (c) => {
      const { carrier, driver } = await carrierWithLink(c, 'bad', '9100002', ['medical'])
      await actAsOwner(c)
      const bad = c.query(
        `insert into driver_links (carrier_id, driver_id, token_hash, asks, expires_at)
         values ($1,$2,repeat('a',64),array['return_to_duty'],now() + interval '1 day')`,
        [carrier, driver],
      )
      await assert.rejects(bad, /driver_links_asks_known/)
    })
  })

  test('a dead link — expired, withdrawn or spent — answers nothing', async () => {
    await withRollback(async (c) => {
      const { token } = await carrierWithLink(c, 'dead', '9100003', ['medical'])
      await actAsOwner(c)
      await c.query(`update driver_links set revoked_at = now()`)
      await actAsAnon(c)
      const view = await c.query('select * from driver_link_view($1)', [token])
      assert.equal(view.rows.length, 0)
      const sent = await c.query(
        `select driver_link_submit($1,'{}'::jsonb,'{}'::text[],null) as id`,
        [token],
      )
      assert.equal(sent.rows[0].id, null, 'a withdrawn link must not write')
    })
  })

  test('a submission spends the link, and the second one writes nothing', async () => {
    await withRollback(async (c) => {
      const { token } = await carrierWithLink(c, 'once', '9100004', ['medical'])
      await actAsAnon(c)
      const first = await c.query(
        `select driver_link_submit($1,'{"medical":"2027-04-15"}'::jsonb,'{}'::text[],null) as id`,
        [token],
      )
      assert.ok(first.rows[0].id, 'the first submit lands')
      const second = await c.query(
        `select driver_link_submit($1,'{"medical":"2028-01-01"}'::jsonb,'{}'::text[],null) as id`,
        [token],
      )
      assert.equal(second.rows[0].id, null, 'single use')
      await actAsOwner(c)
      // Scoped to THIS link. An unscoped count also picks up rows a person left
      // behind on the dev database, which is a test that fails for a reason
      // that has nothing to do with the code.
      const { rows } = await c.query(
        `select count(*)::int as n from driver_submissions s
           join driver_links l on l.id = s.driver_link_id
          where l.token_hash = share_token_hash($1)`,
        [token],
      )
      assert.equal(rows[0].n, 1, 'one link, one submission, however many times he taps')
    })
  })

  test('a payload key the link never asked for is dropped, not stored', async () => {
    await withRollback(async (c) => {
      const { token } = await carrierWithLink(c, 'narrow', '9100005', ['medical'])
      await actAsAnon(c)
      await c.query(
        `select driver_link_submit($1,'{"medical":"2027-04-15","cdl":"2030-01-01","ssn":"x"}'::jsonb,'{}'::text[],null)`,
        [token],
      )
      await actAsOwner(c)
      const { rows } = await c.query('select payload from driver_submissions')
      assert.deepEqual(rows[0].payload, { medical: '2027-04-15' })
    })
  })

  test('anon cannot read the tables behind the functions', async () => {
    // The functions are the ONLY door. If this ever passes, a revoke has been
    // undone and the whole argument collapses.
    await withRollback(async (c) => {
      await carrierWithLink(c, 'closed', '9100006', ['medical'])
      await actAsAnon(c)
      for (const t of ['driver_links', 'driver_submissions', 'drivers', 'compliance_records']) {
        const n = await c
          .query(`select count(*)::int as n from ${t}`)
          .then((r) => r.rows[0].n)
          .catch(() => -1)
        assert.equal(n, -1, `anon can read ${t} directly`)
      }
    })
  })

  test('a signed-in user cannot fabricate a submission', async () => {
    // No INSERT grant. Otherwise somebody could write "the driver sent this",
    // accept it, and put source = 'driver' on a record no driver touched.
    await withRollback(async (c) => {
      const { carrier, driver, user } = await carrierWithLink(c, 'forge', '9100007', ['medical'])
      await actAs(c, user)
      const forged = c.query(
        `insert into driver_submissions (carrier_id, driver_link_id, driver_id)
         select $1, id, $2 from driver_links limit 1`,
        [carrier, driver],
      )
      await assert.rejects(forged, /permission denied|denied for table/i)
    })
  })
})
