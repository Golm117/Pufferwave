"use client";

// Slice 2 — real Conversation/Message shapes, persisted to localStorage (versioned).
// Still single-conversation: the store auto-creates one and the page reads/writes the
// active conversation through the hook. Streaming patches the assistant message in state
// but does NOT persist per delta; persistence happens when the turn completes (or on
// structural changes). Partial assistant turns are still discarded on abort/error.

import { useEffect, useMemo, useRef, useState } from "react";
import { streamChat, InferenceError } from "@/lib/inference";
import { useChatStore, makeMessage, logFailure } from "@/lib/store";

export default function Page() {
  const { hydrated, active, addMessage, patchMessage, removeMessage } =
    useChatStore();
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);
  const listRef = useRef(null);

  const messages = useMemo(() => active?.messages ?? [], [active]);
  const model = active?.model ?? "";

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  async function send(e) {
    e?.preventDefault();
    const text = input.trim();
    if (!text || streaming || !active) return;

    setError(null);
    const userMsg = makeMessage("user", text, "complete");
    const asstMsg = makeMessage("assistant", "", "streaming");

    // Resend the entire history; the replay filter in inference.js decides what goes
    // upstream. Build the array locally — state updates are async.
    const history = [...messages, userMsg];
    addMessage(userMsg); // persist the user turn
    addMessage(asstMsg, { persist: false }); // placeholder never persisted
    setInput("");
    setStreaming(true);

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
        acc += delta;
        patchMessage(asstMsg.id, { content: acc }, { persist: false });
      }
      patchMessage(asstMsg.id, { status: "complete" }); // terminal -> persist
    } catch (err) {
      const kind = err instanceof InferenceError ? err.kind : "unknown";
      removeMessage(asstMsg.id); // discard the partial
      if (kind !== "aborted") {
        setError({ kind, message: err.message });
        logFailure({ kind, message: err.message, model });
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  return (
    <main className="mx-auto flex h-dvh w-full max-w-2xl flex-col px-4">
      <header className="flex items-center justify-between py-4">
        <h1 className="bg-gradient-to-r from-sky-400 via-emerald-400 to-amber-400 bg-clip-text text-xl font-light tracking-[0.35em] text-transparent">
          PUFFERWAVE
        </h1>
        <span className="font-mono text-xs opacity-50">{model}</span>
      </header>

      <div ref={listRef} className="flex-1 space-y-4 overflow-y-auto py-2">
        {hydrated && messages.length === 0 && (
          <p className="mt-10 text-center text-sm opacity-40">
            Start the conversation below.
          </p>
        )}
        {messages.map((m) => (
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
              {m.content}
              {m.role === "assistant" && m.status === "streaming" && (
                <span className="ml-0.5 inline-block animate-pulse">▍</span>
              )}
            </div>
          </div>
        ))}
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
          className="flex-1 rounded-xl border border-black/10 bg-transparent px-4 py-2 text-sm outline-none focus:border-sky-400 dark:border-white/15"
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
