# PRD — Local Ollama Chat Harness (MVP)

## Context for the build session

This is a from-scratch build (not a clone of an existing repo). The goal is a clean
chat UI that connects to a locally hosted Ollama instance, streams responses, and is
structured so that future backends and features slot in without a rewrite.

Build it in **vertical slices** — each slice must be runnable before moving to the next.
Never leave the app in a half-wired, non-running state. Confirm each slice works before
proceeding.

**Stack:** Next.js 15 (App Router), React, Tailwind CSS. Persistence via `localStorage`
for the MVP (no database). No auth, no multi-user.

---

## The one architectural rule

**Every call to the inference backend goes through a single module: `lib/inference.js`.**

No React component talks to Ollama directly. Streaming, request shaping, error handling,
and the abort signal all live in this one module. The backend endpoint is read from a
config value, not hardcoded at call sites. This is what makes future backend swaps
(llama.cpp's `llama-server`, an AirLLM FastAPI shim, etc.) a config change rather than a
refactor. Do not violate this even for "quick" calls.

---

## Backend (MVP target)

- **Ollama only** for the MVP. Default endpoint `http://localhost:11434`.
- All browser→Ollama traffic is **proxied through Next.js server-side route handlers**
  so the browser never hits port 11434 directly (avoids CORS entirely).
- Endpoints used:
  - `POST /api/chat` → proxies to Ollama `POST /api/chat` with `stream: true`
  - `GET /api/tags` → proxies to Ollama `GET /api/tags` (installed model list)

**Explicitly out of scope for MVP** (note as future, do not build): AirLLM, llama.cpp
direct connection, RAG, tool calling, vision/multimodal, themes, settings panels beyond
the basics, syntax highlighting, auth, database persistence, desktop (Tauri) packaging.
The architecture must leave room for these but must not implement them.

---

## Data model

Define these shapes up front; persist to `localStorage`. Include a `version` field on the
top-level persisted blob so stored conversations can be migrated later.

```
Conversation {
  id: string
  title: string
  model: string            // selected per-conversation, not global
  systemPrompt: string     // optional, default ""
  params: {                // optional tuning, sensible defaults
    temperature?: number
    num_ctx?: number
  }
  messages: Message[]
  createdAt: number
}

Message {
  id: string
  role: "user" | "assistant" | "system"
  content: string
  status: "queued" | "streaming" | "complete" | "errored" | "aborted"
  createdAt: number
  meta?: object            // reserved for future: tokens, latency, tokens/sec. Leave empty.
}
```

Notes:
- `model` lives on the **Conversation**, not as a global app-level selection. Each chat
  remembers its own model; switching conversations restores that conversation's model.
- `status` on Message is load-bearing — the stop button and error display depend on it.
  Do not model a message as just a content string.
- `meta` is stubbed now (empty) so a future logging slice has a home. Don't populate it.

---

## The "bones" — non-negotiable for MVP

These are not features; they are structure that is painful to retrofit. Build them in
while the app is small.

1. **Message `status` field** — every message moves through the lifecycle above. UI
   reflects streaming vs complete vs errored.
2. **`AbortController` on the stream fetch** — threaded through `lib/inference.js` so a
   generation can be cancelled. Wire the plumbing even if the stop button is ugly.
3. **Error & connection states** — handle, with plain-language UI messaging, at minimum:
   - Ollama server unreachable / not running
   - Selected model not found / not pulled
   - Stream interrupted mid-response
   A spinner that never resolves is a failure. Ugly text that explains the problem is a pass.
4. **Clean, versioned persisted shape** — `localStorage` only, but with a `version` field
   so a later move to SQLite/Supabase can migrate rather than discard old chats.

---

## Build slices (do in order, each runnable)

### Slice 0 — Prove the connection
- `app/api/chat/route.js`: a server route that POSTs to Ollama `/api/chat` and streams the
  response back. No UI yet — verify the stream works (e.g. log chunks server-side or hit
  the route directly). Confirm the chunk/JSON-lines format is understood before building UI.

### Slice 1 — Dumbest possible chat
- One page, one input, one message list, streaming into the assistant bubble.
- Hardcode the model for now. No history, no picker, no styling beyond a basic font/colors.
- **Resend the entire `messages` array on every request** — the server is stateless about
  the conversation; the client owns the history. This is core, not optional.
- Wire `status` and `AbortController` in here even though they're minimal — they're bones.

### Slice 2 — Conversation state as a real shape
- Implement the `Conversation` / `Message` shapes in React state.
- Persist to `localStorage` with the `version` field.
- Still single-conversation at this point.

### Slice 3 — Control surface
- Model picker populated dynamically from `GET /api/tags` (so `ollama pull <name>` makes a
  model appear with no code change). Selection writes to `conversation.model`.
- System prompt field (writes to `conversation.systemPrompt`).
- Parameter inputs: `temperature`, `num_ctx` (write to `conversation.params`, pass through
  to the request body).
- Add a small loading state on model switch to cover Ollama's cold-start pause when a model
  is loaded into memory for the first time.

### Slice 4 — Multi-conversation
- Sidebar: new / switch / delete / rename conversations.
- Mostly CRUD over the Slice-2 shape. This is the point the app becomes daily-usable.

(Slices beyond 4 — logging/meta, side-by-side model compare, RAG, tools, backend swaps,
desktop packaging — are future and out of scope here.)

---

## File structure (keep flat early)

```
app/
  api/chat/route.js        # proxy + stream to Ollama /api/chat
  api/tags/route.js        # proxy to Ollama /api/tags (model list)
  page.jsx                 # the whole UI, one file, early on
lib/
  inference.js             # ALL backend calls live here — endpoint behind config
  store.js                 # conversation state + localStorage persistence (versioned)
```

Resist early: component libraries, global state managers, auth, a database. Add them as
later slices only after the core works. (shadcn/ui is a fine *later* choice for menu/chrome
polish — it's Tailwind + Radix, copy-paste, no runtime bloat — but not part of the MVP.)

---

## Definition of done (MVP)

- A clean, minimally-styled UI streams responses from local Ollama.
- Model is selectable from installed models; selection is remembered per conversation.
- System prompt and temperature/`num_ctx` are adjustable and take effect.
- Multiple conversations can be created, switched, renamed, deleted, and survive reload.
- Stop button cancels an in-flight generation.
- Server-down, model-missing, and interrupted-stream cases show clear messaging instead of
  hanging.
- All backend calls route through `lib/inference.js`; the Ollama endpoint is a single config
  value.
- Persisted data carries a `version` field.

---

## Notes / gotchas to keep in mind

- **CORS** is avoided by proxying through Next.js server routes — do not call port 11434
  from the browser.
- **Statelessness:** the model server remembers nothing between calls; the frontend replays
  full history every request. Context-window limits and eventual truncation handling all
  flow from this.
- **Cold start:** first message to a not-yet-loaded model has a pause while weights load —
  cover with a loading state, it's not an error.
- **Markdown rendering is deliberately out of scope** for MVP (raw text is fine). When added
  later, render markdown only on *completed* messages, not on every stream chunk, to keep it
  off the hot path.
