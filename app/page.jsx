"use client";

// Slice 1 — dumbest possible streaming chat.
// Single page, hardcoded model, no history persistence yet. The "bones" are wired:
// message `status` lifecycle, an AbortController + Stop button, the full history resent
// every request (the server is stateless), and explicit error states. Partial assistant
// output is discarded on abort AND error; status lives only during the in-flight turn.

import { useEffect, useRef, useState } from "react";
import { streamChat, InferenceError } from "@/lib/inference";

const MODEL = "qwen2.5-coder:3b"; // hardcoded for Slice 1; the picker arrives in Slice 3

export default function Page() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState(null);
  const abortRef = useRef(null);
  const listRef = useRef(null);

  // Keep the latest turn in view as tokens stream in.
  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  const patch = (id, p) =>
    setMessages((ms) => ms.map((m) => (m.id === id ? { ...m, ...p } : m)));
  const drop = (id) => setMessages((ms) => ms.filter((m) => m.id !== id));

  async function send(e) {
    e?.preventDefault();
    const text = input.trim();
    if (!text || streaming) return;

    setError(null);
    const now = Date.now();
    const userMsg = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      status: "complete",
      createdAt: now,
    };
    const asstMsg = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      status: "streaming",
      createdAt: now,
    };

    // Resend the entire history; the replay filter inside inference.js decides what
    // actually goes upstream.
    const history = [...messages, userMsg];
    setMessages([...history, asstMsg]);
    setInput("");
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      let acc = "";
      for await (const delta of streamChat({
        messages: history,
        model: MODEL,
        signal: controller.signal,
      })) {
        acc += delta;
        patch(asstMsg.id, { content: acc });
      }
      patch(asstMsg.id, { status: "complete" });
    } catch (err) {
      const kind = err instanceof InferenceError ? err.kind : "unknown";
      // Discard the partial assistant turn on both abort and error.
      drop(asstMsg.id);
      if (kind !== "aborted") {
        setError({ kind, message: err.message });
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
        <span className="font-mono text-xs opacity-50">{MODEL}</span>
      </header>

      <div
        ref={listRef}
        className="flex-1 space-y-4 overflow-y-auto py-2"
      >
        {messages.length === 0 && (
          <p className="mt-10 text-center text-sm opacity-40">
            Start the conversation below.
          </p>
        )}
        {messages.map((m) => (
          <div
            key={m.id}
            className={m.role === "user" ? "flex justify-end" : "flex justify-start"}
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
            disabled={!input.trim()}
            className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-40"
          >
            Send
          </button>
        )}
      </form>
    </main>
  );
}
