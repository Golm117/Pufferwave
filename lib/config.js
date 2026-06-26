// lib/config.js — server-only.
//
// Single source of truth for the inference backend endpoint. Per the load-bearing
// architecture rule, the backend endpoint is ONE config value, never hardcoded at
// call sites. Swapping Ollama for llama-server / an AirLLM shim later is a change
// here, not a refactor across the app.
//
// Read only in server route handlers — the browser never sees this and never hits
// port 11434 directly (CORS is avoided by proxying through Next.js routes).

export const OLLAMA_HOST =
  process.env.OLLAMA_HOST?.replace(/\/+$/, "") || "http://localhost:11434";
