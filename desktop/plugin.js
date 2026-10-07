// Hermes Pickup — desktop half. Plain ESM, no JSX, no build step.
// Imports are limited to the three specifiers a disk plugin may use.
// Backend: /api/plugins/hermes-pickup/* (see README.md "API"). Theme variables only.
import {
  Button,
  Codicon,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const PLUGIN_ID = 'hermes-pickup'
const ROUTE = '/pickup'
const MAX_CARDS = 3
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
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 24rem), 1fr))', gap: '1rem' },
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
  drawer: {
    left: 'auto',
    right: 0,
    top: 0,
    transform: 'none',
    translate: 'none', // Tailwind v4's dialog centering uses the independent translate property.
    height: '100%',
    maxHeight: '100vh',
    width: 'min(26rem, 100vw)',
    maxWidth: '100vw',
    borderRadius: 0
  }
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
            children: 'It reads recent chats across all your profiles, except chats and folders matching your exclusions. You can review them before turning it on.'
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

const toList = text =>
  Array.from(new Set(text.split('\n').map(line => line.trim()).filter(Boolean)))

const sameList = (a, b) => a.length === b.length && a.every((value, index) => value === b[index])

// The form lives inside the dialog content, which only exists while the drawer is open. Its state is
// therefore seeded from the saved settings on every open, and a cancelled edit can never linger.
function DrawerForm({ onOpenChange, profile, status }) {
  const queryClient = useQueryClient()
  const alive = useAlive()
  const settings = (status && status.settings) || {}
  const [excludeText, setExcludeText] = useState(() => (Array.isArray(settings.exclude) ? settings.exclude : []).join('\n'))
  const [includeFiles, setIncludeFiles] = useState(() => settings.include_files !== false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const excludeList = toList(excludeText)
  const savedExclude = Array.isArray(settings.exclude) ? settings.exclude : []

  // exclude_profiles is never sent: whatever the backend holds stays untouched.
  const body = {}

  if (!sameList(excludeList, savedExclude)) {
    body.exclude = excludeList
  }

  if (includeFiles !== (settings.include_files !== false)) {
    body.include_files = includeFiles
  }

  const tooMany = excludeList.length > MAX_LIST
  const tooLong = excludeList.some(entry => entry.length > MAX_ENTRY_CHARS)
  const invalid = tooMany ? `At most ${MAX_LIST} exclusions.` : tooLong ? `Each exclusion must be ${MAX_ENTRY_CHARS} characters or fewer.` : null

  const save = async () => {
    if (!Object.keys(body).length) {
      onOpenChange(false)

      return
    }

    if (currentProfile() !== profile) {
      setError('The profile changed. Close this panel and reopen it.')

      return
    }

    setSaving(true)
    setError(null)

    try {
      const saved = await ctx.rest('/settings', { method: 'PUT', body })

      // Only this profile's status entry is touched; cached cards stay until the next refresh succeeds.
      queryClient.setQueryData(key(profile, 'status'), old =>
        old
          ? {
              ...old,
              settings: saved.settings || old.settings
            }
          : old
      )

      if (alive.current) {
        onOpenChange(false)
      }

      toast('success', 'Pick up settings saved. They apply to the next refresh.')
    } catch (err) {
      if (alive.current) {
        setError(errorText(err))
      }
    } finally {
      if (alive.current) {
        setSaving(false)
      }
    }
  }

  return jsxs(DialogContent, {
      style: S.drawer,
      children: [
        jsxs(DialogHeader, {
          children: [
            jsx(DialogTitle, { children: 'Pick up settings' }),
            jsx(DialogDescription, {
              children: `For profile "${profile}". Changes apply to the next refresh; cards you already have stay until it succeeds.`
            })
          ]
        }),
        jsxs('div', {
          style: S.field,
          children: [
            jsx('label', { htmlFor: 'pickup-exclude', style: S.label, children: 'Leave out' }),
            jsx(Textarea, {
              id: 'pickup-exclude',
              rows: 6,
              value: excludeText,
              onChange: event => setExcludeText(event.target.value),
              'aria-describedby': 'pickup-exclude-hint',
              placeholder: 'One per line: a folder path or a word'
            }),
            jsx('p', {
              id: 'pickup-exclude-hint',
              style: S.hint,
              children: excludeList.length
                ? 'Folders (starting with / or ~/), chat titles and your own messages containing any of these are left out. This replaces the built-in list.'
                : 'Empty means nothing is left out: everything recent can be sent to your model provider.'
            })
          ]
        }),
        jsxs('div', {
          style: S.row,
          children: [
            jsx(Switch, { id: 'pickup-files', checked: includeFiles, onCheckedChange: value => setIncludeFiles(value === true) }),
            jsx('label', { htmlFor: 'pickup-files', children: 'Include recently changed files (names only)' })
          ]
        }),
        invalid ? jsx(Notice, { tone: 'error', children: invalid }) : null,
        error ? jsx(Notice, { tone: 'error', children: error }) : null,
        jsxs(DialogFooter, {
          children: [
            jsx(Button, { variant: 'outline', disabled: saving, onClick: () => onOpenChange(false), children: 'Cancel' }),
            jsx(Button, { loading: saving, disabled: Boolean(invalid), onClick: save, children: 'Save' })
          ]
        })
      ]
  })
}

function SettingsDrawer({ open, onOpenChange, profile, status }) {
  return jsx(Dialog, {
    open,
    onOpenChange,
    // Mounted only while open so each open starts from the saved settings.
    children: open ? jsx(DrawerForm, { onOpenChange, profile, status }) : null
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
  const [settingsOpen, setSettingsOpen] = useState(false)
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
      onReview: () => setSettingsOpen(true)
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
                    : null,
                  jsx(Button, {
                    size: 'icon-sm',
                    variant: 'ghost',
                    onClick: () => setSettingsOpen(true),
                    // Opening before the saved settings are known would seed empty defaults to overwrite.
                    disabled: !status.data,
                    'aria-label': 'Pick up settings',
                    children: jsx(Codicon, { name: 'settings-gear' })
                  })
                ]
              })
            ]
          }),
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
          content
        ]
      }),
      jsx(SettingsDrawer, { open: settingsOpen, onOpenChange: setSettingsOpen, profile, status: status.data })
    ]
  })
}

// Remounting per profile drops every piece of local state (open drawer, edits, errors, spinners),
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
