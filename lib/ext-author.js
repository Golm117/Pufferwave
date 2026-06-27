"use client";

// lib/ext-author.js — turn a prompt into a working extension.
//
// Generates against the extension contract using Pufferwave's own LLM, then runs the
// generate → load-test-in-preview → repair loop (≤ MAX_ATTEMPTS) so the caller only ever
// sees an extension that actually renders. Returns { name, description, manifest, code }.

import { streamChat } from "./inference";
import { previewExtension } from "./ext-runtime";

const MAX_ATTEMPTS = 3;

const SYSTEM_PROMPT = `You write small UI "extensions" for Pufferwave, a desktop app. An extension is ONE JavaScript function that renders a panel using Preact + htm. It runs in a sandboxed iframe with NO access to the network, filesystem, or any APIs except the host capabilities listed below.

OUTPUT FORMAT — return EXACTLY two fenced blocks and nothing else (no prose):
1. A \`\`\`json block: {"name": string, "description": string, "manifest": string[]}
2. A \`\`\`js block containing: function Extension() { ... }

THE CODE CONTRACT:
- Define exactly: function Extension() { ... }  — no arguments, no imports, no exports, no module wrapper.
- These are available as GLOBALS (do NOT import or redeclare them):
  - html — an htm tag bound to Preact. Usage: html\`<div>Hello \${name}</div>\`. Events: html\`<button onClick=\${fn}>Go</button>\`. Use \${...} for interpolation.
  - useState, useEffect, useRef, useMemo — Preact hooks (call at the top level of Extension()).
  - host — async capabilities; EVERY method returns a Promise, so await them:
      host.store.get(key) -> string|null      // persists across launches; returns null when unset
      host.store.set(key, value)
      host.store.delete(key)
      host.ui.setTitle(text)
      host.ui.notify(text)                     // shows a toast
- "manifest" must list EXACTLY the capability namespaces you use. Allowed values: "store", "ui".
- Styling: use inline style="" attributes (e.g. style="display:flex;flex-direction:column;gap:8px"). The theme is dark; text color is inherited. Buttons/inputs have basic styles.
- Forbidden: external libraries, fetch/XHR, window/document/localStorage, setInterval longer than a few seconds without cleanup, any capability not listed above.
- Handle async loading: host.store.get is async — render a loading state until it resolves.

Return ONLY the two fenced blocks.`;

function parse(text) {
  // Extract every fenced block (```lang\n ... ```), language-agnostic so "```json"
  // can't be mistaken for "```js".
  const blocks = [...text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((m) =>
    m[1].trim(),
  );

  // The code block is the one that actually defines Extension().
  const code = blocks.find((b) => /function\s+Extension\s*\(/.test(b));
  if (!code) return null;

  // The metadata block is the first one that parses as a JSON object.
  let meta = {};
  for (const b of blocks) {
    if (b.startsWith("{")) {
      try {
        meta = JSON.parse(b);
        break;
      } catch {
        /* not it */
      }
    }
  }

  const manifest = Array.isArray(meta.manifest)
    ? meta.manifest.filter((x) => x === "store" || x === "ui")
    : inferManifest(code);

  return {
    name: (meta.name || "Extension").slice(0, 60),
    description: (meta.description || "").slice(0, 200),
    manifest,
    code,
  };
}

function inferManifest(code) {
  const m = [];
  if (/\bhost\.store\b/.test(code)) m.push("store");
  if (/\bhost\.ui\b/.test(code)) m.push("ui");
  return m;
}

async function generate({ provider, model, messages, signal }) {
  let full = "";
  for await (const delta of streamChat({
    provider,
    model,
    systemPrompt: SYSTEM_PROMPT,
    params: { max_tokens: 4000 },
    messages,
    signal,
  })) {
    full += delta;
  }
  return full;
}

export async function authorExtension({ prompt, provider, model, onStatus, signal }) {
  const messages = [{ role: "user", content: prompt }];
  let lastOutput = "";
  let lastDetail = "no output from the model";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    onStatus?.(attempt === 1 ? "Generating…" : `Fixing… (${attempt}/${MAX_ATTEMPTS})`);
    const full = await generate({ provider, model, messages, signal });
    lastOutput = full;
    const parsed = parse(full);

    if (!parsed) {
      lastDetail = "model did not return a valid ```js block with function Extension()";
      messages.push({ role: "assistant", content: full });
      messages.push({
        role: "user",
        content:
          "That wasn't valid: return ONLY a ```json metadata block and a ```js block with `function Extension() { ... }`.",
      });
      continue;
    }

    onStatus?.("Testing…");
    const test = await previewExtension(parsed);
    if (test.ok) return parsed;

    lastDetail = `preview failed: ${test.error}`;
    messages.push({ role: "assistant", content: full });
    messages.push({
      role: "user",
      content: `The extension failed to render with this error:\n${test.error}\nFix the code and return the same two fenced blocks.`,
    });
  }

  const err = new Error(
    `Couldn't generate a working extension after ${MAX_ATTEMPTS} attempts — ${lastDetail}`,
  );
  err.lastOutput = lastOutput;
  throw err;
}
