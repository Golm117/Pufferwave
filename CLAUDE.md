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

Two backends are supported, **per conversation**:
- **Ollama (local)** — `ollama serve` must be running with at least one model pulled; `GET /api/tags`
  surfaces installed models into the picker.
- **Anthropic (cloud)** — set `ANTHROPIC_API_KEY` in `.env.local` (gitignored). The official
  `@anthropic-ai/sdk` runs **server-side** in the route handler; the key never reaches the browser.

## Architecture — the load-bearing rules

These are non-negotiable and painful to retrofit. Honor them even for "quick" changes.

1. **All inference goes through `lib/inference.js` (client) + `app/api/chat/route.js` (server).**
   No React component calls a backend directly. The client sends a **provider-neutral payload**
   (`{provider, model, systemPrompt, params, messages}`) and parses ONE **uniform NDJSON stream**
   (`{type:"delta"|"done"|"error"}`). The route dispatches by `provider`, shapes the real request
   per backend, and normalizes the response into that uniform stream. Adding a backend = a new
   branch in the route + a normalizer, not a refactor. The replay filter stays client-side; request
   shaping (system prompt, params) is the route's job.

2. **The browser never hits a backend directly.** All traffic is proxied through Next.js server
   route handlers (`app/api/chat/route.js`, `app/api/tags/route.js`) — avoids CORS for Ollama and
   keeps the Anthropic key server-side. `/api/tags` proxies Ollama `GET /api/tags`.

   **Per-provider shaping (in the route):** Ollama takes the system prompt as a leading `system`
   *message* and `temperature`/`num_ctx` as `options`; Anthropic takes system as a **top-level
   `system` param**, requires `max_tokens`, and **rejects `temperature`** (Opus 4.8/4.7 + Fable 400
   on it — so the route omits it). `Conversation.provider` is `"ollama" | "anthropic"`.

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
  inference.js        # client: neutral payload out, uniform stream parsed in
  store.js            # conversation state + versioned localStorage persistence
```

`app/api/chat/route.js` holds the per-provider branches (`ollamaChat`, `anthropicChat`) and the
uniform-stream normalizer. `.env.local` (gitignored) holds `ANTHROPIC_API_KEY`.

Resist early: component libraries, global state managers, auth, a database. (shadcn/ui is a fine
*later* choice for chrome polish, not part of the MVP.)

## Build process

Build in **vertical slices, in order, each runnable before moving on** — never leave the app in a
half-wired, non-running state. The PRD defines the slices: Slice 0 (prove the streaming proxy
route), Slice 1 (dumbest streaming chat, hardcoded model, `status` + `AbortController` wired in),
Slice 2 (real Conversation/Message shapes + versioned persistence), Slice 3 (model picker, system
prompt, params), Slice 4 (multi-conversation sidebar CRUD).

Post-MVP, slices A–C added the **Anthropic provider**: A (provider-neutral payload + server-side
uniform-stream normalizer), B (the `@anthropic-ai/sdk` route branch), C (provider-grouped picker +
per-provider params). Same vertical-slice discipline — each runnable, Ollama never broke.

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
