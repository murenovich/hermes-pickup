// Tests for desktop/plugin.js, run against a FIXTURE: real React + a stub SDK in headless Chromium.
// This is not a live Hermes Desktop: SDK behaviour comes from a stub, so check real-app behaviour by hand.
//   node --test desktop/test/pickup.test.mjs --modules=/path/to/node_modules
// (or PICKUP_HARNESS_MODULES). The folder must contain react, react-dom, esbuild and playwright.
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { buildHarness, modulesDir } from './build.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const shots = join(here, '.build')
let browser
let page
let state
let problems

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const clone = value => JSON.parse(JSON.stringify(value))

function newState() {
  return {
    profile: 'alpha',
    calls: [],
    gate: null,
    refreshOutcome: null,
    externalRefreshing: false,
    byProfile: {
      alpha: {
        consented: false,
        settings: { ...defaults(), exclude: ['health', 'finance'], exclude_profiles: ['gamma'], skip_sessions: ['s-hidden'] },
        cards: []
      },
      beta: {
        consented: true,
        settings: { ...defaults(), exclude: ['beta-word'] },
        cards: [card('Beta card', 'sb', 'beta')]
      }
    },
    available: ['alpha', 'beta', 'gamma']
  }
}

// What GET /status returns for an untouched profile: every settings field, as the real backend does.
function defaults() {
  return {
    max_cards: 5,
    chats_per_profile: 3,
    max_chats: 20,
    chat_window_days: 3,
    project_window_days: 7,
    file_window_days: 3,
    project_roots: [],
    exclude: [],
    exclude_profiles: [],
    skip_sessions: [],
    include_files: true
  }
}

function card(title, ref, chatProfile, extra = {}) {
  return {
    title,
    summary: `You were working on ${title}.`,
    stopped: 'Paused before the review.',
    next: { label: 'Add pricing', prompt: `Continue ${title}: add the pricing section.` },
    items: [
      { kind: 'chat', ref, label: `${title} chat`, ...(chatProfile ? { profile: chatProfile, source: 'telegram' } : {}) },
      { kind: 'project', ref: '/work/site', label: 'site' }
    ],
    ...extra
  }
}

// Plays the backend. It answers for the profile that is current when the request is made, like the real
// profile-scoped REST door, so a response that arrives after a switch is genuinely the old profile's.
async function backend(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase()
  const mine = state.byProfile[state.profile]

  state.calls.push({ method, path, body: opts.body, profile: state.profile, timeoutMs: opts.timeoutMs })

  if (method === 'GET' && path === '/status') {
    if (state.statusError) {
      throw state.statusError
    }

    return {
      consent: { given: mine.consented, at: mine.consented ? 1 : null },
      last_run: null,
      counts: null,
      refreshing: state.externalRefreshing,
      settings: clone(mine.settings),
      available_profiles: state.available,
      state_error: false
    }
  }

  if (method === 'POST' && path === '/consent') {
    mine.consented = true

    return { consent: { given: true, at: 1 } }
  }

  if (method === 'GET' && path === '/profiles') {
    if (state.profilesError) {
      throw state.profilesError
    }

    return { profiles: state.available.map(name => ({ name, excluded: mine.settings.exclude_profiles.includes(name), has_session_store: true })) }
  }

  if (method === 'PUT' && path === '/settings') {
    const rejected = state.putReject && state.putReject(opts.body)

    if (rejected) {
      throw rejected
    }

    Object.assign(mine.settings, opts.body)

    return { settings: clone(mine.settings), defaults: {}, available_profiles: state.available }
  }

  if (method === 'GET' && path === '/cards') {
    return { cards: clone(mine.cards), made_at: mine.cards.length ? 1791388919 : null, counts: null }
  }

  if (method === 'POST' && path === '/refresh') {
    if (state.gate) {
      await state.gate
    }

    const outcome = state.refreshOutcome

    if (outcome instanceof Error) {
      throw outcome
    }

    mine.cards = clone(outcome)

    return { cards: clone(mine.cards), made_at: 1791388919, counts: { chats: 3, projects: 1, files: 0, profiles: ['alpha'], source_errors: 0 } }
  }

  throw new Error(`unexpected ${method} ${path}`)
}

before(async () => {
  const require = createRequire(join(modulesDir(), 'noop.js'))
  const { chromium } = await import(pathToFileURL(require.resolve('playwright')).href).then(m => m.default || m)
  const html = await buildHarness()

  mkdirSync(shots, { recursive: true })
  // Playwright may want a newer Chromium than the one cached; --chrome=/path/to/chrome overrides.
  const chrome = process.env.PICKUP_HARNESS_CHROME || process.argv.find(a => a.startsWith('--chrome='))?.slice(9)

  browser = await chromium.launch({ executablePath: chrome || undefined })
  page = await browser.newPage({ viewport: { width: 1200, height: 900 } })
  problems = []
  page.on('pageerror', err => problems.push(`pageerror: ${err.message}`))
  page.on('console', msg => msg.type() === 'error' && problems.push(`console.error: ${msg.text()}`))
  await page.exposeFunction('__backend', (path, opts) => backend(path, opts))
  globalThis.__html = html
})

after(async () => {
  await browser?.close()
})

async function load(initial) {
  state = newState()
  Object.assign(state, initial)
  state.profile = initial?.profile || 'alpha'
  await page.goto(pathToFileURL(globalThis.__html).href)
  await page.evaluate(() => {
    window.__fixture.rest = (path, opts) => window.__backend(path, opts)
  })
}

const text = () => page.locator('body').innerText()
const switchProfile = async name => {
  state.profile = name
  await page.evaluate(n => window.__setProfile(n), name)
}

// ---------------------------------------------------------------------------------------------
// Defect guarded: the page is the product. If consent copy lies, settings can't be reviewed first, a failed
// refresh wipes the cards, or cards overflow on a narrow window, the user is misled or loses their work.
test('first run, settings review, refresh/error/empty states and responsive layout', async () => {
  problems.length = 0
  await load()

  await page.getByRole('heading', { name: 'Turn on Pick up?' }).waitFor()
  const consent = await page.getByRole('region', { name: 'Turn on Pick up?' }).innerText()

  assert.match(consent, /sent to your own model provider/)
  assert.match(consent, /Recent chat excerpts.*titles, user messages, the last reply and unfinished steps/)
  assert.match(consent, /chat metadata: profile and source labels, timestamps, message counts, interrupted or stopped status, and associated projects/)
  assert.match(consent, /Project and file names and paths, plus when they were changed or opened/)
  assert.match(consent, /Git branch and status information/)
  assert.match(consent, /changed file names and paths/)
  assert.match(consent, /recent commit messages \(subjects\), dates and whether a commit was made by an agent/)
  assert.match(consent, /never reads document or file contents/)
  assert.match(consent, /does not change, move or delete any of your files/)
  assert.match(consent, /does save its own settings and the last cards/)
  assert.match(consent, /bigger request to your model: more tokens and a few more seconds/)
  assert.match(consent, /Skipped profiles are not read at all/)
  assert.equal(state.calls.filter(c => c.path === '/cards' || c.path === '/refresh').length, 0, 'nothing is fetched or sent before consent')
  await page.setViewportSize({ width: 360, height: 900 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 360), 'complete consent disclosure does not overflow a narrow window')
  await page.screenshot({ path: join(shots, 'consent-360.png'), fullPage: true })
  await page.setViewportSize({ width: 1200, height: 900 })

  // Settings can be reviewed and saved before consent. Only changed fields are sent.
  await page.getByRole('button', { name: 'Review settings first' }).click()
  await page.getByRole('checkbox', { name: 'gamma' }).waitFor()
  assert.equal(await page.getByRole('checkbox').count(), 3, 'one row per profile from GET /profiles')
  assert.equal(await page.getByRole('checkbox', { name: 'gamma' }).isChecked(), false, 'the saved skip shows as unticked')
  await page.getByLabel('Leave out').fill('health\nfinance\n/work/private')
  await page.getByRole('switch', { name: /recently changed files/ }).click()
  await page.getByRole('button', { name: 'Save' }).click()
  await page.getByText(/^Saved\./).waitFor()

  const put = state.calls.find(c => c.method === 'PUT')

  assert.deepEqual(put.body, { exclude: ['health', 'finance', '/work/private'], include_files: false })
  assert.deepEqual(state.byProfile.alpha.settings.exclude_profiles, ['gamma'], 'hidden backend exclude_profiles is retained')
  assert.match(consent, /across all your profiles/)
  assert.doesNotMatch(consent, /profiles matching/)

  await page.getByRole('button', { name: 'Cards' }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('switch', { name: /recently changed files/ }).click()
  await page.getByRole('button', { name: 'Save' }).click()
  await page.getByText(/^Saved\./).waitFor()
  assert.deepEqual(state.calls.filter(c => c.method === 'PUT')[1].body, { include_files: true }, 'a save sends only what changed')
  assert.equal(state.calls.filter(c => ['/consent', '/cards', '/refresh'].includes(c.path)).length, 0, 'reviewing and saving settings does not grant consent or fetch cards')
  await page.getByRole('button', { name: 'Cards' }).click()

  // Turn on: POST /consent then the first refresh, which is slow. The button shows busy while it runs.
  const longLabel = 'A very long chat title that must stay on one line ' + 'x'.repeat(80)
  const longNext = 'Add the pricing section with three tiers and a long unbroken ' + 'y'.repeat(70)
  const first = card('Landing page', 's1', 'alpha', {
    next: { label: longNext, prompt: 'Continue.' },
    items: [{ kind: 'chat', ref: 's1', label: longLabel, profile: 'alpha', source: 'telegram' }, { kind: 'project', ref: '/work/site', label: 'site' }]
  })
  const four = [first, card('Wiki run', 's2', 'beta'), card('Third thing', 's3', 'alpha'), card('Fourth thing', 's4', 'alpha')]
  let release
  state.gate = new Promise(resolve => (release = resolve))
  state.refreshOutcome = four
  await page.getByRole('button', { name: 'Turn on' }).click()
  await page.getByRole('button', { name: 'Refresh' }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Refresh' }).isDisabled(), true, 'refresh disabled while running')
  assert.ok(await page.getByTestId('spinner').count(), 'spinner while running')
  assert.deepEqual(state.calls.find(c => c.path === '/consent').body, { accepted: true })
  assert.deepEqual(state.calls.filter(c => c.path === '/consent' || c.path === '/refresh').map(c => c.path), ['/consent', '/refresh'], 'explicit consent precedes the first refresh')
  assert.ok(state.calls.find(c => c.path === '/refresh').timeoutMs >= 60000, 'refresh gets an ample timeout')
  release()
  await page.locator('article').first().waitFor()

  assert.equal(await page.locator('article').count(), 4, 'every returned card is shown (the ceiling is now 10, set by the card-count setting)')
  const body = await text()

  assert.equal((body.match(/Most worth resuming/gi) || []).length, 1) // innerText applies the uppercase eyebrow style
  assert.equal((body.match(/Also open/gi) || []).length, 3)
  assert.match(body, /Telegram chat · alpha/, 'chat chip first line: source and owning profile')
  assert.match(body, /Project · site/, 'path chip shows kind and name only')
  assert.equal(await page.locator('article button[title^="Open chat"] span[title]').first().getAttribute('title'), longLabel, 'full chat title on hover')
  assert.equal(await page.getByRole('button', { name: 'Continue' }).count(), 4, 'Continue label unchanged')
  assert.match(body, /Updated /)

  // Responsive: two columns when wide, one column when narrow (real layout in Chromium).
  const boxes = async () => page.locator('article').evaluateAll(els => els.map(el => el.getBoundingClientRect().toJSON()))
  let [a, b, c] = await boxes()

  assert.ok(Math.abs(a.top - b.top) < 2 && b.left > a.left + 100, 'wide: first two cards share a row')
  assert.ok(c.top > a.bottom - 1, 'wide: third card wraps below')
  await page.screenshot({ path: join(shots, 'wide-1200.png'), fullPage: true })
  await page.setViewportSize({ width: 360, height: 900 })
  ;[a, b, c] = await boxes()
  assert.ok(Math.abs(a.left - b.left) < 2 && b.top >= a.bottom - 1 && c.top >= b.bottom - 1, 'narrow: single column')
  assert.ok(a.right <= 360, 'narrow: no horizontal overflow')
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 360), 'narrow: page does not scroll sideways')
  assert.equal(await page.locator('article button').evaluateAll(els => els.filter(el => { const card = el.closest('article').getBoundingClientRect(); const r = el.getBoundingClientRect(); return r.right > card.right + 0.5 }).length), 0, 'narrow: long chat label and next label stay inside every card')
  await page.screenshot({ path: join(shots, 'narrow-360.png'), fullPage: true })
  await page.setViewportSize({ width: 1200, height: 900 })

  // A failed refresh keeps the previous cards and shows the backend's message.
  state.gate = new Promise(resolve => (release = resolve))
  state.refreshOutcome = new Error('{"detail":"Model call failed: quota exceeded"}')
  await page.getByRole('button', { name: 'Refresh' }).click()
  assert.equal(await page.getByRole('button', { name: 'Refresh' }).isDisabled(), true)
  release()
  await page.getByText('Model call failed: quota exceeded').waitFor()
  assert.equal(await page.locator('article').count(), 4, 'previous cards preserved on error')

  // A refresh that finds nothing shows the empty state.
  state.gate = null
  state.refreshOutcome = []
  await page.getByRole('button', { name: 'Refresh' }).click()
  await page.getByText('Nothing to pick up').waitFor()
  assert.equal(await page.locator('article').count(), 0)

  // A refresh running elsewhere must not leave the spinner stuck: status is re-polled, and when it ends
  // the cards it wrote appear without a manual reload.
  assert.equal(await page.getByRole('button', { name: 'Settings', exact: true }).isDisabled(), false)
  state.externalRefreshing = true
  await page.reload()
  await page.evaluate(() => {
    window.__fixture.rest = (path, opts) => window.__backend(path, opts)
  })
  await page.getByRole('button', { name: 'Refresh' }).waitFor()
  await page.waitForFunction(() => document.querySelector('button[aria-label="Refresh"]')?.disabled === true)
  state.externalRefreshing = false
  state.byProfile.alpha.cards = [card('Finished elsewhere', 'se', 'alpha')]
  await page.getByRole('heading', { name: 'Finished elsewhere' }).waitFor({ timeout: 6000 })
  assert.equal(await page.getByRole('button', { name: 'Refresh' }).isDisabled(), false, 'busy state clears when the outside refresh ends')

  assert.deepEqual(problems, [], 'no page errors or React warnings')
})

// ---------------------------------------------------------------------------------------------
// Defect guarded: "Next step" acts as the user in the wrong place: submitting into another profile's chat or
// 'new', leaking old-profile cards or half-typed settings after a profile switch, or acting after the switch.
test('next-step routing is profile-safe and profile switches leave no stale cards or edits', async () => {
  problems.length = 0
  await load()
  state.byProfile.alpha.consented = true
  state.byProfile.alpha.cards = [
    card('Alpha card', 'sa', 'alpha'),
    card('Cross card', 'sx', 'beta'),
    card('Unknown card', 'su', null)
  ]
  await page.reload()
  await page.evaluate(() => {
    window.__fixture.rest = (path, opts) => window.__backend(path, opts)
  })
  await page.locator('article').first().waitFor()

  const calls = () => page.evaluate(() => window.__fixture.calls.map(c => c.slice()))
  const reset = () => page.evaluate(() => { window.__fixture.calls.length = 0; window.__fixture.toasts.length = 0; window.__fixture.clipboard.length = 0 })
  const next = title => page.locator('article', { hasText: title }).getByRole('button', { name: /Add pricing/ })
  const names = list => list.map(c => c[0])

  // Same profile + explicit owner: open the chat, then submit to that chat id only.
  await reset()
  await next('Alpha card').click()
  await page.waitForFunction(() => window.__fixture.calls.some(c => c[0] === 'submit'))
  let seen = await calls()

  assert.deepEqual(seen.filter(c => c[0] === 'openSession')[0].slice(1), ['sa', { intent: 'in-place', profile: 'alpha' }])
  assert.deepEqual(seen.filter(c => c[0] === 'submit').map(c => c[1]), ['sa'])
  assert.ok(!names(seen).includes('newChat'))

  // Chat owned by another profile, or with no stated profile: never submit; make a new draft instead.
  for (const title of ['Cross card', 'Unknown card']) {
    await reset()
    await next(title).click()
    await page.waitForFunction(() => window.__fixture.calls.some(c => c[0] === 'insertText'))
    seen = await calls()
    assert.ok(!names(seen).includes('submit'), `${title}: no submit`)
    assert.ok(!names(seen).includes('openSession'), `${title}: does not navigate into or swap to the other profile`)
    assert.deepEqual(seen.find(c => c[0] === 'newChat'), ['newChat'], `${title}: newChat() takes no profile argument`)
    assert.deepEqual(seen.find(c => c[0] === 'insertText').slice(1), ['new', `Continue ${title}: add the pricing section.`, { mode: 'block' }])
    assert.match(await page.evaluate(() => window.__fixture.toasts.at(-1).message), /Nothing was sent/)
  }

  // Composer never mounts: bounded retries, then a draft. Still nothing is ever submitted to 'new' or null.
  await reset()
  await page.evaluate(() => { window.__fixture.submitResult = () => false })
  await next('Alpha card').click()
  await page.waitForFunction(() => window.__fixture.calls.some(c => c[0] === 'insertText'), null, { timeout: 8000 })
  seen = await calls()
  assert.ok(seen.filter(c => c[0] === 'submit').length <= 20, 'submit retries are bounded')
  assert.ok(seen.filter(c => c[0] === 'submit').every(c => c[1] === 'sa'), 'only ever addressed to the card chat')
  await page.evaluate(() => { window.__fixture.submitResult = () => true })

  // Profile switch while a submit is still waiting for the composer: it must stop and not fall into a draft.
  await reset()
  await page.evaluate(() => { window.__fixture.submitResult = () => false })
  await next('Alpha card').click()
  await wait(350)
  await switchProfile('beta')
  await page.getByRole('heading', { name: 'Beta card' }).waitFor()
  const atSwitch = (await calls()).filter(c => c[0] === 'submit').length

  await wait(700)
  seen = await calls()
  assert.equal(seen.filter(c => c[0] === 'submit').length, atSwitch, 'no submit after the profile changed')
  assert.ok(!names(seen).includes('newChat') && !names(seen).includes('insertText'), 'no draft created after the switch')
  assert.equal(await page.getByRole('heading', { name: 'Alpha card' }).count(), 0, 'old profile cards are gone')

  // Settings edits made on one profile never appear on the next.
  await switchProfile('alpha')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByLabel('Leave out').fill('UNSAVED-EDIT')
  await switchProfile('beta')
  await page.getByRole('heading', { name: 'Beta card' }).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Cards' }).getAttribute('aria-pressed'), 'true', 'back on Cards after the switch')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  assert.equal(await page.getByLabel('Leave out').inputValue(), 'beta-word')
  await switchProfile('alpha')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  assert.equal(await page.getByLabel('Leave out').inputValue(), 'health\nfinance', 'unsaved edit did not survive')

  // Older host without openSession: Continue falls back to copying the chat title and id.
  await page.getByRole('button', { name: 'Cards' }).click()
  await reset()
  await page.evaluate(() => { window.__fixture.features.openSession = false })
  await page.locator('article', { hasText: 'Alpha card' }).getByRole('button', { name: 'Continue' }).click()
  await page.waitForFunction(() => window.__fixture.clipboard.length > 0)
  assert.deepEqual(await page.evaluate(() => window.__fixture.clipboard), ['Alpha card chat (sa)'])

  assert.deepEqual(problems, [], 'no page errors or React warnings')
})

// Defect guarded: Hermes bug 134712 (Desktop backend reads another profile's plugin list) shows up as a bare
// "Plugin not found". The page must name the bug and the fix; any other failure keeps the generic message.
test('Plugin not found explains the multi-profile Hermes bug and its fix', async () => {
  problems.length = 0
  await load({ statusError: new Error('404 {"detail":"Plugin not found"}') })
  await page.getByRole('heading', { name: /isn.t loading the Pick up service/ }).waitFor()
  const body = await text()
  assert.match(body, /issue 134712/)
  assert.match(body, /plugins\.enabled in every profile/)
  assert.match(body, /install\.sh again offers to do this/)
  await page.getByRole('button', { name: 'Copy issue link' }).click()
  await page.waitForFunction(() => window.__fixture.clipboard.length > 0)
  assert.deepEqual(await page.evaluate(() => window.__fixture.clipboard), ['https://github.com/NousResearch/hermes-agent/issues/134712'])

  await load({ statusError: new Error('connect ECONNREFUSED') })
  await page.getByRole('heading', { name: "Couldn't reach Pick up" }).waitFor()
  assert.doesNotMatch(await text(), /134712/)
  assert.deepEqual(problems, [], 'no page errors or React warnings')
})

// ---------------------------------------------------------------------------------------------
// v0.2 settings page. Shared by the three tests below.
const qa = join(here, '..', '..', 'qa', 'v02')
const statusCalls = () => state.calls.filter(c => c.path === '/status').length
const puts = () => state.calls.filter(c => c.method === 'PUT')
const reopen = async () => {
  await page.reload()
  await page.evaluate(() => {
    window.__fixture.rest = (path, opts) => window.__backend(path, opts)
  })
}
const openSettings = async () => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('checkbox', { name: 'gamma' }).waitFor()
}

// Defect guarded: the form saves what it holds instead of what the user changed, so a hidden backend field
// (skip_sessions) or an untouched value is overwritten; a skipped profile is lost or inverted; background status
// polling during a refresh replaces a half-typed draft; Discard keeps edits or snapshots the polled values.
// User impact: a profile they meant to keep private is read and sent to the model, or settings silently change.
// Gap: the older tests only covered the exclude list and one switch, with no profiles and no polling.
test('settings round trip: skipped profile, partial save, Discard, and polling does not clobber a draft', async () => {
  problems.length = 0
  mkdirSync(qa, { recursive: true })
  await load({ externalRefreshing: true })
  state.byProfile.alpha.consented = true
  await reopen()
  await openSettings()

  assert.equal(await page.getByLabel('Number of cards').inputValue(), '5')
  assert.equal(await page.getByLabel('Chats in total').inputValue(), '20')
  assert.equal(await page.getByRole('checkbox', { name: 'alpha' }).isChecked(), true, 'included by default')
  assert.equal(await page.getByRole('checkbox', { name: 'gamma' }).isChecked(), false, 'saved skip is shown unticked')
  assert.equal(await page.getByRole('button', { name: 'Save' }).isDisabled(), true, 'nothing to save yet')
  assert.match(await text(), /skipped profile is never read/)

  // A refresh is running elsewhere, so /status is polled. Settings changed outside must not touch the draft.
  await page.getByLabel('Leave out').fill('draft-word')
  await page.getByLabel('Number of cards').fill('8')
  state.byProfile.alpha.settings.max_cards = 9
  state.byProfile.alpha.settings.exclude = ['changed-elsewhere']
  const polls = statusCalls()
  while (statusCalls() < polls + 1) {
    await wait(200)
  }
  await wait(100)
  assert.equal(await page.getByLabel('Leave out').inputValue(), 'draft-word', 'polling did not replace the typed draft')
  assert.equal(await page.getByLabel('Number of cards').inputValue(), '8')
  await page.getByRole('button', { name: 'Discard' }).click()
  assert.equal(await page.getByLabel('Leave out').inputValue(), 'health\nfinance', 'Discard returns to what was open, not the polled values')
  assert.equal(await page.getByLabel('Number of cards').inputValue(), '5')
  assert.equal(await page.getByRole('button', { name: 'Discard' }).isDisabled(), true)
  state.externalRefreshing = false

  // Untick beta, tick gamma, change two numbers (one fractional): only those three fields are sent.
  state.byProfile.alpha.settings.max_cards = 5
  state.byProfile.alpha.settings.exclude = ['health', 'finance']
  await page.getByRole('checkbox', { name: 'beta' }).uncheck()
  await page.getByRole('checkbox', { name: 'gamma' }).check()
  await page.getByLabel('Number of cards').fill('7')
  await page.getByLabel('Chats: look back (days)').fill('0.5')
  const cardsBefore = state.calls.filter(c => c.path === '/cards').length
  await page.getByRole('button', { name: 'Save' }).click()
  await page.getByText(/^Saved\./).waitFor()

  assert.deepEqual(puts().map(c => c.body), [{ max_cards: 7, chat_window_days: 0.5, exclude_profiles: ['beta'] }], 'partial save: changed known fields only')
  assert.deepEqual(state.byProfile.alpha.settings.skip_sessions, ['s-hidden'], 'a field the form never shows is untouched')
  assert.equal(state.calls.filter(c => c.path === '/refresh').length, 0, 'saving does not refresh')
  assert.equal(state.calls.filter(c => c.path === '/cards').length, cardsBefore, 'saving does not re-fetch cards')
  assert.equal(await page.getByRole('checkbox', { name: 'beta' }).isChecked(), false)
  assert.equal(await page.getByRole('checkbox', { name: 'gamma' }).isChecked(), true)
  assert.equal(await page.getByRole('button', { name: 'Save' }).isDisabled(), true, 'saved state is the new baseline')

  await page.getByText(/Looking through your recent work/).waitFor({ state: 'detached', timeout: 6000 }) // the polled "refreshing elsewhere" banner clears
  await page.setViewportSize({ width: 360, height: 900 })
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= 360), 'settings fit a narrow window')
  await page.setViewportSize({ width: 1200, height: 1800 })
  await page.getByRole('heading', { name: 'Pick up where you left off' }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(qa, 'settings.png') })
  await page.setViewportSize({ width: 1200, height: 900 })
  assert.deepEqual(problems, [], 'no page errors or React warnings')
})

// Defect guarded: a backend 422 is shown as one generic banner, lands on the wrong field, or the form resets so the
// user retypes everything; or a field message sticks after the user fixes that field.
// User impact: they cannot tell which value was refused and may think a folder list was saved when it was not.
// Gap: no earlier test sends a rejected PUT; the refresh-error test only covers POST /refresh.
test('a backend 422 shows next to its field and keeps the draft', async () => {
  problems.length = 0
  await load()
  state.byProfile.alpha.consented = true
  state.putReject = body =>
    body.project_roots || body.chats_per_profile === 4
      ? new Error(
          '422 ' +
            JSON.stringify({
              detail: [
                ...(body.project_roots ? [{ field: 'project_roots.0', message: 'Value error, project roots must be absolute paths or start with ~/' }] : []),
                ...(body.chats_per_profile === 4 ? [{ field: 'chats_per_profile', message: 'Input should be less than or equal to 3' }] : [])
              ]
            })
        )
      : null
  await reopen()
  await openSettings()

  await page.getByLabel('Folders that hold your projects').fill('relative/path')
  await page.getByLabel('Chats per profile').fill('4')
  await page.getByRole('button', { name: 'Save' }).click()
  await page.locator('#pickup-project_roots-error').waitFor()

  const roots = await page.locator('#pickup-project_roots-error').innerText()

  assert.match(roots, /Entry 1: project roots must be absolute paths/)
  assert.doesNotMatch(roots, /Value error/)
  assert.match(await page.locator('#pickup-chats_per_profile-error').innerText(), /less than or equal to 3/)
  assert.equal(await page.locator('[id$="-error"]').count(), 2, 'only the two refused fields carry a message')
  assert.equal(await page.getByLabel('Folders that hold your projects').inputValue(), 'relative/path', 'draft kept as typed')
  assert.equal(await page.getByLabel('Chats per profile').inputValue(), '4')
  assert.deepEqual(state.byProfile.alpha.settings.project_roots, [], 'nothing was saved')
  assert.equal(await page.getByRole('button', { name: 'Save' }).isDisabled(), false, 'the user can fix and retry')
  assert.match(await text(), /Not saved\. Check the highlighted fields\./)
  assert.doesNotMatch(await text(), /^Saved\./m)

  // Fixing one field clears only its own message; the other stays until it is fixed or refused again.
  await page.getByLabel('Folders that hold your projects').fill('/abs/projects')
  assert.equal(await page.locator('#pickup-project_roots-error').count(), 0)
  assert.equal(await page.locator('#pickup-chats_per_profile-error').count(), 1)
  await page.getByLabel('Chats per profile').fill('3')
  state.putReject = null
  await page.getByRole('button', { name: 'Save' }).click()
  await page.getByText(/^Saved\./).waitFor()
  assert.deepEqual(puts().at(-1).body, { project_roots: ['/abs/projects'] }, 'retry sends only the field that still differs from the saved value')
  assert.deepEqual(state.byProfile.alpha.settings.project_roots, ['/abs/projects'])
  assert.deepEqual(problems, [], 'no page errors or React warnings')
})

// Defect guarded: the card grid only works for 2-4 cards: one card stretches or collapses, ten overflow or overlap
// on a narrow window, more than ten render, or eyebrows repeat "Most worth resuming".
// User impact: with the new 1-10 card setting the page looks broken at exactly the values people pick.
// Gap: the layout check in the first test uses four cards at two widths.
test('1, 7 and 10 cards lay out cleanly wide and narrow (7-card screenshot)', async () => {
  problems.length = 0
  mkdirSync(qa, { recursive: true })
  await load()
  state.byProfile.alpha.consented = true

  const many = n =>
    Array.from({ length: n }, (_, i) =>
      card(`Thread number ${i + 1} with a rather long title that has to wrap properly`, `s${i}`, i % 2 ? 'beta' : 'alpha', {
        stopped: 'Paused before the review: ' + 'details '.repeat(i % 3 ? 4 : 14)
      })
    )

  for (const [count, shownCount] of [[1, 1], [10, 10], [11, 10]]) {
    state.byProfile.alpha.cards = many(count)
    await reopen()
    await page.locator('article').first().waitFor()

    for (const width of [1200, 360]) {
      await page.setViewportSize({ width, height: 900 })
      const boxes = await page.locator('article').evaluateAll(els => els.map(el => el.getBoundingClientRect().toJSON()))
      const label = `${count} cards at ${width}px`

      assert.equal(boxes.length, shownCount, `${label}: shown`)
      assert.ok(boxes.every(b => b.left >= 0 && b.right <= width), `${label}: inside the window`)
      assert.ok(await page.evaluate(w => document.documentElement.scrollWidth <= w, width), `${label}: no sideways scroll`)

      for (let i = 1; i < boxes.length; i += 1) {
        const sameRow = Math.abs(boxes[i].top - boxes[i - 1].top) < 2

        assert.ok(sameRow || boxes[i].top >= boxes[i - 1].bottom - 1, `${label}: card ${i + 1} does not overlap the one before`)
      }

      if (width === 360) {
        assert.ok(boxes.every(b => Math.abs(b.left - boxes[0].left) < 2), `${label}: one column`)
      } else if (count === 1) {
        assert.ok(boxes[0].width > 300 && boxes[0].width < 600, `${label}: a single card keeps column width (${boxes[0].width})`)
      } else {
        assert.equal(new Set(boxes.map(b => Math.round(b.top))).size, 5, `${label}: two columns, five rows`)
      }
    }

    const body = await text()

    assert.equal((body.match(/Most worth resuming/gi) || []).length, 1)
    assert.equal((body.match(/Also open/gi) || []).length, shownCount - 1)
  }

  state.byProfile.alpha.cards = many(7)
  await reopen()
  await page.locator('article').first().waitFor()
  await page.setViewportSize({ width: 1200, height: 1750 })
  await page.screenshot({ path: join(qa, 'cards-7.png') })
  await page.setViewportSize({ width: 1200, height: 900 })
  assert.deepEqual(problems, [], 'no page errors or React warnings')
})
