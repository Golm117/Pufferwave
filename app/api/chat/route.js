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

import { OLLAMA_HOST } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
  // Anthropic lands in Slice B.
  return Response.json(
    {
      error: {
        kind: "bad_request",
        message: `Provider “${provider}” is not available yet.`,
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
