"use client";

// Slice 3 — control surface. Model picker (populated from /api/tags), system-prompt
// field, and temperature/num_ctx params — all per-conversation, written through the
// store. A cold-start loading state covers the pause while Ollama loads a model's
// weights on the first message (it's not an error).

import { useEffect, useMemo, useRef, useState } from "react";
import { streamChat, listModels, InferenceError } from "@/lib/inference";
import { useChatStore, makeMessage, logFailure } from "@/lib/store";

export default function Page() {
  const { hydrated, active, addMessage, patchMessage, removeMessage, setActiveField } =
    useChatStore();
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [waitingFirstToken, setWaitingFirstToken] = useState(false);
  const [error, setError] = useState(null);
  const [models, setModels] = useState([]);
  const [modelsError, setModelsError] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const abortRef = useRef(null);
  const listRef = useRef(null);

  const messages = useMemo(() => active?.messages ?? [], [active]);
  const model = active?.model ?? "";
  const params = active?.params ?? {};

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, waitingFirstToken]);

  // Load the installed-model list once hydrated. ollama pull <name> -> appears here.
  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    listModels()
      .then((names) => !cancelled && (setModels(names), setModelsError(false)))
      .catch(() => !cancelled && setModelsError(true));
    return () => {
      cancelled = true;
    };
  }, [hydrated]);

  function setParam(key, raw) {
    const next = { ...params };
    if (raw === "" || raw == null) delete next[key];
    else next[key] = Number(raw);
    setActiveField("params", next);
  }

  async function send(e) {
    e?.preventDefault();
    const text = input.trim();
    if (!text || streaming || !active) return;

    setError(null);
    const userMsg = makeMessage("user", text, "complete");
    const asstMsg = makeMessage("assistant", "", "streaming");

    const history = [...messages, userMsg];
    addMessage(userMsg);
    addMessage(asstMsg, { persist: false });
    setInput("");
    setStreaming(true);
    setWaitingFirstToken(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      let acc = "";
      for await (const delta of streamChat({
        messages: history,
        model,
        systemPrompt: active.systemPrompt,
        params: active.params,
        signal: controller.signal,
      })) {
        if (acc === "") setWaitingFirstToken(false); // first token arrived
        acc += delta;
        patchMessage(asstMsg.id, { content: acc }, { persist: false });
      }
      patchMessage(asstMsg.id, { status: "complete" });
    } catch (err) {
      const kind = err instanceof InferenceError ? err.kind : "unknown";
      removeMessage(asstMsg.id);
      if (kind !== "aborted") {
        setError({ kind, message: err.message });
        logFailure({ kind, message: err.message, model });
      }
    } finally {
      setStreaming(false);
      setWaitingFirstToken(false);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  const inputCls =
    "rounded-xl border border-black/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-sky-400 dark:border-white/15";

  return (
    <main className="mx-auto flex h-dvh w-full max-w-2xl flex-col px-4">
      <header className="flex items-center justify-between gap-3 py-4">
        <h1 className="bg-gradient-to-r from-sky-400 via-emerald-400 to-amber-400 bg-clip-text text-xl font-light tracking-[0.35em] text-transparent">
          PUFFERWAVE
        </h1>
        <div className="flex items-center gap-2">
          <select
            value={model}
            onChange={(e) => setActiveField("model", e.target.value)}
            disabled={streaming || !hydrated}
            className={inputCls + " max-w-[14rem] disabled:opacity-50"}
            title={modelsError ? "Couldn’t load model list" : "Model"}
          >
            {model && !models.includes(model) && (
              <option value={model}>{model} (not installed)</option>
            )}
            {models.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setShowSettings((s) => !s)}
            className={inputCls + " opacity-70 hover:opacity-100"}
            aria-expanded={showSettings}
            title="Settings"
          >
            ⚙
          </button>
        </div>
      </header>

      {modelsError && (
        <p className="mb-2 text-xs text-amber-600 dark:text-amber-400">
          Couldn’t load the model list — is Ollama running? You can still send with the
          current model.
        </p>
      )}

      {showSettings && active && (
        <div className="mb-3 space-y-3 rounded-xl border border-black/10 p-3 dark:border-white/15">
          <label className="block">
            <span className="mb-1 block text-xs opacity-60">System prompt</span>
            <textarea
              value={active.systemPrompt}
              onChange={(e) => setActiveField("systemPrompt", e.target.value)}
              rows={3}
              placeholder="Optional — steers the assistant."
              className={inputCls + " w-full resize-y"}
            />
          </label>
          <div className="flex gap-3">
            <label className="flex-1">
              <span className="mb-1 block text-xs opacity-60">temperature</span>
              <input
                type="number"
                step="0.1"
                min="0"
                max="2"
                value={params.temperature ?? ""}
                onChange={(e) => setParam("temperature", e.target.value)}
                placeholder="model default"
                className={inputCls + " w-full"}
              />
            </label>
            <label className="flex-1">
              <span className="mb-1 block text-xs opacity-60">num_ctx</span>
              <input
                type="number"
                step="512"
                min="0"
                value={params.num_ctx ?? ""}
                onChange={(e) => setParam("num_ctx", e.target.value)}
                placeholder="model default"
                className={inputCls + " w-full"}
              />
            </label>
          </div>
        </div>
      )}

      <div ref={listRef} className="flex-1 space-y-4 overflow-y-auto py-2">
        {hydrated && messages.length === 0 && (
          <p className="mt-10 text-center text-sm opacity-40">
            Start the conversation below.
          </p>
        )}
        {messages.map((m) => {
          const coldStart =
            m.role === "assistant" && m.status === "streaming" && m.content === "";
          return (
            <div
              key={m.id}
              className={
                m.role === "user" ? "flex justify-end" : "flex justify-start"
              }
            >
              <div
                className={
                  "max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm " +
                  (m.role === "user"
                    ? "bg-sky-500 text-white"
                    : "bg-black/5 dark:bg-white/10")
                }
              >
                {coldStart ? (
                  <span className="opacity-50">Loading {model}…</span>
                ) : (
                  <>
                    {m.content}
                    {m.role === "assistant" && m.status === "streaming" && (
                      <span className="ml-0.5 inline-block animate-pulse">▍</span>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {error && (
        <div className="mb-2 flex items-start justify-between gap-3 rounded-lg border border-red-400/40 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          <span>{error.message}</span>
          <button
            onClick={() => setError(null)}
            className="shrink-0 opacity-60 hover:opacity-100"
            aria-label="Dismiss error"
          >
            ✕
          </button>
        </div>
      )}

      <form onSubmit={send} className="flex gap-2 pb-4">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Message…"
          className={"flex-1 " + inputCls}
        />
        {streaming ? (
          <button
            type="button"
            onClick={stop}
            className="rounded-xl bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-600"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={!input.trim() || !hydrated}
            className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-40"
          >
            Send
          </button>
        )}
      </form>
    </main>
  );
}
