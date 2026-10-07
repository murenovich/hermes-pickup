// Browser entry for the fixture harness: registers the real desktop/plugin.js against the stub SDK
// and mounts its /pickup page. FIXTURE ONLY, not a live Hermes.
import * as React from 'react'
import { createRoot } from 'react-dom/client'

import plugin from '../plugin.js'
import { fixture } from './stub-sdk.js'

const contributions = []
const ctx = {
  source: 'plugin:hermes-pickup',
  register: c => contributions.push(c),
  registerMany: cs => contributions.push(...cs),
  rest: (path, opts) => fixture.rest(path, opts),
  setTimeout: (fn, ms) => {
    const id = window.setTimeout(fn, ms)

    return () => window.clearTimeout(id)
  },
  onDispose: () => {},
  os: {
    writeClipboard: async text => {
      fixture.clipboard.push(text)

      return true
    }
  }
}

plugin.register(ctx)
window.__contributions = contributions

const page = contributions.find(c => c.area === 'routes')

createRoot(document.getElementById('root')).render(React.createElement(React.Fragment, null, page.render()))
