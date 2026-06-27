"use client";

// Slice 4 — multi-conversation. Sidebar to create / switch / rename / delete chats;
// switching restores that conversation's model, system prompt, and params (they live on
// the Conversation). First user message auto-titles the chat. Cancel -> retract-to-input:
// clicking the last user turn (when idle) pulls its text back into the box and drops it
// plus any trailing assistant reply.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  streamChat,
  listModels,
  InferenceError,
  isDesktop,
  setAnthropicKey,
  anthropicKeySet,
  clearAnthropicKey,
} from "@/lib/inference";
import { useChatStore, makeMessage, logFailure } from "@/lib/store";

function deriveTitle(text) {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > 40 ? t.slice(0, 40).trimEnd() + "…" : t;
}

// Curated Anthropic models (the picker lists these without an API round-trip).
const ANTHROPIC_MODELS = [
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
];

export default function Page() {
  const store = useChatStore();
  const {
    hydrated,
    active,
    activeId,
    conversations,
    addMessage,
    patchMessage,
    removeMessage,
    retractFrom,
    setActiveField,
    selectConversation,
    createConversation,
    deleteConversation,
    renameConversation,
  } = store;

  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState(null);
  const [models, setModels] = useState([]);
  const [modelsError, setModelsError] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editTitle, setEditTitle] = useState("");
  const [keySet, setKeySet] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const desktop = isDesktop();
  const abortRef = useRef(null);
  const listRef = useRef(null);
  const inputRef = useRef(null);

  const messages = useMemo(() => active?.messages ?? [], [active]);
  const provider = active?.provider ?? "ollama";
  const model = active?.model ?? "";
  const params = active?.params ?? {};

  const lastUserId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") return messages[i].id;
    }
    return null;
  }, [messages]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

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

  // Desktop only: reflect whether the Anthropic key is in the keychain.
  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    anthropicKeySet()
      .then((v) => !cancelled && setKeySet(!!v))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [desktop]);

  async function saveKey() {
    const k = keyInput.trim();
    if (!k) return;
    try {
      await setAnthropicKey(k);
      setKeySet(true);
      setKeyInput("");
    } catch {
      /* surfaced on next send as an auth error */
    }
  }

  async function clearKey() {
    try {
      await clearAnthropicKey();
      setKeySet(false);
    } catch {
      /* no-op */
    }
  }

  function setParam(key, raw) {
    const next = { ...params };
    if (raw === "" || raw == null) delete next[key];
    else next[key] = Number(raw);
    setActiveField("params", next);
  }

  // Picker values are "<provider>::<model>" (model names contain single colons).
  function selectModel(value) {
    const i = value.indexOf("::");
    setActiveField("provider", value.slice(0, i));
    setActiveField("model", value.slice(i + 2));
  }

  async function send(e) {
    e?.preventDefault();
    const text = input.trim();
    if (!text || streaming || !active) return;

    setError(null);
    const userMsg = makeMessage("user", text, "complete");
    const asstMsg = makeMessage("assistant", "", "streaming");

    const history = [...messages, userMsg];
    if (messages.length === 0) setActiveField("title", deriveTitle(text)); // auto-title
    addMessage(userMsg);
    addMessage(asstMsg, { persist: false });
    setInput("");
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      let acc = "";
      for await (const delta of streamChat({
        messages: history,
        provider: active.provider,
        model,
        systemPrompt: active.systemPrompt,
        params: active.params,
        signal: controller.signal,
      })) {
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
      abortRef.current = null;
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  // Retract the last user turn back into the input box (idle only).
  function retract(msgId, content) {
    if (streaming) return;
    retractFrom(msgId);
    setInput(content);
    inputRef.current?.focus();
  }

  function commitRename(id) {
    const t = editTitle.trim();
    if (t) renameConversation(id, t);
    setEditingId(null);
  }

  const inputCls =
    "rounded-xl border border-black/10 bg-transparent px-3 py-2 text-sm outline-none focus:border-sky-400 dark:border-white/15";

  return (
    <div className="flex h-dvh w-full">
      {/* Sidebar */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-black/10 dark:border-white/10">
        <div className="p-3">
          <button
            type="button"
            onClick={createConversation}
            disabled={!hydrated}
            className="w-full rounded-xl bg-emerald-500 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-40"
          >
            + New chat
          </button>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto px-2 pb-3">
          {conversations.map((c) => {
            const isActive = c.id === activeId;
            return (
              <div
                key={c.id}
                onClick={() => selectConversation(c.id)}
                className={
                  "group flex cursor-pointer items-center gap-1 rounded-lg px-2 py-1.5 text-sm " +
                  (isActive
                    ? "bg-black/10 dark:bg-white/15"
                    : "hover:bg-black/5 dark:hover:bg-white/5")
                }
              >
                {editingId === c.id ? (
                  <input
                    autoFocus
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onBlur={() => commitRename(c.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename(c.id);
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    className="min-w-0 flex-1 rounded border border-sky-400 bg-transparent px-1 py-0.5 text-sm outline-none"
                  />
                ) : (
                  <span
                    className="min-w-0 flex-1 truncate"
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      setEditingId(c.id);
                      setEditTitle(c.title);
                    }}
                    title={c.title}
                  >
                    {c.title}
                  </span>
                )}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(`Delete “${c.title}”?`)) deleteConversation(c.id);
                  }}
                  className="shrink-0 opacity-0 transition-opacity hover:text-red-500 group-hover:opacity-60"
                  aria-label="Delete conversation"
                >
                  ✕
                </button>
              </div>
            );
          })}
        </nav>
      </aside>

      {/* Chat column */}
      <main className="mx-auto flex h-dvh w-full max-w-2xl flex-col px-4">
        <header className="flex items-center justify-between gap-3 py-4">
          <h1 className="bg-gradient-to-r from-sky-400 via-emerald-400 to-amber-400 bg-clip-text text-xl font-light tracking-[0.35em] text-transparent">
            PUFFERWAVE
          </h1>
          <div className="flex items-center gap-2">
            <select
              value={`${provider}::${model}`}
              onChange={(e) => selectModel(e.target.value)}
              disabled={streaming || !hydrated}
              className={inputCls + " max-w-[15rem] disabled:opacity-50"}
              title="Provider / model"
            >
              {model &&
                !(provider === "ollama" && models.includes(model)) &&
                !(provider === "anthropic" && ANTHROPIC_MODELS.includes(model)) && (
                  <option value={`${provider}::${model}`}>
                    {model}
                    {provider === "ollama" ? " (not installed)" : ""}
                  </option>
                )}
              <optgroup label="Ollama (local)">
                {models.map((n) => (
                  <option key={`o:${n}`} value={`ollama::${n}`}>
                    {n}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Anthropic (cloud)">
                {ANTHROPIC_MODELS.map((m) => (
                  <option key={`a:${m}`} value={`anthropic::${m}`}>
                    {m}
                  </option>
                ))}
              </optgroup>
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
            {provider === "anthropic" ? (
              <div className="space-y-3">
                {desktop ? (
                  <div>
                    <span className="mb-1 block text-xs opacity-60">
                      Anthropic API key{" "}
                      <span className={keySet ? "text-emerald-500" : "text-amber-500"}>
                        ({keySet ? "set — stored in your keychain" : "not set"})
                      </span>
                    </span>
                    <div className="flex gap-2">
                      <input
                        type="password"
                        value={keyInput}
                        onChange={(e) => setKeyInput(e.target.value)}
                        placeholder={keySet ? "Replace key…" : "sk-ant-…"}
                        className={inputCls + " w-full"}
                      />
                      <button
                        type="button"
                        onClick={saveKey}
                        disabled={!keyInput.trim()}
                        className="rounded-xl bg-emerald-500 px-3 py-2 text-sm font-medium text-white hover:bg-emerald-600 disabled:opacity-40"
                      >
                        Save
                      </button>
                      {keySet && (
                        <button
                          type="button"
                          onClick={clearKey}
                          className={inputCls + " opacity-70 hover:opacity-100"}
                        >
                          Clear
                        </button>
                      )}
                    </div>
                  </div>
                ) : (
                  <p className="text-xs opacity-40">
                    Key is read server-side from <code>.env.local</code>.
                  </p>
                )}
                <label className="block">
                  <span className="mb-1 block text-xs opacity-60">max_tokens</span>
                  <input
                    type="number"
                    step="256"
                    min="1"
                    value={params.max_tokens ?? ""}
                    onChange={(e) => setParam("max_tokens", e.target.value)}
                    placeholder="4096"
                    className={inputCls + " w-full"}
                  />
                  <span className="mt-1 block text-xs opacity-40">
                    temperature is omitted for Anthropic models.
                  </span>
                </label>
              </div>
            ) : (
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
            )}
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
            const canRetract = m.id === lastUserId && !streaming;
            return (
              <div
                key={m.id}
                className={
                  "group flex " +
                  (m.role === "user" ? "justify-end" : "justify-start")
                }
              >
                <div className="flex max-w-[85%] flex-col items-end gap-1">
                  <div
                    className={
                      "whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm " +
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
                  {canRetract && (
                    <button
                      type="button"
                      onClick={() => retract(m.id, m.content)}
                      className="text-xs opacity-0 transition-opacity hover:underline group-hover:opacity-50"
                    >
                      ↶ edit
                    </button>
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
            ref={inputRef}
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
    </div>
  );
}
