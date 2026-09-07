# CLAUDE.md

Guidance for working in this repo. Windows-first Electron app.

## What this is

A frameless desktop overlay that is **invisible to screen capture** (Windows
`WDA_EXCLUDEFROMCAPTURE` via `setContentProtection`), **invisible on screen until
hovered**, and answers questions about what's on the display in one keypress
(screenshot → vision model → structured answer). Personal tool.

## Commands

- `npm start` — run the app (always via `scripts/start.js`, never `electron .` directly — see gotcha below).
- `npm test` — headless test harness (`test/run.js`). **173 assertions, must stay green.** No key/network needed.
- `npm run pack` — unpacked build to `dist/win-unpacked/Floater.exe`.
- `npm run dist` — NSIS installer + portable exe.

Single syntax check: `node --check <file>` for main/preload; `node --input-type=module --check < <file>` for `src/renderer/**` (ESM).

## The one environment gotcha (bites constantly)

VS Code's integrated terminal exports `ELECTRON_RUN_AS_NODE=1`. Under it, an
Electron binary boots as bare Node and **never loads the app** — you get 0
processes and no error. `scripts/start.js` strips the var before spawning, so
`npm start` works. But when launching the packaged exe or running the harness
from a shell, prefix `ELECTRON_RUN_AS_NODE= ` to clear it. This is not a bug in
our code; it's the reason `npm start` goes through a launcher.

## Architecture

Standard Electron three-process split. **All privileged work is in `src/main/`;
the renderer only renders.** The only renderer↔main path is `src/preload/index.js`
(contextBridge) — every capability is an explicit named method there.

- `main/index.js` — lifecycle, tray, global hotkeys, IPC handlers. The orchestrator.
- `main/overlay-window.js` — window creation + the **reveal-state machine** (see below) + all stealth flags.
- `main/ai.js` — provider-agnostic core: prompts, conversation history, cost, budget, the **provider registry**. Never talks to an SDK directly.
- `main/providers/*.js` — one adapter per AI backend (`anthropic`, `openai`, `gemini`, `ollama`), all implementing the same three-method interface: `askStructured` / `askStreaming` / `validate`. `provider-errors.js` is the shared HTTP-status classifier (ollama opts out — its failures are transport-level).
- `main/capture.js` — screenshot grab, region crop, DPI-correct downscale, JPEG, hash.
- `main/documents.js` — attach a PDF/text file as reference context (lazy-requires `pdf-parse`).
- `main/secrets.js` — one encrypted key file per provider (OS keystore via `safeStorage`).
- `main/{config,usage,logger,selftest,region-select,shortcut-utils,hotkeys}.js` — settings, cost accounting, rotating log, invisibility self-test, region picker, pure shortcut helpers, global-shortcut registration.
- `renderer/app.js` — shell (reveal state, drag-to-move, view switching); `views/{answer,settings,markdown}.js` — the two views + a CSP-safe markdown subset.

### The reveal-state machine (`overlay-window.js`)

The panel is invisible unless one of five flags is set: `hovered`, `pinned`,
`dragging`, `inputOpen`, `peeking`. `isRevealed()` is their OR. Hover is detected
by **polling the cursor in main** (not DOM events — a click-through window has no
reliable `mouseleave`). Reveal is a **CSS class in the renderer, never
`win.hide()`** — `setContentProtection` silently drops after a hide/show cycle on
Windows.

### The provider-adapter contract

`ai.js` builds one **canonical content shape** — `[{type:'text',text} |
{type:'image',mediaType,base64}]` — and each adapter translates it to its SDK's
wire format at the boundary. To add a provider: write the adapter, register it in
`ai.js`'s `PROVIDERS` map, add a `MODEL_CATALOG` entry + pricing in `usage.js`. It
then appears in Settings automatically.

## Conventions / invariants (don't break these)

- **Verify SDK shapes against real type defs, not memory.** Before writing adapter code, read the installed `.d.ts` (this caught OpenAI's `max_tokens`→`max_completion_tokens` and Gemini's needing explicit retry config).
- **Every change gets a test.** The harness stubs `electron` + all four provider SDKs (and ollama's `fetch`) at the module loader and drives the *real* modules against scripted responses. Match new behavior with assertions; keep it green.
- **Renderer builds DOM nodes, never `innerHTML`** — model output is untrusted; CSP forbids it and a test guards it.
- **Secrets never touch `config.json`.** Keys go through `secrets.js` (encrypted). The *one* exception is attached document text, which is cached in config in plaintext — surfaced to the user in the UI.
- **Verify by launching, not just testing.** After main-process changes: `npm start`, then check `%APPDATA%/Floater/floater-cheat.log` for a clean "starting" line and empty stderr (renderer errors forward to stderr).

## Known gap

No live API round-trip has ever run — everything is verified against mocks +
real-file smoke tests. First real answer needs a key configured in Settings
(free Gemini key from aistudio.google.com is the quickest path).
