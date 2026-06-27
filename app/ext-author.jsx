"use client";

// app/ext-author.jsx — the "Create extension" dialog.
// prompt → generate (with repair loop) → live preview + code + requested capabilities → approve.

import { useRef, useState } from "react";
import { authorExtension } from "@/lib/ext-author";
import { ExtensionFrame } from "./panels";

export default function ExtAuthorDialog({ authoringModel, onApprove, onClose }) {
  const [prompt, setPrompt] = useState("");
  const [phase, setPhase] = useState("input"); // input | working | review | error
  const [status, setStatus] = useState("");
  const [result, setResult] = useState(null);
  const [errorObj, setErrorObj] = useState(null);
  const [showCode, setShowCode] = useState(false);
  const abortRef = useRef(null);

  async function generate() {
    const p = prompt.trim();
    if (!p) return;
    setPhase("working");
    setErrorObj(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const ext = await authorExtension({
        prompt: p,
        provider: authoringModel.provider,
        model: authoringModel.model,
        onStatus: setStatus,
        signal: controller.signal,
      });
      ext.id = crypto.randomUUID();
      ext.source_prompt = p;
      ext.author_model = authoringModel.model;
      setResult(ext);
      setPhase("review");
    } catch (e) {
      setErrorObj(e);
      setPhase("error");
    } finally {
      abortRef.current = null;
    }
  }

  function cancelWork() {
    abortRef.current?.abort();
    setPhase("input");
  }

  const btn =
    "rounded-xl px-3 py-2 text-sm font-medium disabled:opacity-40";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-white/15 bg-neutral-900 text-sm text-neutral-100 shadow-xl">
        <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <span className="font-medium">Create extension</span>
          <button onClick={onClose} className="opacity-60 hover:opacity-100">
            ✕
          </button>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          {phase === "input" && (
            <>
              <textarea
                autoFocus
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={4}
                placeholder="Describe a panel… e.g. “a sticky note that saves my text”, “a clock”, “a counter with reset”"
                className="w-full rounded-xl border border-white/15 bg-transparent px-3 py-2 outline-none focus:border-sky-400"
              />
              <p className="text-xs opacity-50">
                Built by <b>{authoringModel.model}</b>. Extensions can save data and set
                their title / show toasts. They run sandboxed — no file or network access.
              </p>
            </>
          )}

          {phase === "working" && (
            <div className="flex items-center gap-3 py-6">
              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
              <span>{status || "Working…"}</span>
            </div>
          )}

          {phase === "error" && (
            <div className="space-y-2">
              <p className="whitespace-pre-wrap rounded-lg border border-red-400/40 bg-red-500/10 px-3 py-2 text-red-300">
                {String(errorObj?.message || errorObj)}
              </p>
              <p className="text-xs opacity-50">
                authored by {authoringModel.provider}/{authoringModel.model}
              </p>
              {errorObj?.lastOutput && (
                <details className="text-xs opacity-70">
                  <summary className="cursor-pointer">last model output</summary>
                  <pre className="mt-1 max-h-56 overflow-auto rounded-lg bg-black/40 p-2 text-[11px] leading-snug">
                    {errorObj.lastOutput}
                  </pre>
                </details>
              )}
            </div>
          )}

          {phase === "review" && result && (
            <>
              <div className="rounded-xl border border-white/10 p-2">
                <ExtensionFrame ext={result} />
              </div>
              <div className="text-xs opacity-70">
                <b>{result.name}</b>
                {result.description ? ` — ${result.description}` : ""}
              </div>
              <div className="text-xs">
                Requests:{" "}
                <span className="opacity-80">
                  {result.manifest.length
                    ? result.manifest
                        .map((c) =>
                          c === "store" ? "save data" : c === "ui" ? "title + toasts" : c,
                        )
                        .join(", ")
                    : "no capabilities"}
                </span>
              </div>
              <button
                onClick={() => setShowCode((s) => !s)}
                className="text-xs underline opacity-60 hover:opacity-100"
              >
                {showCode ? "Hide" : "View"} code
              </button>
              {showCode && (
                <pre className="max-h-48 overflow-auto rounded-lg bg-black/40 p-2 text-[11px] leading-snug">
                  {result.code}
                </pre>
              )}
            </>
          )}
        </div>

        <footer className="flex justify-end gap-2 border-t border-white/10 px-4 py-3">
          {phase === "input" && (
            <button
              onClick={generate}
              disabled={!prompt.trim()}
              className={btn + " bg-emerald-500 text-white hover:bg-emerald-600"}
            >
              Generate
            </button>
          )}
          {phase === "working" && (
            <button
              onClick={cancelWork}
              className={btn + " bg-white/10 hover:bg-white/20"}
            >
              Cancel
            </button>
          )}
          {phase === "error" && (
            <button
              onClick={() => setPhase("input")}
              className={btn + " bg-white/10 hover:bg-white/20"}
            >
              Try again
            </button>
          )}
          {phase === "review" && result && (
            <>
              <button
                onClick={() => setPhase("input")}
                className={btn + " bg-white/10 hover:bg-white/20"}
              >
                Discard
              </button>
              <button
                onClick={() => onApprove(result)}
                className={btn + " bg-emerald-500 text-white hover:bg-emerald-600"}
              >
                Approve &amp; add
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
