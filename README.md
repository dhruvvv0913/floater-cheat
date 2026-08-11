# floater-cheat

A floating desktop panel that is invisible to screen capture, screen sharing and recording, invisible
on screen until you hover it, and answers questions about what's on your display in one keypress.
Personal tool, Windows-first.

```
npm install
npm start
```

It launches into the tray with no taskbar or Alt+Tab entry, and nothing visible on screen. Add an
API key via **tray → Settings** (or set `ANTHROPIC_API_KEY` — see [AI providers](#ai-providers) for
the other three), then press `Ctrl+Shift+Space`.

## How it behaves

The panel sits at the top-right corner by default and is **completely invisible until your cursor is
inside its bounds**. Move the mouse there and it appears instantly; move away and it's gone
instantly. Nothing fades, because a fade is a window during which it's half-visible.

**Press and hold anywhere on the panel to drag it** somewhere else. It remembers where you put it —
you hover that spot to bring it back. If you lose it, `Ctrl+Shift+←↑↓→` walks it back into view.

The answer **persists**: it stays exactly as it was until you press the answer hotkey again for a new
question, so hovering away and back shows the same text. It is never cleared by hiding.

## Hotkeys

| Action | Default | Notes |
| --- | --- | --- |
| **Answer what's on screen** | `Ctrl+Shift+Space` | Screenshots, answers, replaces the panel's contents |
| Ask a specific question | `Ctrl+Shift+Enter` | Slides in a text box. Enter sends, Esc closes |
| Retry harder | `Ctrl+Shift+H` | Re-runs the **last** capture at high effort — when a terse answer came back low-confidence |
| Explain last answer | `Ctrl+Shift+E` | Expands the terse answer into two or three sentences, streamed |
| Answer clipboard text | `Ctrl+Shift+G` | Answers about copied text — no screenshot, so cheap and fast |
| Copy answer | `Ctrl+Shift+C` | |
| Previous / next answer | `Ctrl+Shift+[` / `]` | Pages through the last 8 answers |
| Select region | `Ctrl+Shift+R` | Drag a box; every capture crops to it |
| Clear region | `Ctrl+Shift+F` | Back to whole-screen capture |
| Clear everything | `Ctrl+Shift+Backspace` | Wipes all answers + conversation from memory |
| Keep visible (pin) | `Ctrl+Shift+\` | Stays up without hovering — for reading a long answer |
| Toggle stealth | `Ctrl+Shift+P` | Turn capture-exclusion off when you *want* to share it |
| Self-test | `Ctrl+Shift+T` | Verifies invisibility for real |
| Move | `Ctrl+Shift+←↑↓→` | 40px steps — the recovery path if you lose the panel |

All configurable in `config.json` (tray → *Open config folder*). Every binding is checked before it's
ever handed to the OS, and a failure is reported with **why**, not just that it failed: `conflict`
means two of the *app's own* actions share a key (nothing to do with another app), `invalid` means the
string isn't shaped like a real shortcut, `unavailable` means another application already owns it at
the OS level. All three show up distinctly in Settings and the tray tooltip.

## The answer flow

One keypress does everything: capture the display → send it to Claude → stream the answer into the
panel. **The panel is not revealed while this happens** — that's the point. The answer is waiting the
next time you hover.

Answers are deliberately tiny, and the format is **enforced by a JSON schema** rather than hoped for
from a prompt. Every answer comes back as three fields:

| Field | Why it exists |
| --- | --- |
| `question` | What the model *thought* it was answering, shown in small grey text above the answer. On a screen with several questions this is the cheapest possible guard against the worst failure this app has — a confident answer to the question you didn't mean. |
| `answer` | MCQ → option letter + ≤6 words. Numeric → the value alone. Otherwise one sentence under 25 words. No working, no restating. |
| `confidence` | `high` / `medium` / `low`, rendered as a coloured dot. Prompt-only confidence was ignored half the time; a schema field isn't. |

One-shot answers are **not streamed** — the payload is a handful of words, so streaming buys nothing
while a schema buys a guaranteed shape. Typed follow-ups still stream token by token, because there
prose length is what you feel.

Each one-shot is **independent** — it does not see the previous question's screenshot, because the
screen has changed and cross-contamination between unrelated questions is worse than no context. The
exchange is still recorded, so a typed follow-up afterwards has it.

Pressing the hotkey twice on an **unchanged screen** reuses the last answer instead of paying for a
guaranteed-identical one (the capture is hashed).

**Screenshot, not OCR.** The image goes straight to the vision model. OCR mangles exactly what
matters here — multi-column option layouts, mathematical notation, diagrams, code — and adds latency
for the privilege.

### Region capture — the biggest lever

`Ctrl+Shift+R`, drag a box around the question area, done. Every capture then crops to it.

A 700×400 crop versus a 2560×1440 screen is roughly an order of magnitude fewer image tokens, a
correspondingly smaller upload, and — the part that actually matters — no competing questions in
frame for the model to answer instead. If you're working through a fixed layout, set it once.

### Which screen gets captured

The display **under your cursor**, not the one the panel is on. On a two-monitor setup those are
routinely different, and capturing the panel's display silently answers about the wrong screen — a
failure that looks identical to a correct answer. Configurable to `panel` or `primary` in
`config.json`.

## AI providers

Settings has a **provider** picker above the model picker. Four exist, each behind the same
adapter interface (`askStructured` / `askStreaming` / `validate`) so `ai.js` never knows which SDK
it's actually talking to — see `src/main/providers/`.

| Provider | Key needed | Notes |
| --- | --- | --- |
| **Anthropic** (default) | `ANTHROPIC_API_KEY` or Settings | `claude-opus-5` / `claude-sonnet-5` / `claude-haiku-4-5`. Structured output via `output_config.format`. Server-side refusal fallbacks on by default — see below. |
| **OpenAI** | `OPENAI_API_KEY` or Settings | `gpt-4o-mini` / `gpt-4o`. Structured output via strict `response_format: json_schema`. |
| **Gemini** | `GEMINI_API_KEY` or Settings | `gemini-2.5-flash` / `gemini-2.5-pro`. Structured output via `responseSchema`. |
| **Ollama** | **none** | Runs on your own machine — nothing leaves it, and it's free. Needs a **vision-capable** local model (`llama3.2-vision`, `qwen2.5vl`, `gemma3` are the suggested picks) pulled and the Ollama server running at `http://localhost:11434`. Cost always shows **$0**, for any model name — not looked up per-model, because a lookup table can't enumerate everything a user might pull. |

Switching providers remembers your last model choice for each one, so flipping back and forth doesn't
lose either pick. Whichever key field applies swaps automatically; Ollama shows no key field at all.

**Every provider is fully covered by the mocked test suite** (`npm test`) — request-shape translation
(how each SDK wants images and structured output), streaming, refusal/safety-block detection, error
mapping, and one full end-to-end pipeline test per provider through `ai.js` itself. What the suite
*cannot* prove is a real network round-trip: OpenAI/Gemini need a real key, Ollama needs the app
actually installed and a model actually pulled. That verification is on you.

### Model and cost

| | |
| --- | --- |
| Default | `claude-opus-5`, effort `low` — raise effort in Settings for harder questions at the cost of a slower answer |
| `max_tokens` | 16000. Thinking is **on by default** on Opus 5 and shares this budget with the reply, so a tight cap truncates answers mid-sentence. It's a ceiling, not a charge. |
| Image size | `fast` 1280px / `balanced` 1568px (default) / `max` 2576px on the long edge, JPEG q92 |

**Spend is tracked** per-provider in the same place. Session and lifetime token counts and dollar cost
are in Settings, and each answer shows its own cost and latency underneath. A full-screen vision
capture runs to a few thousand input tokens on its own, so the image usually dominates the bill on
short answers — which is the other reason region capture is worth setting up. Set `ai.budgetUsd` in
`config.json` for a hard cap (checked before a request is sent, regardless of provider — Ollama never
trips it, since it's always $0).

Timings for every request land in the log file (tray → *Open log file*): capture ms, size on the
wire, time to first token, total, and cost.

### If an answer looks wrong

Two keys, no retyping:

- **`Ctrl+Shift+H` (retry harder)** re-runs the *same* screenshot at high effort. Terse mode defaults
  to `low` for speed; this spends real thinking on a question it fumbled. It acts on the last image,
  not the current screen, so it answers the question you meant even if the screen has moved on.
- **`Ctrl+Shift+E` (explain)** expands the terse answer into a couple of sentences of reasoning,
  streamed, so you can sanity-check *why* before trusting it.

### Appearance

Settings → *Display & privacy* has a **theme** picker — **dark**, **light**, or **auto** (follows
Windows and flips live when you change the OS setting). Pick whichever blends into what's behind it.
Opacity and text size are sliders in the same place. The whole colour system is CSS variables, so both
themes restyle every surface — no half-dark corner left behind.

### Privacy

Everything is in memory — screenshots are never written to disk, and answers live in a ring buffer
that dies with the process. **`Ctrl+Shift+Backspace`** wipes all of it immediately. Settings has a
*remember conversation* switch: turn it off and nothing is retained between questions at all.

### API keys

One encrypted file **per provider** — `${provider}-key.bin` — via Electron `safeStorage`, backed by
the OS keystore (DPAPI on Windows) and tied to your user account. **Never** in `config.json` — that
file gets opened and pasted around. Each provider's conventional environment variable
(`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`) is the fallback if nothing's stored. Nothing
in the renderer can read a key back out; the preload bridge is write-only for all of them.

A new key is validated at save time with a free, tokenless probe call (`models.retrieve` /
`models.get` / equivalent) — bad keys fail immediately in Settings, not on your first real question.
Before this became multi-provider, the single Anthropic key lived at literally `anthropic-key.bin` —
which is exactly what the per-provider naming produces for `provider === 'anthropic'` anyway, so an
existing key keeps working with **no migration step**.

Server-side refusal fallbacks are on by default for Anthropic, so a request declined by Opus 5's
safety classifiers re-runs on a suitable model in the same call rather than coming back empty. If your
account lacks that beta, the request retries once without it instead of failing. The other three
providers have their own refusal/safety-block detection (`finish_reason: 'content_filter'` for OpenAI,
`finishReason: 'SAFETY'`/`'BLOCKLIST'`/`'PROHIBITED_CONTENT'`/`'SPII'` for Gemini) but no equivalent
automatic-retry feature — that's an Anthropic-specific hardening capability, not something to fake
elsewhere.

## Verification

```
npm test
```

Runs a headless harness (`test/run.js`) that stubs `electron` and all four provider SDKs
(`@anthropic-ai/sdk`, `openai`, `@google/genai`, and Ollama's plain `fetch`) at the module loader, and
drives the **real** `ai`, `usage`, `capture`, `config`, `secrets`, `hotkeys`/`shortcut-utils` and
`markdown` modules against scripted responses. It covers the plumbing a "does it launch" check can't:

- structured-JSON parsing (question / answer / confidence), for every provider's own structured-output mechanism
- per-provider request-shape translation — how each SDK wants images and history (verified directly against each SDK's actual type definitions, not guessed)
- conversation retention **and** the retention-off switch — by inspecting the actual request payload
- that older screenshots are stripped from history (only the newest image ships)
- the effort override that powers retry-harder
- cost math, the cache-read discount, the hard budget cap blocking a request before it's sent, and that Ollama is **always** $0 regardless of model name
- streaming assembly and time-to-first-token, for every provider
- refusal/safety-block handling and error mapping, for every provider — including the shared status-code classifier itself, unit-tested directly (`provider-errors.js`)
- shortcut conflict / invalid / OS-unavailable detection, distinguished correctly
- key validation, the per-provider key-storage migration path, and the DPI-scaling capture math
- that the Markdown renderer builds DOM nodes and **never** produces an `innerHTML` string (the
  CSP-safety guarantee for untrusted model output)

147 assertions, no key or network needed.

What it does **not** cover, because nothing headless can: the actual model's answers, a real network
round-trip to any provider, whether Ollama is actually installed and reachable, the hover feel, and
whether the panel is truly invisible on your hardware — that last one is what the self-test
(`Ctrl+Shift+T`) is for.

## Building a real app

```
npm run pack    # unpacked build in dist/win-unpacked/Floater.exe
npm run dist    # NSIS installer + portable .exe in dist/
```

Produces `Floater.exe` (~225MB — that's Electron). **Start on login** is in the tray menu and only
does anything in a packaged build; in dev the "executable" is `electron.exe` and registering that
would launch bare Electron at login.

Launch it the normal way — Explorer, Start menu, taskbar, or the login item. The **one** environment
that breaks it is a shell with `ELECTRON_RUN_AS_NODE=1` set (VS Code's integrated terminal exports
this): in that mode the binary boots as bare Node and never loads the app, and there's no JS hook that
runs early enough to fix it. If you must launch from such a terminal, unset the variable first
(`Remove-Item Env:\ELECTRON_RUN_AS_NODE`). This does not affect normal double-click launches.

Note the packaged app writes its config, log and key to `%APPDATA%\Floater\`, not
`%APPDATA%\floater-cheat\` — the `productName` in `package.json` decides that. Dev and packaged builds
therefore share settings only if `productName` matches.

## How the invisibility works

`win.setContentProtection(true)`. On Windows that's
`SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE)`, enforced inside **DWM** rather than in the
capturing application — so it covers every capture path at once: Windows Graphics Capture, DXGI
Desktop Duplication and legacy BitBlt/GDI. Zoom, Teams, Meet, Discord, OBS, Snipping Tool and
PrintScreen all read from those, and none of them see the panel.

Requires Windows 10 build 19041 (2004) or newer. Below that the flag degrades to `WDA_MONITOR`, which
paints a black rectangle instead of hiding — worse than not trying. Settings checks your build.

macOS uses `NSWindow.sharingType = .none` via the same call. **Linux has no equivalent** on X11 or
Wayland; the panel is fully visible there and Settings says so.

### What it does not defeat

- A phone camera pointed at your monitor
- An HDMI capture card or splitter — downstream of the GPU, past where DWM has any say
- **Anything reading the process list.** The app is plainly visible in Task Manager. Pixel
  invisibility is not process invisibility.

## The self-test

Verification via `desktopCapturer`, which on Windows goes through Windows Graphics Capture — the same
path the conferencing apps use, so a pass is real rather than simulated. Two phases, and the order is
the point:

1. **Control** — protection *off*, marker must be **found**.
2. **Assertion** — protection *on*, marker must be **absent**.

Without the control a pass would be worthless: a failed capture, a bad crop or a blank source would
all report "not found" and look like success. If the control fails you get **INCONCLUSIVE**, never a
green tick.

## Layout

```
scripts/start.js       launcher (see ELECTRON_RUN_AS_NODE note below)
src/
  main/
    index.js           app lifecycle, tray, hotkeys, IPC
    overlay-window.js  window creation, stealth flags, hover reveal, drag
    config.js          JSON settings, merged against defaults on load
    hotkeys.js         global shortcut registration + conflict/invalid/unavailable reporting
    shortcut-utils.js  pure conflict-detection + accelerator validity (no Electron import)
    selftest.js        two-phase capture verification
    capture.js         screenshot grab, region crop, downscale, JPEG, hash
    region-select.js   full-screen picker for the crop rectangle
    secrets.js         one encrypted key file per provider (OS keystore via safeStorage)
    ai.js              provider-agnostic core — prompts, history, cost, provider registry
    usage.js           token/cost accounting with a pricing table (ollama always $0)
    logger.js          rotating file log
    providers/
      anthropic.js        Claude adapter — structured terse mode + streaming chat
      openai.js           GPT adapter — BYOK
      gemini.js           Gemini adapter — BYOK
      ollama.js           local/free adapter — plain fetch, no SDK, no key
      provider-errors.js  shared HTTP-status-code error classifier (not used by ollama — see its own file)
  preload/
    index.js           contextBridge surface — the only renderer<->Node path
    region.js          two-message bridge for the region picker
  renderer/
    app.js             shell: reveal state, drag-to-move, view switching
    views/answer.js    the default view — one answer, nothing else
    views/settings.js  provider, key, model, region, spend, self-test, hotkeys
    views/markdown.js  tiny CSP-safe Markdown subset (no innerHTML)
    region.{html,css,js}   the drag-a-box picker
```

Two views, switched from the tray. `answer` is a single block of text with no chrome at all;
everything configurable lives in `settings`. Every adapter under `providers/` implements the same
three-method shape (`askStructured` / `askStreaming` / `validate`) so `ai.js` never branches on which
one is active — see the comment at the top of `providers/anthropic.js` for the interface contract.

## Implementation notes

Load-bearing decisions that are easy to undo by accident:

- **Hover is detected by polling the cursor in the main process**, not by DOM events. A click-through
  window receives `mousemove` while the cursor is inside but gets **no reliable `mouseleave`** when it
  exits, so DOM-only detection has to guess with a timeout and flickers. `screen.getCursorScreenPoint()`
  every 60ms costs nothing and never misses.
- **Never use `win.hide()`.** `setContentProtection` has a history of silently dropping after a
  `hide()`/`show()` cycle on Windows, and this window toggles many times a minute. Reveal is a CSS
  class; the window is permanently shown.
- **The panel is click-through except while revealed.** That makes press-and-hold dragging work, at
  the cost of a click dead-zone over the panel — acceptable, since it's only clickable when your
  cursor is already on it.
- **`focusable: false`** except while the text box is open. An overlay that steals focus mid-sentence
  gives itself away far more readily than a stray pixel.
- **Dragging is manual (mousedown + `screenX` deltas), not `-webkit-app-region`** — app-region hit
  testing is unreliable on a transparent, non-focusable window.
- **`skipTaskbar: true`** keeps it out of Alt+Tab as well as the taskbar.

The panel never appears in its own screenshots — DWM excludes it for the same reason Zoom can't see
it. With stealth *off*, `capture.js` blanks it for the moment of capture instead.

If the panel renders as a black box or flickers, that's the known `transparent` + `alwaysOnTop`
interaction with hardware acceleration on some GPU/driver combos. Fix is
`app.disableHardwareAcceleration()` at the top of `src/main/index.js`, at some rendering cost.

### Why `npm start` goes through `scripts/start.js`

VS Code exports `ELECTRON_RUN_AS_NODE=1` into its integrated terminal (VS Code is itself an Electron
app). Inherited by a child process, that flag makes the electron binary boot as **plain Node**:
`process.type` is undefined and `require('electron')` returns the executable's *path string* instead
of the API object, so the app dies immediately on:

```
TypeError: Cannot read properties of undefined (reading 'requestSingleInstanceLock')
```

The launcher strips the variable before spawning, so `npm start` works identically from VS Code,
Windows Terminal or cmd.exe. Running `npx electron .` directly from a VS Code terminal will still hit
this — use `npm start`.
