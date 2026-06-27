# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Branded **Pufferwave**. Shipped: the MVP (PRD slices 0–4) + a dual-provider feature (slices A–C)
+ a **Rust-native Tauri v2 desktop app** (slices T0–T3). The app is a standalone macOS desktop
chat client — streaming, provider/model picker, system prompt + params, multi-conversation sidebar.
The PRD ([`ollama-harness-mvp-prd.md`](ollama-harness-mvp-prd.md)) is the original spec; the
load-bearing rules below reflect the current (desktop) architecture and are non-negotiable.

Stack: **React 19 + Next.js 16** (App Router, **static export**) for the UI, rendered inside a
**Tauri v2** webview with a **Rust** backend. Plain JS frontend. The web/server path (Next route
handlers) was removed in T3 — inference now runs through Rust commands.

## What this is

A standalone desktop chat client (no Node at runtime). Two backends, **per conversation**:
- **Ollama (local)** — `ollama serve` running with at least one model pulled.
- **Anthropic (cloud)** — Claude via the Messages API; the key lives in the **macOS keychain**
  (set in-app under ⚙ Settings), not on disk.

## Commands

Rust toolchain prerequisite; this network needs HTTP/1.1 for cargo:
```bash
export PATH="$HOME/.cargo/bin:$PATH" CARGO_HTTP_MULTIPLEXING=false
npm run tauri dev      # run the desktop app (compiles Rust, opens the window)
npm run tauri build    # build the standalone .app + .dmg (release)
npm run lint           # eslint
npm run build          # static export only (out/) — used by `tauri build`
```

Build artifacts land in `src-tauri/target/release/bundle/` (`Pufferwave.app`, `*.dmg`). The bundle
is **ad-hoc signed** — on another Mac, Gatekeeper warns; right-click → Open (or notarize with an
Apple Developer account, out of scope).

## Architecture — the load-bearing rules

These are non-negotiable and painful to retrofit. Honor them even for "quick" changes.

1. **All inference goes through `lib/inference.js` (client) + `src-tauri/src/chat.rs` (Rust).**
   No React component calls a backend directly. The client sends a **provider-neutral payload**
   (`{provider, model, systemPrompt, params, messages}`) and consumes ONE **uniform event stream**
   (`{type:"delta"|"done"|"error"}`). `streamChat` dispatches on `isTauri()`: the desktop transport
   `invoke("chat", …)` streams uniform events over a Tauri ipc `Channel`; a `fetch` transport for a
   browser build is kept but its API routes were removed in T3. The Rust `chat` command dispatches
   by `provider`, shapes the request per backend, and emits the uniform events. Adding a backend =
   a new branch in `chat.rs`. The replay filter stays client-side; request shaping is Rust's job.

2. **Secrets and backends never touch the browser/webview JS.** The Rust process owns the network:
   it talks to Ollama (`http://localhost:11434`) and Anthropic (`https://api.anthropic.com`). The
   Anthropic key is read from the **OS keychain** (`keyring` crate; `set/clear/anthropic_key_set`
   commands), falling back to `ANTHROPIC_API_KEY` env. Cancellation is a per-request
   `CancellationToken` in managed state; `cancel_chat` drops the upstream stream.

   **Per-provider shaping (in `chat.rs`):** Ollama takes the system prompt as a leading `system`
   *message* and `temperature`/`num_ctx` as `options` (NDJSON stream); Anthropic takes system as a
   **top-level `system` param**, requires `max_tokens`, **omits `temperature`** (Opus 4.8/4.7 +
   Fable 400 on it), and is parsed from SSE. `Conversation.provider` is `"ollama" | "anthropic"`.

3. **The server is stateless about the conversation.** The client owns history and resends the
   **entire `messages` array on every request**. Context-window limits and truncation all flow
   from this.

4. **Message `status` is load-bearing.** Every message moves through
   `queued → streaming → complete | errored | aborted`. The stop button and error display depend
   on it — never model a message as just a content string.

5. **Persisted shape is versioned.** The top-level `localStorage` blob carries a `version` field
   so a later move to SQLite/Supabase can migrate rather than discard old chats.

6. **`model` lives on the Conversation, not globally.** Each conversation remembers its own model,
   system prompt, and params (`temperature`, `num_ctx`); switching conversations restores them.

7. **`meta` on Message is reserved and stays empty** — it's a stub home for a future logging slice.
   Don't populate it.

## File layout

```
app/
  page.jsx            # the whole UI, one file (static-exported into the webview)
  layout.js
lib/
  inference.js        # client: isTauri() dispatch; invoke("chat"/"list_models") or fetch
  store.js            # conversation state + versioned persistence
src-tauri/
  src/chat.rs         # Rust backend: chat (ollama + anthropic), list_models, keychain cmds
  src/lib.rs          # Tauri builder: manage state, register commands
  tauri.conf.json     # identifier ca.golm.pufferwave, window, frontendDist ../out
  Cargo.toml          # reqwest(rustls), tokio-util, futures-util, keyring
next.config.mjs       # output: "export"
```

Resist: component libraries, global state managers, auth. (shadcn/ui is a fine later choice for
chrome polish.)

## Build process

Build in **vertical slices, in order, each runnable before moving on** — never leave the app in a
half-wired, non-running state. The PRD defines the slices: Slice 0 (prove the streaming proxy
route), Slice 1 (dumbest streaming chat, hardcoded model, `status` + `AbortController` wired in),
Slice 2 (real Conversation/Message shapes + versioned persistence), Slice 3 (model picker, system
prompt, params), Slice 4 (multi-conversation sidebar CRUD).

Post-MVP, slices A–C added the **Anthropic provider** (provider-neutral payload, uniform-stream
normalizer, picker). Slices **T0–T3** then migrated to the **Tauri desktop app**: T0 (Rust + Tauri
shell), T1 (Ollama via a Rust `chat` command over an ipc Channel), T2 (Anthropic via reqwest/SSE +
keychain), T3 (static export, routes deleted, single `.app`/`.dmg`). Same discipline — each runnable.

## Out of scope / future

Not built (architecture leaves room): RAG, tool calling, vision/multimodal, markdown rendering,
the `meta`/logging slice, Windows/Linux builds, Apple notarization. **T4 (optional, next):**
migrate `localStorage` → SQLite via `tauri-plugin-sql` (uses the `version` field to migrate).

## Gotchas

- **Cold start:** the first message to a not-yet-loaded model pauses while weights load. Cover it
  with a loading state — it is not an error.
- **Error states must be explicit:** Ollama unreachable, model not pulled, and interrupted streams
  each need plain-language UI messaging. A spinner that never resolves is a failure.
- **Markdown is out of scope for MVP** (raw text is fine). When added later, render markdown only on
  *completed* messages, never on every stream chunk, to keep it off the hot path.
