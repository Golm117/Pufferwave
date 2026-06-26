// lib/inference.js — ALL inference backend calls live here.
//
// The one architectural rule: no React component talks to the backend directly.
// Request shaping, the replay filter, NDJSON parsing, error classification, and the
// abort signal all live in this single module. The browser calls our own /api/chat
// proxy (never port 11434 directly); a future backend swap is a change to the proxy +
// this module, not a refactor across the app.

// Typed error so the caller can map a failure KIND to both a plain-language UI message
// and (later) a failure-log entry. kind is the load-bearing field.
export class InferenceError extends Error {
  constructor(kind, message, cause) {
    super(message);
    this.name = "InferenceError";
    this.kind = kind; // unreachable | model_missing | interrupted | aborted | unknown
    this.cause = cause;
    this.at = Date.now();
  }
}

function messageForKind(kind, detail) {
  switch (kind) {
    case "unreachable":
      return "Can’t reach Ollama. Is it running? Try: ollama serve";
    case "model_missing":
      return "That model isn’t installed. Try: ollama pull <model>";
    case "interrupted":
      return "The response was interrupted before it finished.";
    case "aborted":
      return "Generation stopped.";
    default:
      return detail || "Something went wrong talking to the model.";
  }
}

// The replay filter (decision: prevents context drift). Only finished turns are sent
// upstream: all user/system turns, plus assistant turns that reached status "complete".
// Streaming/queued/aborted/errored assistant turns are display-only and never replayed.
// The system prompt is injected here from the conversation field — it is NOT stored as a
// Message in the history.
function toWirePayload(messages, systemPrompt) {
  const wire = [];
  if (systemPrompt && systemPrompt.trim()) {
    wire.push({ role: "system", content: systemPrompt });
  }
  for (const m of messages) {
    if (m.role === "user" || m.role === "system") {
      wire.push({ role: m.role, content: m.content });
    } else if (m.role === "assistant" && m.status === "complete") {
      wire.push({ role: "assistant", content: m.content });
    }
  }
  return wire;
}

// Only send params the user actually set — never override the model's own defaults.
function pickOptions(params) {
  if (!params) return null;
  const o = {};
  if (params.temperature != null && params.temperature !== "") {
    o.temperature = Number(params.temperature);
  }
  if (params.num_ctx != null && params.num_ctx !== "") {
    o.num_ctx = Number(params.num_ctx);
  }
  return Object.keys(o).length ? o : null;
}

// Installed model list, via our /api/tags proxy. Returns sorted model names.
// Throws a typed InferenceError so the caller can distinguish "Ollama is down" from
// "Ollama is up but has no models".
export async function listModels() {
  let res;
  try {
    res = await fetch("/api/tags");
  } catch (err) {
    throw new InferenceError("unreachable", messageForKind("unreachable"), err);
  }
  if (!res.ok) {
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      /* non-JSON */
    }
    const kind = payload?.error?.kind || "unknown";
    throw new InferenceError(kind, messageForKind(kind, payload?.error?.message));
  }
  const data = await res.json();
  return (data.models || []).map((m) => m.name).sort();
}

// Async generator: yields assistant content deltas (strings) as they arrive.
// Caller: `for await (const delta of streamChat(...)) { ... }`. Aborting the passed
// signal makes the underlying fetch reject; we surface that as InferenceError("aborted").
export async function* streamChat({
  messages,
  model,
  params,
  systemPrompt = "",
  signal,
}) {
  const options = pickOptions(params);
  const body = {
    model,
    messages: toWirePayload(messages, systemPrompt),
    ...(options ? { options } : {}),
  };

  let res;
  try {
    res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new InferenceError("aborted", messageForKind("aborted"), err);
    }
    throw new InferenceError("unreachable", messageForKind("unreachable"), err);
  }

  if (!res.ok) {
    // Pre-stream error from our proxy: { error: { kind, message } }.
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      /* non-JSON error body */
    }
    const kind = payload?.error?.kind || "unknown";
    throw new InferenceError(kind, messageForKind(kind, payload?.error?.message));
  }

  // Parse Ollama's NDJSON: one JSON object per line. Chunks can split mid-line, so we
  // buffer and split on newlines. delta = message.content; stop on done:true.
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let sawDone = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;

        let obj;
        try {
          obj = JSON.parse(line);
        } catch {
          continue; // ignore unparseable partials
        }
        if (obj.error) {
          throw new InferenceError("interrupted", obj.error);
        }
        const delta = obj.message?.content;
        if (delta) yield delta;
        if (obj.done) {
          sawDone = true;
          return;
        }
      }
    }
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new InferenceError("aborted", messageForKind("aborted"), err);
    }
    if (err instanceof InferenceError) throw err;
    throw new InferenceError("interrupted", messageForKind("interrupted"), err);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }

  // Stream closed without a done:true line — the response was cut off.
  if (!sawDone) {
    throw new InferenceError("interrupted", messageForKind("interrupted"));
  }
}
