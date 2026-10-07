# desktop/

`plugin.js` is the Hermes Desktop half of Pick up: one plain ESM file, no JSX, no build step. It imports only
`@hermes/plugin-sdk`, `react` and `react/jsx-runtime`, styles with theme variables only, and talks to the
backend through `ctx.rest` (`/api/plugins/hermes-pickup/...`, see the root README "API").
`install.sh` copies it to `$HERMES_HOME/desktop-plugins/hermes-pickup/plugin.js`; the folder name equals the
plugin id. The backend needs `hermes-pickup` in `plugins.enabled` plus one Desktop restart; until then the
page shows "Couldn't reach Pick up" with that hint.

## What it adds

- Route `/pickup`, sidebar row **Pick up**, ⌘K command **Pick up where you left off**.
- First visit: consent explanation states what goes to your configured Hermes model provider:
  - Recent chat excerpts (titles, user messages, the last reply and unfinished steps) and chat metadata:
    profile and source labels, timestamps, message counts, interrupted or stopped status, and associated projects.
  - Project and file names and paths, plus when they were changed or opened.
  - Git branch and status information, including changed file names and paths, and recent commit messages
    (subjects), dates and whether a commit was made by an agent.

  Document and file contents are never read; no user files are changed. Settings and the last cards are saved
  in the profile's Pick up folder. Settings and exclusions can be reviewed before consenting. Only an explicit
  **Turn on** sends `POST /consent`, then the first scan runs; no `/cards` or `/refresh` request precedes consent.
- Up to 3 cards (two columns when wide, one when narrow): ranking eyebrow, title, "You were…", "Stopped:",
  chips, **Continue** and the suggested next step. Header shows "Updated HH:MM", Refresh (spinner, 3-minute
  timeout, previous cards kept on error) and a settings drawer (`PUT /settings`: exclusions and include
  files only; only changed fields are sent, `exclude_profiles` is never sent). Chats come from all profiles.
  The drawer button is disabled until `GET /status` has loaded, so unknown settings are never overwritten.
- Chips: chat chips show "Telegram chat · alpha" (source + profile) with the chat's own title below in small
  muted text, one line, full title on hover; project/file chips show "Project · name" only.

## Behaviour worth knowing

- **Profile scoping.** Query keys and the page itself are keyed by `host.state.profile`; switching profile
  remounts the page (no old cards, drawer closed, edits dropped) and a response that arrives for a profile
  that is no longer current is discarded.
- **Refresh elsewhere.** If `GET /status` says `refreshing`, the page polls it every 2 s (only then); when it
  ends the cards are re-fetched, so the spinner never sticks and the new cards appear.
- **Continue** (always labelled Continue) on a chat uses `host.openSession(id, { profile, intent: 'in-place' })` when the host has it;
  otherwise (or if it throws) it copies "title (id)" to the clipboard and says so. Project/file chips and the
  no-chat fallback **copy the path** (`ctx.os.writeClipboard`) rather than reveal it, so a remote path is
  never presented as something on this Mac.
- **Next step** sends into the card's chat only if the chat item names its profile, that profile is the
  current one, and the SDK can open and submit; it opens the chat, then tries `host.composer.submit(chatId,
  prompt)` up to 20 times 100 ms apart (the composer mounts after `openSession` returns), re-checking the
  profile before every attempt. The address is always the chat id, never `null` or `'new'`. In every other
  case (other profile, no profile, old host, composer never mounted) it calls `host.newChat()` (current
  profile) and appends the prompt to the new draft with `insertText('new', …, { mode: 'block' })`. It
  never sends from that draft; the toast says so. If even that fails the prompt goes to the clipboard.

## Checks

```sh
node --check desktop/plugin.js
node desktop/test/check-imports.mjs            # import allow-list, jsx identifiers, no JSX/colour literals
node desktop/test/pickup.test.mjs --modules=<node_modules with react, react-dom, esbuild, playwright> \
     [--chrome=<chromium executable>]          # 2 tests, fixture (stub SDK), headless Chromium
node desktop/test/build.mjs --modules=<…>      # just build desktop/test/.build/harness.html to look at
```

The harness bundles the real `plugin.js` with real React against a **stub** SDK. It is not a live Hermes
Desktop. Nothing is installed; point `--modules` at any existing `node_modules`.
