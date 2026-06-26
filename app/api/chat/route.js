// app/api/chat/route.js — proxy + stream to Ollama POST /api/chat.
//
// Dumb proxy by design: the server is STATELESS about the conversation. The client
// owns history and sends the full (already replay-filtered) messages array every
// request. We force stream:true, pass model/messages/options through, and pipe
// Ollama's NDJSON body straight back untouched — the SOLE parser lives client-side
// in lib/inference.js.
//
// Errors split two ways:
//   - pre-stream (unreachable, model_missing): we can still set an HTTP status + JSON
//   - mid-stream (interrupted): 200 already sent; detected client-side via stream close

import { OLLAMA_HOST } from "@/lib/config";

// nodejs runtime, not edge: edge can't reach localhost and we need Node streaming.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: { kind: "bad_request", message: "Invalid JSON body." } },
      { status: 400 },
    );
  }

  let upstream;
  try {
    upstream = await fetch(`${OLLAMA_HOST}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, stream: true }),
      // Client abort -> upstream abort, so Ollama stops burning tokens on Stop.
      signal: request.signal,
    });
  } catch (err) {
    if (err?.name === "AbortError") {
      // Client went away before we got a response; nothing to stream.
      return new Response(null, { status: 499 });
    }
    // Connection refused / DNS — Ollama isn't running or the host is wrong.
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
    // Pre-stream Ollama error (commonly: model not pulled -> 404).
    const text = await upstream.text().catch(() => "");
    const kind = /not found|no such model|try pulling/i.test(text)
      ? "model_missing"
      : "upstream_error";
    return Response.json(
      { error: { kind, message: text || `Ollama responded ${upstream.status}.` } },
      { status: upstream.status },
    );
  }

  // Happy path: pass NDJSON through verbatim.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}
