// app/api/tags/route.js — proxy to Ollama GET /api/tags (installed model list).
//
// Same proxy discipline as /api/chat: nodejs runtime, browser never hits 11434.
// `ollama pull <name>` makes a model appear here with no code change.

import { OLLAMA_HOST } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let upstream;
  try {
    upstream = await fetch(`${OLLAMA_HOST}/api/tags`);
  } catch {
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
    return Response.json(
      {
        error: {
          kind: "upstream_error",
          message: text || `Ollama responded ${upstream.status}.`,
        },
      },
      { status: upstream.status },
    );
  }

  return Response.json(await upstream.json());
}
