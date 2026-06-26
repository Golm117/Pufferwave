// lib/inference.js — ALL inference backend calls live here.
//
// The one architectural rule: no React component talks to the backend directly. The
// client sends a PROVIDER-NEUTRAL payload to our /api/chat proxy; the route shapes the
// real request per provider (Ollama vs Anthropic) and normalizes the response into ONE
// uniform stream format. So this module has a single parser regardless of backend.
//
// Uniform stream = NDJSON, one JSON object per line:
//   {"type":"delta","text":"..."}   incremental assistant text
//   {"type":"done"}                  stream finished cleanly
//   {"type":"error","kind":"...","message":"..."}   mid-stream failure

export class InferenceError extends Error {
  constructor(kind, message, cause) {
    super(message);
    this.name = "InferenceError";
    this.kind = kind; // unreachable | model_missing | auth | rate_limited | interrupted | aborted | unknown
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
    case "auth":
      return "Anthropic API key missing or invalid — set ANTHROPIC_API_KEY.";
    case "rate_limited":
      return "Rate limited by Anthropic — wait a moment and retry.";
    case "interrupted":
      return "The response was interrupted before it finished.";
    case "aborted":
      return "Generation stopped.";
    default:
      return detail || "Something went wrong talking to the model.";
  }
}

// The replay filter (prevents context drift): only finished turns are replayed — all
// user/system turns, plus assistant turns that reached status "complete". The system
// prompt is NOT injected here; it rides as a separate field and the route maps it
// per-provider (Ollama: a system message; Anthropic: the top-level `system` param).
function toWirePayload(messages) {
  const wire = [];
  for (const m of messages) {
    if (m.role === "user" || m.role === "system") {
      wire.push({ role: m.role, content: m.content });
    } else if (m.role === "assistant" && m.status === "complete") {
      wire.push({ role: "assistant", content: m.content });
    }
  }
  return wire;
}

// Installed Ollama model list, via our /api/tags proxy. Returns sorted model names.
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
// Sends a provider-neutral payload; the route does provider dispatch + normalization.
export async function* streamChat({
  messages,
  model,
  params,
  systemPrompt = "",
  provider = "ollama",
  signal,
}) {
  const body = {
    provider,
    model,
    systemPrompt,
    params: params || {},
    messages: toWirePayload(messages),
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
    // Pre-stream error from the route: { error: { kind, message } }.
    let payload = null;
    try {
      payload = await res.json();
    } catch {
      /* non-JSON */
    }
    const kind = payload?.error?.kind || "unknown";
    throw new InferenceError(kind, messageForKind(kind, payload?.error?.message));
  }

  // Parse the uniform NDJSON stream. Chunks can split mid-line, so buffer and split
  // on newlines.
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

        let evt;
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }
        if (evt.type === "delta") {
          if (evt.text) yield evt.text;
        } else if (evt.type === "done") {
          sawDone = true;
          return;
        } else if (evt.type === "error") {
          throw new InferenceError(
            evt.kind || "unknown",
            messageForKind(evt.kind, evt.message),
          );
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

  if (!sawDone) {
    throw new InferenceError("interrupted", messageForKind("interrupted"));
  }
}
