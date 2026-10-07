// FIXTURE ONLY: a stand-in for '@hermes/plugin-sdk' so desktop/plugin.js can render in a plain browser.
// Component prop shapes mirror the real SDK source (from the Desktop plugin SDK source); behaviour is deliberately
// simple. Nothing here talks to a real Hermes. The test drives it through window.__fixture.
import * as React from 'react'

const { useEffect, useState } = React
const h = React.createElement

// ---- atoms ---------------------------------------------------------------------------------
function atom(value) {
  const listeners = new Set()

  return {
    get: () => value,
    set(next) {
      value = next
      listeners.forEach(fn => fn(value))
    },
    subscribe(fn) {
      listeners.add(fn)

      return () => listeners.delete(fn)
    }
  }
}

export function useValue(store) {
  const [value, setValue] = useState(store.get())

  useEffect(() => store.subscribe(setValue), [store])

  return value
}

// ---- mini react-query (keys, enabled, setQueryData, invalidateQueries) ---------------------
const cache = new Map()
const watchers = new Set()
const hash = k => JSON.stringify(k)
const notifyAll = () => watchers.forEach(fn => fn())

function entry(k) {
  const id = hash(k)

  if (!cache.has(id)) {
    cache.set(id, { key: k, data: undefined, error: null, loading: false, fetched: false })
  }

  return cache.get(id)
}

async function run(e, queryFn) {
  if (e.loading) {
    return
  }

  e.loading = true
  notifyAll()

  try {
    e.data = await queryFn()
    e.error = null
  } catch (err) {
    e.error = err
  } finally {
    e.loading = false
    e.fetched = true
    notifyAll()
  }
}

const fetchers = new Map()

export function useQuery({ queryKey, queryFn, enabled = true, refetchInterval }) {
  const [, tick] = useState(0)
  const e = entry(queryKey)

  fetchers.set(hash(queryKey), queryFn)

  useEffect(() => {
    const fn = () => tick(n => n + 1)

    watchers.add(fn)

    return () => watchers.delete(fn)
  }, [])

  useEffect(() => {
    if (enabled && !e.fetched && !e.loading) {
      run(e, queryFn)
    }
  }, [enabled, hash(queryKey)])

  // Same contract as TanStack's function form: called with the query, returns ms or false.
  const every = typeof refetchInterval === 'function' ? refetchInterval({ state: { data: e.data } }) : refetchInterval

  useEffect(() => {
    if (!enabled || !every) {
      return undefined
    }

    const timer = setInterval(() => run(entry(queryKey), queryFn), every)

    return () => clearInterval(timer)
  }, [enabled, hash(queryKey), every])

  return {
    data: e.data,
    error: e.error,
    isLoading: enabled && !e.fetched,
    isError: Boolean(e.error),
    refetch: () => run(entry(queryKey), queryFn)
  }
}

export function useQueryClient() {
  return {
    setQueryData(k, updater) {
      const e = entry(k)

      e.data = typeof updater === 'function' ? updater(e.data) : updater
      e.error = null
      e.fetched = true
      notifyAll()
    },
    invalidateQueries({ queryKey }) {
      const prefix = hash(queryKey).slice(0, -1)

      for (const [id, e] of cache) {
        if (id.startsWith(prefix) && fetchers.has(id)) {
          e.fetched = false
          run(e, fetchers.get(id))
        }
      }
    }
  }
}

// ---- host ----------------------------------------------------------------------------------
const profile = atom('alpha')

// Recorded calls and switches the test flips. Everything the plugin does to the "app" lands here.
export const fixture = {
  calls: [],
  toasts: [],
  clipboard: [],
  // The test exposes window.__backend (Node side) before the page script runs.
  rest: (path, opts) => window.__backend(path, opts),
  features: { openSession: true, newChat: true },
  // composer behaviour per address
  submitResult: () => true,
  insertResult: () => true
}

if (typeof window !== 'undefined') {
  window.__fixture = fixture
  window.__setProfile = name => profile.set(name)
}

export const host = {
  state: { profile },
  notify: t => {
    fixture.toasts.push(t)

    return 1
  },
  navigate: path => fixture.calls.push(['navigate', path]),
  // openSession / newChat are defined below so the test can make them "missing" (older host).
  composer: {
    submit: (id, text) => {
      fixture.calls.push(['submit', id, text])

      return fixture.submitResult(id, text)
    },
    insertText: async (id, text, opts) => {
      fixture.calls.push(['insertText', id, text, opts])

      return fixture.insertResult(id, text)
    },
    getDraft: async id => {
      fixture.calls.push(['getDraft', id])

      return null
    }
  }
}

Object.defineProperty(host, 'openSession', {
  get: () => (fixture.features.openSession ? openSessionImpl : undefined),
  configurable: true
})
Object.defineProperty(host, 'newChat', {
  get: () => (fixture.features.newChat ? newChatImpl : undefined),
  configurable: true
})

async function openSessionImpl(id, opts) {
  fixture.calls.push(['openSession', id, opts])
}

function newChatImpl(...args) {
  fixture.calls.push(['newChat', ...args])
}

export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar.nav'
export const PALETTE_AREA = 'palette'

// ---- UI kit (prop shapes from apps/desktop/src/components/ui/*) -----------------------------
export function Button({ variant = 'default', size = 'default', loading = false, disabled, children, ...rest }) {
  return h(
    'button',
    {
      ...rest,
      type: 'button',
      disabled: disabled || loading,
      'aria-busy': loading || undefined,
      'data-variant': variant,
      'data-size': size,
      style: { font: 'inherit', padding: '0.25rem 0.6rem', ...(rest.style || {}) }
    },
    children,
    loading ? h('span', { 'data-testid': 'spinner' }, '…') : null
  )
}

export const Codicon = ({ name, ...rest }) => h('i', { 'aria-hidden': 'true', className: `codicon codicon-${name}`, ...rest })
export const Skeleton = props => h('div', { 'data-slot': 'skeleton', ...props })
export const EmptyState = ({ title, description }) => h('div', { 'data-slot': 'empty' }, h('div', null, title), description && h('div', null, description))
export const ErrorState = ({ title, description, children }) => h('div', { 'data-slot': 'error-state' }, h('h2', null, title), typeof description === 'string' ? h('p', null, description) : description, children)
export const Textarea = props => h('textarea', props)

export function Switch({ checked, onCheckedChange, ...rest }) {
  return h('button', { role: 'switch', 'aria-checked': Boolean(checked), type: 'button', onClick: () => onCheckedChange(!checked), ...rest })
}

export function Checkbox({ checked, onCheckedChange, ...rest }) {
  return h('button', { role: 'checkbox', 'aria-checked': Boolean(checked), type: 'button', onClick: () => onCheckedChange(!checked), ...rest })
}

export function Dialog({ open, onOpenChange, children }) {
  return open ? h('div', { 'data-slot': 'dialog-root', 'data-open': '' }, h(DialogCtx.Provider, { value: onOpenChange }, children)) : null
}

const DialogCtx = React.createContext(() => {})

export function DialogContent({ children, style }) {
  const close = React.useContext(DialogCtx)

  return h(
    'div',
    { role: 'dialog', 'aria-modal': 'true', 'data-slot': 'dialog-content', style: { position: 'fixed', top: 0, bottom: 0, background: 'Canvas', ...style } },
    children,
    h('button', { 'aria-label': 'Close', onClick: () => close(false) }, 'x')
  )
}

export const DialogHeader = ({ children }) => h('div', null, children)
export const DialogFooter = ({ children }) => h('div', null, children)
export const DialogTitle = ({ children }) => h('h2', null, children)
export const DialogDescription = ({ children }) => h('p', null, children)
