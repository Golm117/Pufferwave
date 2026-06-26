// app/api/chat/route.js — provider dispatch + stream normalization.
//
// Accepts a provider-neutral payload from the client:
//   { provider, model, systemPrompt, params, messages }
// Shapes the real request per provider and normalizes the response into ONE uniform
// NDJSON stream so lib/inference.js has a single parser:
//   {"type":"delta","text":"..."} | {"type":"done"} | {"type":"error",kind,message}
//
// Pre-stream failures (unreachable, model_missing) still return an HTTP status + JSON so
// the client can throw the right error kind before any 200 stream is opened. Once the
// stream is open, mid-stream failures surface as a uniform error line.

import Anthropic from "@anthropic-ai/sdk";
import { OLLAMA_HOST } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;

const enc = new TextEncoder();

// Wrap an async generator of uniform events into an NDJSON streaming Response.
function uniformResponse(makeEvents) {
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const evt of makeEvents()) {
          controller.enqueue(enc.encode(JSON.stringify(evt) + "\n"));
        }
      } catch (err) {
        if (err?.name !== "AbortError") {
          controller.enqueue(
            enc.encode(
              JSON.stringify({
                type: "error",
                kind: "interrupted",
                message: String(err?.message || err),
              }) + "\n",
            ),
          );
        }
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}

export async function POST(request) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return Response.json(
      { error: { kind: "bad_request", message: "Invalid JSON body." } },
      { status: 400 },
    );
  }

  const { provider = "ollama" } = payload;
  if (provider === "ollama") return ollamaChat(payload, request.signal);
  if (provider === "anthropic") return anthropicChat(payload, request.signal);
  return Response.json(
    {
      error: {
        kind: "bad_request",
        message: `Unknown provider “${provider}”.`,
      },
    },
    { status: 400 },
  );
}

// --- Ollama ---

function ollamaOptions(params) {
  const o = {};
  if (params?.temperature != null && params.temperature !== "") {
    o.temperature = Number(params.temperature);
  }
  if (params?.num_ctx != null && params.num_ctx !== "") {
    o.num_ctx = Number(params.num_ctx);
  }
  return Object.keys(o).length ? o : null;
}

async function ollamaChat({ model, systemPrompt, params, messages }, signal) {
  // Ollama takes the system prompt as a leading system MESSAGE.
  const wire = [];
  if (systemPrompt && systemPrompt.trim()) {
    wire.push({ role: "system", content: systemPrompt });
  }
  for (const m of messages || []) wire.push({ role: m.role, content: m.content });

  const options = ollamaOptions(params);
  const body = {
    model,
    messages: wire,
    stream: true,
    ...(options ? { options } : {}),
  };

  let upstream;
  try {
    upstream = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") return new Response(null, { status: 499 });
    return Response.json(
      {
        error: {
          kind: "unreachable",
          message: `Cannot reach Ollama at ${OLLAMA_HOST}. Is \`ollama serve\` running?`,
        },
      },
      { status: 502 },
    );
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => "");
    const kind = /not found|no such model|try pulling/i.test(text)
      ? "model_missing"
      : "upstream_error";
    return Response.json(
      { error: { kind, message: text || `Ollama responded ${upstream.status}.` } },
      { status: upstream.status },
    );
  }

  // Translate Ollama's NDJSON into the uniform stream.
  return uniformResponse(() => translateOllama(upstream.body));
}

async function* translateOllama(body) {
  const reader = body.getReader();
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
          continue;
        }
        if (obj.error) {
          yield { type: "error", kind: "interrupted", message: obj.error };
          return;
        }
        const delta = obj.message?.content;
        if (delta) yield { type: "delta", text: delta };
        if (obj.done) {
          sawDone = true;
          yield { type: "done" };
          return;
        }
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }

  if (!sawDone) {
    yield {
      type: "error",
      kind: "interrupted",
      message: "The stream ended unexpectedly.",
    };
  }
}

// --- Anthropic (official SDK, server-side) ---

function mapAnthropicError(err) {
  // SDK APIError carries the parsed body on err.error: { type, error: { type, message } }.
  const message =
    err?.error?.error?.message || err?.message || "Anthropic request failed.";
  const status = err?.status;
  if (status === 401 || status === 403) return { kind: "auth", message };
  if (status === 429) return { kind: "rate_limited", message };
  if (status >= 500) return { kind: "interrupted", message };
  // 404 (bad model) / 400 (bad request) — surface Anthropic's own message, not the
  // Ollama-flavored model_missing hint.
  return { kind: "unknown", message };
}

async function anthropicChat({ model, systemPrompt, params, messages }, signal) {
  // Secret stays server-side; never touches the browser or localStorage.
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    return Response.json(
      {
        error: {
          kind: "auth",
          message: "ANTHROPIC_API_KEY is not set on the server (.env.local).",
        },
      },
      { status: 401 },
    );
  }

  // Anthropic takes system as a TOP-LEVEL param (not a message). Messages are user/
  // assistant only, content as strings. No temperature — Opus 4.8/4.7 and Fable 5 400 on it.
  const wire = (messages || [])
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: m.content }));

  const maxTokens =
    params?.max_tokens != null && params.max_tokens !== ""
      ? Number(params.max_tokens)
      : ANTHROPIC_DEFAULT_MAX_TOKENS;

  const body = {
    model,
    max_tokens: maxTokens,
    messages: wire,
    ...(systemPrompt && systemPrompt.trim() ? { system: systemPrompt } : {}),
  };

  const client = new Anthropic();

  return uniformResponse(async function* () {
    try {
      const stream = client.messages.stream(body, { signal });
      for await (const event of stream) {
        if (
          event.type === "content_block_delta" &&
          event.delta?.type === "text_delta" &&
          event.delta.text
        ) {
          yield { type: "delta", text: event.delta.text };
        }
      }
      yield { type: "done" };
    } catch (err) {
      if (err?.name === "AbortError" || signal?.aborted) return; // client stopped
      const { kind, message } = mapAnthropicError(err);
      yield { type: "error", kind, message };
    }
  });
}
