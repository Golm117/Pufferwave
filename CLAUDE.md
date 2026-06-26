# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project status

Branded **Pufferwave**. The MVP is **built and shipped** — all five PRD slices (0–4) are on
`main`. The app is a working local Ollama chat UI: streaming, model picker, system prompt +
params, multi-conversation sidebar, versioned `localStorage` persistence. The PRD
([`ollama-harness-mvp-prd.md`](ollama-harness-mvp-prd.md)) remains the authoritative source for
architecture and scope; the load-bearing rules below are non-negotiable.

Stack as built: **Next.js 16** (App Router) + React 19 + Tailwind v4, plain JS. (The PRD said
"Next 15"; 16 was current at build time and changes nothing architecturally.)

## What this is

A local chat UI that streams responses from a locally hosted **Ollama** instance
(`http://localhost:11434`). Persistence is `localStorage` only for the MVP — no database, no auth,
no multi-user.

## Commands

```bash
npm run dev      # local dev server (http://localhost:3000)
npm run build    # production build
npm run start    # serve the production build
npm run lint     # eslint
```

`.claude/launch.json` defines a `pufferwave` preview server (`npm run dev` on :3000).

Ollama must be running locally for the app to function: `ollama serve`, and pull at least one
model (e.g. `ollama pull llama3`). `GET /api/tags` surfaces installed models into the picker.

## Architecture — the load-bearing rules

These are non-negotiable and painful to retrofit. Honor them even for "quick" changes.

1. **All inference goes through `lib/inference.js`.** No React component calls Ollama directly.
   Streaming, request shaping, error handling, and the `AbortController` signal all live in this
   one module. The backend endpoint is a single config value, never hardcoded at call sites —
   this is what makes a future backend swap (llama.cpp `llama-server`, AirLLM shim) a config
   change instead of a refactor.

2. **The browser never hits port 11434.** All browser→Ollama traffic is proxied through Next.js
   server route handlers (`app/api/chat/route.js`, `app/api/tags/route.js`) to avoid CORS.
   `/api/chat` proxies Ollama `POST /api/chat` with `stream: true`; `/api/tags` proxies
   `GET /api/tags`.

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

## Intended file layout (keep flat early)

```
app/
  api/chat/route.js   # proxy + stream to Ollama /api/chat
  api/tags/route.js   # proxy to Ollama /api/tags (model list)
  page.jsx            # the whole UI, one file, early on
lib/
  inference.js        # ALL backend calls; endpoint behind config
  store.js            # conversation state + versioned localStorage persistence
```

Resist early: component libraries, global state managers, auth, a database. (shadcn/ui is a fine
*later* choice for chrome polish, not part of the MVP.)

## Build process

Build in **vertical slices, in order, each runnable before moving on** — never leave the app in a
half-wired, non-running state. The PRD defines the slices: Slice 0 (prove the streaming proxy
route), Slice 1 (dumbest streaming chat, hardcoded model, `status` + `AbortController` wired in),
Slice 2 (real Conversation/Message shapes + versioned persistence), Slice 3 (model picker, system
prompt, params), Slice 4 (multi-conversation sidebar CRUD).

## Out of scope for MVP

Note these as future, do not build: AirLLM, llama.cpp direct connection, RAG, tool calling,
vision/multimodal, themes, syntax highlighting, auth, database persistence, Tauri packaging.
The architecture must leave room for them but must not implement them.

## Gotchas

- **Cold start:** the first message to a not-yet-loaded model pauses while weights load. Cover it
  with a loading state — it is not an error.
- **Error states must be explicit:** Ollama unreachable, model not pulled, and interrupted streams
  each need plain-language UI messaging. A spinner that never resolves is a failure.
- **Markdown is out of scope for MVP** (raw text is fine). When added later, render markdown only on
  *completed* messages, never on every stream chunk, to keep it off the hot path.
