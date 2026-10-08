// Hermes Pickup — desktop half. Plain ESM, no JSX, no build step.
// Imports are limited to the two specifiers a disk plugin may use: @hermes/plugin-sdk and react.
// Backend: /api/plugins/hermes-pickup/* (see README.md "API"). Theme variables only.
import {
  Button,
  Codicon,
  EmptyState,
  ErrorState,
  PALETTE_AREA,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  Skeleton,
  Switch,
  Textarea,
  host,
  useQuery,
  useQueryClient,
  useValue
} from '@hermes/plugin-sdk'
import { createElement, useEffect, useRef, useState } from 'react'

// A disk plugin may not import react/jsx-runtime, so these two mirror its contract on createElement:
// the key is the third argument; jsx passes children as one argument (React key-checks an array there), jsxs
// spreads a static children array into arguments (no key check, like the real runtime). One difference:
// a one-element static array reaches the component as that element, not as an array.
function build(type, props, key, staticChildren) {
  const { children, ...rest } = props || {}

  if (key !== undefined) {
    rest.key = key
  }

  if (children === undefined) {
    return createElement(type, rest)
  }

  return staticChildren && Array.isArray(children) ? createElement(type, rest, ...children) : createElement(type, rest, children)
}

const jsx = (type, props, key) => build(type, props, key, false)
const jsxs = (type, props, key) => build(type, props, key, true)

const PLUGIN_ID = 'hermes-pickup'
const ROUTE = '/pickup'
// The most cards the backend can be set to; the page never shows more than this.
const MAX_CARDS = 10
// Refresh makes a model call (~20 s typical). The REST door defaults to 30 s.
const REFRESH_TIMEOUT_MS = 180000
// Bounded waits for a freshly opened/created composer to mount. Not data polling:
// each attempt is a fail-closed SDK verb that has no side effect when it returns false.
const SUBMIT_TRIES = 20
const SUBMIT_GAP_MS = 100
const DRAFT_TRIES = 25
const DRAFT_GAP_MS = 100
const MAX_LIST = 100
const MAX_ENTRY_CHARS = 500
const STATUS_POLL_MS = 2000

// Set by register(); every REST/OS call goes through it.
let ctx = null
// Bumped by each next-step action (and on dispose) so an older, slower action never acts late.
let actionSeq = 0
// profile -> in-flight refresh promise. Survives the page remounting on a profile switch.
const refreshing = new Map()

// ---- small helpers ---------------------------------------------------------------------------

const key = (profile, name) => [PLUGIN_ID, profile, name]
const isFn = value => typeof value === 'function'
const currentProfile = () => String(host.state.profile.get() ?? '')
const sleep = ms => new Promise(resolve => ctx.setTimeout(resolve, ms))

function errorText(err) {
  let message = err && (err.detail || err.message)

  if (message && typeof message !== 'string') {
    message = JSON.stringify(message)
  }

  message = message || String(err || 'Something went wrong')
  const brace = message.indexOf('{')

  if (brace >= 0) {
    try {
      const detail = JSON.parse(message.slice(brace)).detail

      if (typeof detail === 'string') {
        return detail
      }

      if (Array.isArray(detail)) {
        return detail.map(d => (d && d.field ? `${d.field}: ${d.message}` : (d && d.message) || String(d))).join('; ')
      }
    } catch {
      // not JSON; keep the raw text
    }
  }

  return message
}

// Hermes bug issue 134712: the Desktop backend can drift to another profile's config after startup and then
// answer "Plugin not found" for a plugin enabled only in the default profile. Recognise that answer so the
// page can explain the fix instead of showing a bare error.
const PROFILE_DRIFT_ISSUE = 'https://github.com/NousResearch/hermes-agent/issues/134712'

function isPluginNotFound(err) {
  return /plugin not found/i.test(errorText(err))
}

function toast(kind, message) {
  try {
    host.notify({ kind, message })
  } catch {
    // a toast must never break an action
  }
}

async function copyText(text) {
  try {
    return isFn(ctx.os && ctx.os.writeClipboard) && (await ctx.os.writeClipboard(text)) === true
  } catch {
    return false
  }
}

function formatUpdated(seconds) {
  if (!(seconds > 0)) {
    return null
  }

  const when = new Date(seconds * 1000)
  const time = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

  return when.toDateString() === new Date().toDateString()
    ? time
    : `${when.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`
}

function useAlive() {
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true

    return () => {
      alive.current = false
    }
  }, [])

  return alive
}

// A response is only trusted if the profile it was requested for is still the one on screen.
async function fetchScoped(profile, path) {
  if (currentProfile() !== profile) {
    throw new Error('The profile changed before loading. Reopen Pick up to try again.')
  }

  const data = await ctx.rest(path)

  if (currentProfile() !== profile) {
    throw new Error('The profile changed while loading. Reopen Pick up to try again.')
  }

  return data
}

const firstChat = card => (card.items || []).find(item => item && item.kind === 'chat' && item.ref)

// ---- actions ---------------------------------------------------------------------------------

async function openChat(item, pageProfile) {
  if (currentProfile() !== pageProfile) {
    toast('warning', 'The profile changed. Refresh Pick up before continuing.')

    return
  }

  if (isFn(host.openSession)) {
    try {
      const options = { intent: 'in-place' }

      if (item.profile) {
        options.profile = item.profile
      }

      await host.openSession(item.ref, options)

      return
    } catch (err) {
      toast('warning', `Couldn't open that chat directly (${errorText(err)}).`)
    }
  }

  const copied = await copyText(`${item.label || 'Chat'} (${item.ref})`)

  toast(
    copied ? 'info' : 'error',
    copied
      ? `Chat title and id copied. Find it in your sessions list${item.profile ? ` under profile "${item.profile}"` : ''}.`
      : `Couldn't open or copy this chat. Its id is ${item.ref}.`
  )
}

async function copyPath(item) {
  const copied = await copyText(item.ref)

  toast(copied ? 'info' : 'error', copied ? 'Path copied to the clipboard.' : `Couldn't copy. The path is ${item.ref}`)
}

async function runContinue(card, pageProfile) {
  const chat = firstChat(card)

  if (chat) {
    return openChat(chat, pageProfile)
  }

  const place = (card.items || []).find(item => item && item.ref)

  if (place) {
    return copyPath(place)
  }

  toast('warning', 'This card has nothing to open.')
}

async function fallbackToClipboard(prompt, message) {
  const copied = await copyText(prompt)

  toast(
    copied ? 'warning' : 'error',
    copied ? `${message} The suggested prompt is on your clipboard.` : `${message} The prompt could not be copied.`
  )
}

// Never submits. Opens a NEW draft in the profile that is current right now and appends the prompt
// ('block' mode), so no existing draft is overwritten. The user reads it and presses send.
async function draftInNewChat(prompt, pageProfile, token, reason) {
  if (!isFn(host.newChat) || !host.composer || !isFn(host.composer.insertText)) {
    return fallbackToClipboard(prompt, "This version of Hermes Desktop can't create a draft here.")
  }

  const profileAtStart = currentProfile()

  if (profileAtStart !== pageProfile) {
    toast('warning', 'The profile changed. Refresh Pick up before using this step.')

    return
  }

  try {
    host.newChat()
  } catch (err) {
    return fallbackToClipboard(prompt, `Couldn't start a new chat (${errorText(err)}).`)
  }

  const probe = prompt.slice(0, 80)

  for (let attempt = 0; attempt < DRAFT_TRIES; attempt += 1) {
    if (token !== actionSeq) {
      return
    }

    if (currentProfile() !== profileAtStart) {
      break
    }

    let placed = false

    try {
      placed = (await host.composer.insertText('new', prompt, { mode: 'block' })) === true

      if (!placed && isFn(host.composer.getDraft)) {
        // The acknowledgement window is short; a late-claimed insert must not be inserted twice.
        const draft = await host.composer.getDraft('new')

        placed = typeof draft === 'string' && draft.includes(probe)
      }
    } catch {
      placed = false
    }

    if (placed) {
      toast('info', `${reason} A new draft is ready: read it and press send yourself. Nothing was sent.`)

      return
    }

    await sleep(DRAFT_GAP_MS)
  }

  if (token === actionSeq) {
    await fallbackToClipboard(prompt, "Couldn't reach the new chat's input in time.")
  }
}

async function runNextStep(card, pageProfile) {
  const prompt = card.next && typeof card.next.prompt === 'string' ? card.next.prompt.trim() : ''

  if (!prompt) {
    toast('warning', 'This card has no suggested next step.')

    return
  }

  const token = (actionSeq += 1)
  const chat = firstChat(card)
  const sessionId = chat ? String(chat.ref).trim() : ''
  const owner = chat && typeof chat.profile === 'string' ? chat.profile.trim() : ''

  if (currentProfile() !== pageProfile) {
    toast('warning', 'The profile changed. Refresh Pick up before using this step.')

    return
  }

  // Send into the card's own chat only when we positively know it belongs to the profile that is
  // current right now. Anything else (no profile, other profile, old host) becomes a draft.
  const canSend =
    sessionId &&
    sessionId !== 'new' &&
    owner &&
    owner === currentProfile() &&
    isFn(host.openSession) &&
    host.composer &&
    isFn(host.composer.submit)

  if (!canSend) {
    const why = !chat
      ? 'This step has no chat to continue in.'
      : owner && owner !== currentProfile()
        ? `That chat belongs to profile "${owner}", not the current one.`
        : "Couldn't confirm which profile that chat belongs to."

    return draftInNewChat(prompt, pageProfile, token, why)
  }

  try {
    await host.openSession(sessionId, { intent: 'in-place', profile: owner })
  } catch {
    // submit() below is still fail-closed on the session id, so a failed open can only fall through
  }

  for (let attempt = 0; attempt < SUBMIT_TRIES; attempt += 1) {
    if (token !== actionSeq) {
      return
    }

    // Re-check immediately before the synchronous submit; the profile can change while we wait.
    if (currentProfile() !== owner || currentProfile() !== pageProfile) {
      break
    }

    let sent = false

    try {
      sent = host.composer.submit(sessionId, prompt) === true
    } catch {
      sent = false
    }

    if (sent) {
      toast('success', `Sent "${card.next.label || 'next step'}" to the chat.`)

      return
    }

    await sleep(SUBMIT_GAP_MS)
  }

  if (token === actionSeq) {
    return draftInNewChat(prompt, pageProfile, token, "Couldn't send into that chat safely.")
  }
}

function startRefresh(profile, queryClient) {
  const existing = refreshing.get(profile)

  if (existing) {
    return existing
  }

  const run = (async () => {
    const result = await ctx.rest('/refresh', { method: 'POST', timeoutMs: REFRESH_TIMEOUT_MS })

    // Written under the profile the request was made for, even if the page has since moved on.
    queryClient.setQueryData(key(profile, 'cards'), result)
    queryClient.invalidateQueries({ queryKey: key(profile, 'status') })

    return result
  })()

  const tracked = run.finally(() => {
    refreshing.delete(profile)
  })

  refreshing.set(profile, tracked)

  return tracked
}

// ---- pieces ----------------------------------------------------------------------------------

const S = {
  page: { height: '100%', overflowY: 'auto', padding: 'clamp(1rem, 4vw, 2.5rem)', color: 'var(--ui-text-primary)' },
  inner: { maxWidth: '62rem', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: '1.25rem' },
  header: { display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: '0.75rem 1.5rem' },
  h1: { margin: 0, fontSize: '1.375rem', fontWeight: 600, color: 'var(--ui-text-primary)' },
  sub: { margin: '0.25rem 0 0', fontSize: '0.8125rem', color: 'var(--ui-text-tertiary)' },
  tools: { display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.75rem', color: 'var(--ui-text-tertiary)' },
  // auto-fill keeps one card at column width instead of stretching it across the page; min(100%, …) gives
  // a single full-width column on narrow windows.
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 24rem), 1fr))', gap: '1rem' },
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.625rem',
    minWidth: 0,
    padding: '1.125rem',
    border: '1px solid var(--ui-stroke-secondary)',
    borderRadius: '0.75rem',
    background: 'color-mix(in srgb, var(--ui-bg-quaternary) 45%, transparent)'
  },
  eyebrow: { fontSize: '0.6875rem', letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--ui-accent)' },
  title: { margin: 0, fontSize: '1.0625rem', fontWeight: 600, overflowWrap: 'anywhere' },
  summary: { margin: 0, fontSize: '0.8125rem', lineHeight: 1.5, color: 'var(--ui-text-secondary)', overflowWrap: 'anywhere' },
  stopped: {
    margin: 0,
    paddingLeft: '0.625rem',
    borderLeft: '2px solid var(--ui-stroke-secondary)',
    fontSize: '0.8125rem',
    lineHeight: 1.5,
    color: 'var(--ui-text-tertiary)',
    overflowWrap: 'anywhere'
  },
  chips: { display: 'flex', flexWrap: 'wrap', gap: '0.375rem', minWidth: 0 },
  chip: { maxWidth: '100%', minWidth: 0, height: 'auto', whiteSpace: 'normal', textAlign: 'left', paddingTop: '0.25rem', paddingBottom: '0.25rem' },
  chipText: { display: 'flex', flexDirection: 'column', minWidth: 0, maxWidth: '18rem', textAlign: 'left' },
  chipHead: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  chipSub: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '0.6875rem', color: 'var(--ui-text-tertiary)' },
  next: { maxWidth: '100%', minWidth: 0, whiteSpace: 'normal', height: 'auto', overflowWrap: 'anywhere', textAlign: 'left' },
  actions: { display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginTop: '0.25rem', minWidth: 0 },
  banner: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '0.5rem',
    padding: '0.625rem 0.75rem',
    border: '1px solid var(--ui-stroke-secondary)',
    borderRadius: '0.5rem',
    fontSize: '0.8125rem',
    color: 'var(--ui-text-secondary)',
    overflowWrap: 'anywhere'
  },
  panel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.875rem',
    maxWidth: '40rem',
    padding: '1.25rem',
    border: '1px solid var(--ui-stroke-secondary)',
    borderRadius: '0.75rem'
  },
  list: { margin: 0, paddingLeft: '1.125rem', display: 'flex', flexDirection: 'column', gap: '0.375rem', fontSize: '0.8125rem', lineHeight: 1.5, color: 'var(--ui-text-secondary)' },
  field: { display: 'flex', flexDirection: 'column', gap: '0.375rem' },
  label: { fontSize: '0.8125rem', fontWeight: 500, color: 'var(--ui-text-primary)' },
  hint: { margin: 0, fontSize: '0.75rem', lineHeight: 1.45, color: 'var(--ui-text-tertiary)' },
  row: { display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8125rem' },
  tabs: { display: 'flex', gap: '0.375rem' },
  settings: { display: 'flex', flexDirection: 'column', gap: '1rem', maxWidth: '40rem', minWidth: 0 },
  numbers: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 12rem), 1fr))', gap: '0.875rem' },
  input: {
    boxSizing: 'border-box',
    width: '100%',
    padding: '0.375rem 0.5rem',
    font: 'inherit',
    color: 'var(--ui-text-primary)',
    background: 'transparent',
    // Longhands, so the invalid state can swap only the colour without React's shorthand-conflict warning.
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'var(--ui-stroke-secondary)',
    borderRadius: '0.375rem'
  },
  inputBad: { borderColor: 'var(--ui-accent)' },
  fieldError: { margin: 0, fontSize: '0.75rem', lineHeight: 1.45, color: 'var(--ui-accent)', overflowWrap: 'anywhere' },
  check: { display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.8125rem', overflowWrap: 'anywhere' },
  checks: { display: 'flex', flexDirection: 'column', gap: '0.375rem' },
  checkbox: { accentColor: 'var(--ui-accent)', margin: 0 }
}

function Notice({ tone, children, onDismiss }) {
  return jsxs('div', {
    role: tone === 'error' ? 'alert' : 'status',
    style: S.banner,
    children: [
      jsx(Codicon, {
        name: tone === 'error' ? 'error' : 'info',
        style: { color: tone === 'error' ? 'var(--ui-accent)' : 'var(--ui-text-tertiary)' }
      }),
      jsx('div', { style: { flex: 1, minWidth: 0 }, children }),
      onDismiss
        ? jsx(Button, { size: 'xs', variant: 'ghost', onClick: onDismiss, 'aria-label': 'Dismiss', children: 'Dismiss' })
        : null
    ]
  })
}

const KIND_ICON = { chat: 'comment-discussion', project: 'repo', folder: 'folder', file: 'file' }

const capitalize = text => text.charAt(0).toUpperCase() + text.slice(1)

// "Telegram chat · alpha": the source (a known string, never a path) and the owning profile.
function chipHead(item) {
  if (item.kind !== 'chat') {
    return capitalize(item.kind || 'file')
  }

  const source = typeof item.source === 'string' ? item.source.trim() : ''
  const name = !source ? 'Chat' : /chat$/i.test(source) ? capitalize(source) : `${capitalize(source)} chat`

  return [name, item.profile].filter(Boolean).join(' · ')
}

function ItemChip({ item, onOpen }) {
  const isChat = item.kind === 'chat'
  const label = item.label || item.ref || 'Untitled'
  const head = isChat ? chipHead(item) : `${chipHead(item)} · ${label}`

  return jsxs(Button, {
    size: 'xs',
    variant: 'chip',
    onClick: onOpen,
    style: S.chip,
    title: isChat ? `Open chat: ${label}` : `Copy path: ${item.ref}`,
    children: [
      jsx(Codicon, { name: KIND_ICON[item.kind] || 'file' }),
      jsxs('span', {
        style: S.chipText,
        children: [
          jsx('span', { style: S.chipHead, children: head }),
          isChat ? jsx('span', { style: S.chipSub, title: label, children: label }) : null
        ]
      })
    ]
  })
}

function PickupCard({ card, rank, profile }) {
  const alive = useAlive()
  const [busy, setBusy] = useState(null)
  const items = Array.isArray(card.items) ? card.items : []
  const chat = firstChat(card)
  const next = card.next && card.next.prompt ? card.next : null

  const act = async (kind, fn) => {
    if (busy) {
      return
    }

    setBusy(kind)

    try {
      await fn()
    } finally {
      if (alive.current) {
        setBusy(null)
      }
    }
  }

  return jsxs('article', {
    style: S.card,
    'aria-label': card.title,
    children: [
      jsx('div', { style: S.eyebrow, children: rank === 0 ? 'Most worth resuming' : 'Also open' }),
      jsx('h2', { style: S.title, children: card.title }),
      card.summary ? jsx('p', { style: S.summary, children: card.summary }) : null,
      card.stopped
        ? jsxs('p', {
            style: S.stopped,
            children: [jsx('strong', { style: { fontWeight: 500, color: 'var(--ui-text-primary)' }, children: 'Stopped: ' }), card.stopped]
          })
        : null,
      items.length
        ? jsx('div', {
            style: S.chips,
            children: items.map((item, index) =>
              jsx(
                ItemChip,
                {
                  item,
                  onOpen: () => act('chip', () => (item.kind === 'chat' ? openChat(item, profile) : copyPath(item)))
                },
                `${item.kind}:${item.ref}:${index}`
              )
            )
          })
        : null,
      jsxs('div', {
        style: S.actions,
        children: [
          jsx(Button, {
            size: 'sm',
            variant: 'outline',
            disabled: Boolean(busy) || !items.length,
            loading: busy === 'continue',
            onClick: () => act('continue', () => runContinue(card, profile)),
            title: chat ? 'Open this chat' : 'Copies the path to the clipboard',
            children: 'Continue'
          }),
          next
            ? jsx(Button, {
                size: 'sm',
                style: S.next,
                disabled: Boolean(busy),
                loading: busy === 'next',
                title: next.prompt.length > 400 ? `${next.prompt.slice(0, 400)}…` : next.prompt,
                onClick: () => act('next', () => runNextStep(card, profile)),
                children: `${next.label || 'Next step'} →`
              })
            : null
        ]
      })
    ]
  })
}

function ConsentPanel({ profile, stateError, busy, error, onAccept, onReview }) {
  return jsxs('section', {
    style: S.panel,
    'aria-labelledby': 'pickup-consent-title',
    children: [
      jsx('h2', { id: 'pickup-consent-title', style: { ...S.title, fontSize: '1.125rem' }, children: 'Turn on Pick up?' }),
      stateError
        ? jsx(Notice, { tone: 'error', children: "Pick up's saved settings couldn't be read, so it needs your OK again." })
        : null,
      jsxs('ul', {
        style: S.list,
        children: [
          jsx('li', {
            children:
              'To write the cards, the following information is sent to your own model provider, the one this Hermes already uses:'
          }),
          jsx('li', {
            children:
              'Recent chat excerpts (titles, user messages, the last reply and unfinished steps) and chat metadata: profile and source labels, timestamps, message counts, interrupted or stopped status, and associated projects.'
          }),
          jsx('li', {
            children: 'Project and file names and paths, plus when they were changed or opened.'
          }),
          jsx('li', {
            children: 'Git branch and status information, including changed file names and paths, and recent commit messages (subjects), dates and whether a commit was made by an agent.'
          }),
          jsx('li', { children: 'It never reads document or file contents. It does not change, move or delete any of your files.' }),
          jsx('li', {
            children: `It does save its own settings and the last cards in a small Pick up folder in this Hermes's data, separately for the profile you're in now ("${profile}"). There's no in-app undo for this OK yet.`
          }),
          jsx('li', {
            children:
              'It reads recent chats across all your profiles, except profiles you skip in Settings and chats and folders matching your exclusions. Skipped profiles are not read at all. You can review all of this before turning it on.'
          }),
          jsx('li', {
            children:
              'More cards and more chats make a bigger request to your model: more tokens and a few more seconds for each refresh.'
          })
        ]
      }),
      error ? jsx(Notice, { tone: 'error', children: error }) : null,
      jsxs('div', {
        style: S.actions,
        children: [
          jsx(Button, { loading: busy, onClick: onAccept, children: 'Turn on' }),
          jsx(Button, { variant: 'outline', disabled: busy, onClick: onReview, children: 'Review settings first' })
        ]
      })
    ]
  })
}

// ---- settings page ---------------------------------------------------------------------------

const toList = text =>
  Array.from(new Set(text.split('\n').map(line => line.trim()).filter(Boolean)))

const sameList = (a, b) => a.length === b.length && a.every((value, index) => value === b[index])

// Same limits as the backend (it stays the authority; its own messages are shown on the field too).
// `whole` fields are integers in [min, max]; the others are day windows: more than 0 and at most 365, fractions allowed.
const NUMBER_FIELDS = {
  max_cards: { whole: true, min: 1, max: 10, fallback: 5 },
  chats_per_profile: { whole: true, min: 1, max: 10, fallback: 3 },
  max_chats: { whole: true, min: 1, max: 40, fallback: 20 },
  chat_window_days: { fallback: 3 },
  project_window_days: { fallback: 7 },
  file_window_days: { fallback: 3 }
}

const LIST_FIELDS = ['exclude', 'project_roots']
const FORM_FIELDS = new Set([...Object.keys(NUMBER_FIELDS), ...LIST_FIELDS, 'include_files', 'exclude_profiles'])

function parseNumber(name, text) {
  const spec = NUMBER_FIELDS[name]
  const raw = String(text).trim()
  const value = raw ? Number(raw) : NaN

  if (!Number.isFinite(value)) {
    return { error: 'Enter a number.' }
  }

  if (spec.whole) {
    return Number.isInteger(value) && value >= spec.min && value <= spec.max
      ? { value }
      : { error: `Use a whole number from ${spec.min} to ${spec.max}.` }
  }

  return value > 0 && value <= 365 ? { value } : { error: 'Use more than 0 and at most 365 days.' }
}

// The form's working copy: every field as editable text/boolean, in the backend's own field names.
function toDraft(settings) {
  const saved = settings || {}

  const draft = {
    include_files: saved.include_files !== false,
    exclude_profiles: Array.isArray(saved.exclude_profiles) ? saved.exclude_profiles.slice() : []
  }

  for (const [name, spec] of Object.entries(NUMBER_FIELDS)) {
    draft[name] = String(typeof saved[name] === 'number' ? saved[name] : spec.fallback)
  }

  for (const name of LIST_FIELDS) {
    draft[name] = (Array.isArray(saved[name]) ? saved[name] : []).join('\n')
  }

  return draft
}

// What a save would send: only known fields whose value differs from the snapshot, never anything else
// (hidden fields such as skip_sessions stay as the backend holds them). `errors` are fields that cannot be sent.
function diffDraft(draft, base) {
  const body = {}
  const errors = {}

  for (const name of Object.keys(NUMBER_FIELDS)) {
    if (draft[name] === base[name]) {
      continue
    }

    const now = parseNumber(name, draft[name])

    if (now.error) {
      errors[name] = now.error
    } else if (now.value !== parseNumber(name, base[name]).value) {
      body[name] = now.value
    }
  }

  for (const name of LIST_FIELDS) {
    const list = toList(draft[name])

    if (sameList(list, toList(base[name]))) {
      continue
    }

    if (list.length > MAX_LIST) {
      errors[name] = `At most ${MAX_LIST} entries.`
    } else if (list.some(entry => entry.length > MAX_ENTRY_CHARS)) {
      errors[name] = `Each entry must be ${MAX_ENTRY_CHARS} characters or fewer.`
    } else {
      body[name] = list
    }
  }

  if (draft.include_files !== base.include_files) {
    body.include_files = draft.include_files
  }

  const skipped = draft.exclude_profiles

  if (skipped.length !== base.exclude_profiles.length || skipped.some(name => !base.exclude_profiles.includes(name))) {
    body.exclude_profiles = skipped
  }

  return { body, errors }
}

// A rejected save arrives as {detail:[{field,message}]}, either on err.detail or as JSON inside err.message.
function parseSaveError(err) {
  let detail = err && err.detail

  if (!Array.isArray(detail)) {
    const text = (err && typeof err.message === 'string' && err.message) || (typeof detail === 'string' ? detail : '')
    const brace = text.indexOf('{')

    detail = null

    if (brace >= 0) {
      try {
        detail = JSON.parse(text.slice(brace)).detail
      } catch {
        detail = null
      }
    }
  }

  const fields = {}
  const other = []

  for (const item of Array.isArray(detail) ? detail : []) {
    const message = String((item && item.message) || item).replace(/^Value error, /, '')
    const [head, ...rest] = String((item && item.field) || '').split('.')

    if (FORM_FIELDS.has(head)) {
      const entry = /^\d+$/.test(rest[0] || '') ? `Entry ${Number(rest[0]) + 1}: ` : ''

      fields[head] = fields[head] ? `${fields[head]} ${entry}${message}` : `${entry}${message}`
    } else {
      other.push(head ? `${head}: ${message}` : message)
    }
  }

  if (!Object.keys(fields).length && !other.length) {
    other.push(errorText(err))
  }

  return { fields, general: other.join('; ') }
}

function FieldMessage({ id, error }) {
  return error ? jsx('p', { id, role: 'alert', style: S.fieldError, children: error }) : null
}

function NumberField({ name, label, hint, value, error, disabled, onChange }) {
  const id = `pickup-${name}`
  const spec = NUMBER_FIELDS[name]

  return jsxs('div', {
    style: S.field,
    children: [
      jsx('label', { htmlFor: id, style: S.label, children: label }),
      jsx('input', {
        id,
        type: 'number',
        inputMode: spec.whole ? 'numeric' : 'decimal',
        step: spec.whole ? 1 : 'any',
        value,
        disabled,
        'aria-invalid': error ? 'true' : undefined,
        'aria-describedby': error ? `${id}-error ${id}-hint` : `${id}-hint`,
        style: error ? { ...S.input, ...S.inputBad } : S.input,
        onChange: event => onChange(event.target.value)
      }),
      jsx(FieldMessage, { id: `${id}-error`, error }),
      jsx('p', { id: `${id}-hint`, style: S.hint, children: hint })
    ]
  })
}

function ListField({ name, label, hint, placeholder, value, error, disabled, onChange }) {
  const id = `pickup-${name}`

  return jsxs('div', {
    style: S.field,
    children: [
      jsx('label', { htmlFor: id, style: S.label, children: label }),
      jsx(Textarea, {
        id,
        rows: 5,
        value,
        disabled,
        placeholder,
        'aria-invalid': error ? 'true' : undefined,
        'aria-describedby': error ? `${id}-error ${id}-hint` : `${id}-hint`,
        onChange: event => onChange(event.target.value)
      }),
      jsx(FieldMessage, { id: `${id}-error`, error }),
      jsx('p', { id: `${id}-hint`, style: S.hint, children: hint })
    ]
  })
}

function ProfileCheck({ name, note, checked, disabled, onChange }) {
  return jsxs('label', {
    style: S.check,
    children: [
      jsx('input', { type: 'checkbox', style: S.checkbox, checked, disabled, onChange: event => onChange(event.target.checked) }),
      jsxs('span', {
        children: [name, note ? jsx('span', { style: { color: 'var(--ui-text-tertiary)' }, children: ` · ${note}` }) : null]
      })
    ]
  })
}

function SettingsSection({ id, title, children }) {
  return jsxs('section', {
    style: S.panel,
    'aria-labelledby': id,
    children: [jsx('h2', { id, style: { ...S.title, fontSize: '1rem' }, children: title }), ...[].concat(children)]
  })
}

// Stays mounted (hidden) after it was first opened, so switching to Cards and back keeps a draft.
// `settings` is read once, when the page is first opened: it is the snapshot every edit is compared with, so
// the status polling that runs during a refresh can never overwrite what is being typed.
function SettingsView({ profile, settings, hidden }) {
  const queryClient = useQueryClient()
  const alive = useAlive()
  const [base, setBase] = useState(() => toDraft(settings))
  const [draft, setDraft] = useState(() => base)
  const [saving, setSaving] = useState(false)
  const [serverErrors, setServerErrors] = useState({})
  const [general, setGeneral] = useState(null)
  const [saved, setSaved] = useState(false)

  const profiles = useQuery({
    queryKey: key(profile, 'profiles'),
    queryFn: () => fetchScoped(profile, '/profiles'),
    retry: false,
    refetchOnWindowFocus: false
  })

  const inventory = Array.isArray(profiles.data && profiles.data.profiles)
    ? profiles.data.profiles.filter(entry => entry && typeof entry.name === 'string')
    : null

  const { body, errors: clientErrors } = diffDraft(draft, base)
  const dirty = Object.keys(body).length > 0 || Object.keys(clientErrors).length > 0
  const blocked = Object.keys(clientErrors).length > 0
  const shown = { ...serverErrors, ...clientErrors }

  const edit = (name, change) => {
    setDraft(old => ({ ...old, [name]: isFn(change) ? change(old[name]) : change }))
    setServerErrors(old => {
      if (!(name in old)) {
        return old
      }

      const { [name]: dropped, ...rest } = old

      return rest
    })
    setGeneral(null)
    setSaved(false)
  }

  const discard = () => {
    setDraft(base)
    setServerErrors({})
    setGeneral(null)
    setSaved(false)
  }

  const save = async () => {
    if (!dirty || blocked || saving) {
      return
    }

    if (currentProfile() !== profile) {
      setGeneral('The profile changed. Reopen Pick up and try again.')

      return
    }

    setSaving(true)
    setServerErrors({})
    setGeneral(null)
    setSaved(false)

    try {
      const result = await ctx.rest('/settings', { method: 'PUT', body })

      // Only this profile's status entry is touched; cached cards stay until the next refresh succeeds.
      queryClient.setQueryData(key(profile, 'status'), old =>
        old ? { ...old, settings: (result && result.settings) || { ...old.settings, ...body } } : old
      )

      if (alive.current) {
        const next = result && result.settings ? toDraft(result.settings) : draft

        setBase(next)
        setDraft(next)
        setSaved(true)
      }

      toast('success', 'Pick up settings saved. They apply to the next refresh.')
    } catch (err) {
      if (alive.current) {
        // The draft is kept exactly as typed; the message goes next to the field the backend named.
        const parsed = parseSaveError(err)

        setServerErrors(parsed.fields)
        setGeneral(
          Object.keys(parsed.fields).length
            ? ['Not saved. Check the highlighted fields.', parsed.general].filter(Boolean).join(' ')
            : `Not saved: ${parsed.general}`
        )
      }
    } finally {
      if (alive.current) {
        setSaving(false)
      }
    }
  }

  const skipped = draft.exclude_profiles
  const known = inventory ? inventory.map(entry => entry.name) : []
  // Skips for profiles that no longer exist stay in the list (so saving never drops them silently); the user can clear them.
  const missing = inventory ? skipped.filter(name => !known.includes(name)) : []

  const setIncluded = (name, included) =>
    edit('exclude_profiles', list => (included ? list.filter(entry => entry !== name) : list.includes(name) ? list : [...list, name]))

  let profileRows

  if (inventory) {
    profileRows = jsxs('div', {
      style: S.checks,
      children: [
        ...inventory.map(entry =>
          jsx(
            ProfileCheck,
            {
              name: entry.name,
              note: entry.has_session_store ? null : 'no chats stored yet',
              checked: !skipped.includes(entry.name),
              disabled: saving,
              onChange: included => setIncluded(entry.name, included)
            },
            entry.name
          )
        ),
        ...missing.map(name =>
          jsx(
            ProfileCheck,
            {
              name,
              note: 'not found on this Hermes now',
              checked: false,
              disabled: saving,
              onChange: included => setIncluded(name, included)
            },
            `missing:${name}`
          )
        )
      ]
    })
  } else if (profiles.isError) {
    profileRows = jsx(Notice, {
      tone: 'error',
      children: jsxs('span', {
        children: [
          `Couldn't load the profile list (${errorText(profiles.error)}). Your saved skips are unchanged${skipped.length ? `: ${skipped.join(', ')}` : ''}. `,
          jsx(Button, { size: 'xs', variant: 'outline', onClick: () => profiles.refetch(), children: 'Try again' })
        ]
      })
    })
  } else {
    profileRows = jsx('p', { role: 'status', style: S.hint, children: 'Loading profiles…' })
  }

  const excludeHint = toList(draft.exclude).length
    ? 'Folders (starting with / or ~/), chat titles and your own messages containing any of these are left out. This replaces the built-in list.'
    : 'Empty means nothing is left out: everything recent can be sent to your model provider.'

  const field = name => ({ name, value: draft[name], error: shown[name], disabled: saving, onChange: value => edit(name, value) })

  return jsxs('div', {
    style: { ...S.settings, display: hidden ? 'none' : 'flex' },
    hidden,
    children: [
      jsx('p', {
        style: S.hint,
        children: `For profile "${profile}". Changes apply to the next refresh; cards you already have stay until it succeeds.`
      }),
      jsxs(SettingsSection, {
        id: 'pickup-s-cards',
        title: 'Cards',
        children: [
          jsx(NumberField, {
            ...field('max_cards'),
            label: 'Number of cards',
            hint: 'From 1 to 10. Fewer is fine: Pick up does not pad the page with filler.'
          })
        ]
      }),
      jsxs(SettingsSection, {
        id: 'pickup-s-reading',
        title: 'Reading',
        children: [
          jsxs('div', {
            style: S.numbers,
            children: [
              jsx(NumberField, { ...field('chats_per_profile'), label: 'Chats per profile', hint: 'From 1 to 10 reserved per profile, subject to the total limit; spare slots are shared.' }),
              jsx(NumberField, { ...field('max_chats'), label: 'Chats in total', hint: 'From 1 to 40, across all profiles.' }),
              jsx(NumberField, { ...field('chat_window_days'), label: 'Chats: look back (days)', hint: 'More than 0, up to 365. Fractions are fine.' }),
              jsx(NumberField, { ...field('project_window_days'), label: 'Projects: look back (days)', hint: 'More than 0, up to 365.' }),
              jsx(NumberField, { ...field('file_window_days'), label: 'Files: look back (days)', hint: 'More than 0, up to 365.' })
            ]
          }),
          jsx('p', {
            style: S.hint,
            children: 'More cards and more chats make a bigger request to your model: more tokens and a few more seconds for each refresh.'
          })
        ]
      }),
      jsxs(SettingsSection, {
        id: 'pickup-s-profiles',
        title: 'Profiles',
        children: [
          jsx('p', {
            style: S.hint,
            children: 'All profiles are included by default. Untick one to skip it: a skipped profile is never read, not even to look for chats.'
          }),
          profileRows,
          missing.length
            ? jsx('p', {
                style: S.hint,
                children:
                  'Profiles marked "not found" are still saved as skipped. Hermes only accepts profiles that exist, so changing the skips while one is listed needs it cleared (tick it).'
              })
            : null,
          jsx(FieldMessage, { id: 'pickup-exclude_profiles-error', error: shown.exclude_profiles })
        ]
      }),
      jsxs(SettingsSection, {
        id: 'pickup-s-privacy',
        title: 'Privacy',
        children: [
          jsx(ListField, { ...field('exclude'), label: 'Leave out', placeholder: 'One per line: a folder path or a word', hint: excludeHint }),
          jsxs('div', {
            style: S.row,
            children: [
              jsx(Switch, {
                id: 'pickup-files',
                checked: draft.include_files,
                disabled: saving,
                onCheckedChange: value => edit('include_files', value === true)
              }),
              jsx('label', { htmlFor: 'pickup-files', children: 'Include recently changed files (names only)' })
            ]
          }),
          jsx(FieldMessage, { id: 'pickup-include_files-error', error: shown.include_files })
        ]
      }),
      jsxs(SettingsSection, {
        id: 'pickup-s-roots',
        title: 'Project folders',
        children: [
          jsx(ListField, {
            ...field('project_roots'),
            label: 'Folders that hold your projects',
            placeholder: '/path/to/your/projects',
            hint: 'One absolute folder (or ~/folder) per line. Empty means Pick up finds your project folders itself.'
          })
        ]
      }),
      general ? jsx(Notice, { tone: 'error', children: general }) : null,
      saved ? jsx(Notice, { tone: 'info', children: 'Saved. Changes apply to the next refresh; your current cards stay until it succeeds.' }) : null,
      jsxs('div', {
        style: S.actions,
        children: [
          jsx(Button, { loading: saving, disabled: !dirty || blocked, onClick: save, children: 'Save' }),
          jsx(Button, { variant: 'outline', disabled: saving || !dirty, onClick: discard, children: 'Discard' })
        ]
      })
    ]
  })
}

function LoadingGrid() {
  return jsx('div', {
    style: S.grid,
    'aria-busy': 'true',
    'aria-label': 'Loading',
    children: [0, 1].map(index => jsx(Skeleton, { style: { height: '12rem', borderRadius: '0.75rem' } }, index))
  })
}

function PickupBody({ profile }) {
  const queryClient = useQueryClient()
  const alive = useAlive()
  // 'cards' | 'settings'. The settings form is created the first time it is opened and then kept (hidden).
  const [view, setView] = useState('cards')
  const [settingsSeen, setSettingsSeen] = useState(false)
  const [running, setRunning] = useState(() => refreshing.has(profile))
  const [refreshError, setRefreshError] = useState(null)
  const [consenting, setConsenting] = useState(false)
  const [consentError, setConsentError] = useState(null)

  const status = useQuery({
    queryKey: key(profile, 'status'),
    queryFn: () => fetchScoped(profile, '/status'),
    retry: false,
    refetchOnWindowFocus: false,
    // A refresh started elsewhere (another window, or before this page opened) is followed until it ends.
    // Accepts both TanStack call shapes: (query) and (data, query).
    refetchInterval: arg => {
      const data = arg && arg.state ? arg.state.data : arg

      return data && data.refreshing ? STATUS_POLL_MS : false
    }
  })

  const consented = Boolean(status.data && status.data.consent && status.data.consent.given)

  const cards = useQuery({
    queryKey: key(profile, 'cards'),
    queryFn: () => fetchScoped(profile, '/cards'),
    enabled: consented,
    retry: false,
    refetchOnWindowFocus: false
  })

  const refresh = async () => {
    if (currentProfile() !== profile) {
      return
    }

    setRunning(true)
    setRefreshError(null)

    try {
      await startRefresh(profile, queryClient)
    } catch (err) {
      if (alive.current) {
        setRefreshError(errorText(err))
      }
    } finally {
      if (alive.current) {
        setRunning(false)
      }
    }
  }

  // When a refresh that was running (anywhere) ends, the cards it wrote must be re-read.
  const wasRefreshing = useRef(false)
  const refreshingNow = Boolean(status.data && status.data.refreshing)

  useEffect(() => {
    if (wasRefreshing.current && !refreshingNow) {
      queryClient.invalidateQueries({ queryKey: key(profile, 'cards') })
    }

    wasRefreshing.current = refreshingNow
  }, [refreshingNow])

  // A refresh started before a profile round-trip is still running: show it as running again.
  useEffect(() => {
    const pending = refreshing.get(profile)

    if (pending) {
      pending.then(
        () => alive.current && setRunning(false),
        () => alive.current && setRunning(false)
      )
    }
  }, [profile])

  const accept = async () => {
    if (currentProfile() !== profile) {
      return
    }

    setConsenting(true)
    setConsentError(null)

    try {
      const result = await ctx.rest('/consent', { method: 'POST', body: { accepted: true } })

      queryClient.setQueryData(key(profile, 'status'), old => ({ ...(old || {}), consent: result.consent }))
      queryClient.invalidateQueries({ queryKey: key(profile, 'status') })
      queryClient.invalidateQueries({ queryKey: key(profile, 'cards') })

      if (alive.current) {
        setConsenting(false)
      }

      // Turning on includes the first scan, so there is something to look at.
      await refresh()
    } catch (err) {
      if (alive.current) {
        setConsentError(errorText(err))
        setConsenting(false)
      }
    }
  }

  const showView = next => {
    if (next === 'settings') {
      setSettingsSeen(true)
    }

    setView(next)
  }

  const shown = Array.isArray(cards.data && cards.data.cards) ? cards.data.cards.slice(0, MAX_CARDS) : []
  const madeAt = cards.data ? formatUpdated(cards.data.made_at) : null
  const busy = running || refreshingNow

  let content

  if (status.isLoading) {
    content = jsx(LoadingGrid, {})
  } else if (status.isError && !status.data && isPluginNotFound(status.error)) {
    content = jsxs(ErrorState, {
      title: 'Hermes isn\u2019t loading the Pick up service',
      description:
        'Hermes answered \u201cPlugin not found\u201d. This is a known Hermes bug (issue 134712) on installs with more than one ' +
        'profile: the Desktop backend can end up reading another profile\u2019s plugin list. Fix: add hermes-pickup to ' +
        'plugins.enabled in every profile\u2019s config.yaml (running install.sh again offers to do this), then quit ' +
        'Hermes Desktop with \u2318Q and reopen it.',
      children: [
        jsx(Button, { variant: 'outline', onClick: () => status.refetch(), children: 'Try again' }),
        jsx(Button, {
          variant: 'outline',
          onClick: async () => {
            const copied = await copyText(PROFILE_DRIFT_ISSUE)
            toast(copied ? 'info' : 'error', copied ? 'Issue link copied.' : PROFILE_DRIFT_ISSUE)
          },
          children: 'Copy issue link'
        })
      ]
    })
  } else if (status.isError && !status.data) {
    content = jsxs(ErrorState, {
      title: "Couldn't reach Pick up",
      description: `${errorText(status.error)} If you just installed it, restart Hermes Desktop once so the Pick up service starts.`,
      children: [jsx(Button, { variant: 'outline', onClick: () => status.refetch(), children: 'Try again' })]
    })
  } else if (!consented) {
    content = jsx(ConsentPanel, {
      profile,
      stateError: Boolean(status.data && status.data.state_error),
      busy: consenting,
      error: consentError,
      onAccept: accept,
      onReview: () => showView('settings')
    })
  } else if (cards.isLoading) {
    content = jsx(LoadingGrid, {})
  } else if (cards.isError && !cards.data) {
    content = jsxs(ErrorState, {
      title: "Couldn't load your cards",
      description: errorText(cards.error),
      children: [jsx(Button, { variant: 'outline', onClick: () => cards.refetch(), children: 'Try again' })]
    })
  } else if (!shown.length) {
    content = jsx(EmptyState, {
      title: 'Nothing to pick up',
      description: cards.data && cards.data.made_at ? 'No unfinished work turned up in your recent chats, projects and files.' : 'Press Refresh to look through your recent chats, projects and files.'
    })
  } else {
    content = jsx('div', {
      style: S.grid,
      children: shown.map((card, index) => jsx(PickupCard, { card, rank: index, profile }, `${card.title}:${index}`))
    })
  }

  return jsxs('div', {
    style: S.page,
    children: [
      jsxs('div', {
        style: S.inner,
        children: [
          jsxs('header', {
            style: S.header,
            children: [
              jsxs('div', {
                children: [
                  jsx('h1', { style: S.h1, children: 'Pick up where you left off' }),
                  jsx('p', {
                    style: S.sub,
                    children: 'From your recent chats, projects and files. Nothing is sent or changed until you press a button.'
                  })
                ]
              }),
              jsxs('div', {
                style: S.tools,
                children: [
                  madeAt ? jsx('span', { children: `Updated ${madeAt}` }) : null,
                  consented
                    ? jsxs(Button, {
                        size: 'sm',
                        variant: 'outline',
                        loading: busy,
                        onClick: refresh,
                        'aria-label': 'Refresh',
                        children: [jsx(Codicon, { name: 'refresh' }), 'Refresh']
                      })
                    : null
                ]
              })
            ]
          }),
          // Only offered once the saved settings are known: the form is seeded from them and must never start from guesses.
          status.data
            ? jsxs('div', {
                role: 'group',
                'aria-label': 'Pick up sections',
                style: S.tabs,
                children: [
                  jsx(Button, {
                    size: 'sm',
                    variant: view === 'cards' ? undefined : 'outline',
                    'aria-pressed': view === 'cards',
                    onClick: () => showView('cards'),
                    children: 'Cards'
                  }),
                  jsx(Button, {
                    size: 'sm',
                    variant: view === 'settings' ? undefined : 'outline',
                    'aria-pressed': view === 'settings',
                    onClick: () => showView('settings'),
                    children: 'Settings'
                  })
                ]
              })
            : null,
          busy
            ? jsx(Notice, {
                tone: 'info',
                children: 'Looking through your recent work and asking your model provider. This can take up to a minute.'
              })
            : null,
          refreshError
            ? jsx(Notice, {
                tone: 'error',
                onDismiss: () => setRefreshError(null),
                children: `Refresh failed: ${refreshError}${shown.length ? ' Showing your previous cards.' : ''}`
              })
            : null,
          cards.isError && cards.data
            ? jsx(Notice, { tone: 'error', children: `Couldn't update the list: ${errorText(cards.error)}` })
            : null,
          view === 'cards' ? content : null,
          settingsSeen && status.data
            ? jsx(SettingsView, { profile, settings: status.data.settings, hidden: view !== 'settings' })
            : null
        ]
      })
    ]
  })
}

// Remounting per profile drops every piece of local state (open settings form, edits, errors, spinners),
// and the query keys carry the profile, so a switch can never show the previous profile's data.
function PickupPage() {
  const profile = useValue(host.state.profile)

  return jsx(PickupBody, { profile: String(profile ?? '') }, String(profile ?? ''))
}

export default {
  id: PLUGIN_ID,
  name: 'Pick up',
  register(pluginCtx) {
    ctx = pluginCtx

    pluginCtx.registerMany([
      { id: 'page', area: ROUTES_AREA, title: 'Pick up', data: { path: ROUTE }, render: () => jsx(PickupPage, {}) },
      { id: 'nav', area: SIDEBAR_NAV_AREA, title: 'Pick up', data: { path: ROUTE, label: 'Pick up', codicon: 'history' } },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: `${PLUGIN_ID}.open`,
          label: 'Pick up where you left off',
          keywords: ['pickup', 'pick up', 'resume', 'continue', 'unfinished', 'left off'],
          run: () => host.navigate(ROUTE)
        }
      }
    ])

    pluginCtx.onDispose(() => {
      actionSeq += 1
    })
  }
}
