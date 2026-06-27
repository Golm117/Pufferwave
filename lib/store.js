"use client";

// lib/store.js — conversation state; persistence delegated to lib/persistence.js.
//
// Rules baked in here:
//   - load/save go through persistence.js (async: SQLite on desktop, localStorage in a
//     browser). The persisted blob is versioned so schema migrations can adapt old chats.
//   - persistence happens on terminal/structural events only, NEVER per streaming delta.
//   - aborted/errored/streaming assistant turns are sanitized out on load (in persistence.js)
//     so a refresh mid-stream can't leave a stuck bubble.
//   - the failed-connect log lives in its own capped localStorage key, isolated from the blob.

import { useCallback, useEffect, useRef, useState } from "react";
import { loadState, saveState } from "./persistence";

const ERROR_LOG_KEY = "pufferwave:errors";
const ERROR_LOG_CAP = 50;

export const DEFAULT_MODEL = "qwen2.5-coder:3b";

export function makeConversation(overrides = {}) {
  return {
    id: crypto.randomUUID(),
    title: "New chat",
    provider: "ollama", // "ollama" | "anthropic"
    model: DEFAULT_MODEL,
    systemPrompt: "",
    params: {}, // { temperature?, num_ctx?, max_tokens? }
    messages: [],
    createdAt: Date.now(),
    ...overrides,
  };
}

export function makeMessage(role, content, status) {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    status,
    createdAt: Date.now(),
    meta: {}, // reserved for a future logging slice — stays empty
  };
}

// Failed-connect log: separate capped localStorage key. Written at the inference catch site.
export function logFailure(entry) {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(ERROR_LOG_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    arr.push({ at: Date.now(), ...entry });
    window.localStorage.setItem(
      ERROR_LOG_KEY,
      JSON.stringify(arr.slice(-ERROR_LOG_CAP)),
    );
  } catch {
    /* non-fatal */
  }
}

// --- the hook ---

export function useChatStore() {
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [hydrated, setHydrated] = useState(false);

  // Hydrate once after mount. Async (SQLite on desktop); SSR-safe (server renders empty,
  // client populates post-load — no hydration mismatch).
  useEffect(() => {
    let cancelled = false;
    loadState().then((loaded) => {
      if (cancelled) return;
      if (loaded && loaded.conversations.length) {
        setConversations(loaded.conversations);
        setActiveId(loaded.activeId);
      } else {
        const c = makeConversation();
        setConversations([c]);
        setActiveId(c.id);
      }
      setHydrated(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Latest refs so explicit persist() and id-reading mutations see fresh data.
  const convRef = useRef(conversations);
  const activeRef = useRef(activeId);
  useEffect(() => {
    convRef.current = conversations;
  });
  useEffect(() => {
    activeRef.current = activeId;
  });

  // Persistence is explicit: terminal/structural events bump this tick; per-delta
  // streaming patches do NOT, keeping writes off the hot path. Fire-and-forget (async).
  const [persistTick, setPersistTick] = useState(0);
  const persist = useCallback(() => setPersistTick((t) => t + 1), []);
  useEffect(() => {
    if (!hydrated || persistTick === 0) return;
    saveState(convRef.current, activeRef.current);
  }, [persistTick, hydrated]);

  const mutateActive = useCallback(
    (fn) =>
      setConversations((prev) =>
        prev.map((c) => (c.id === activeId ? fn(c) : c)),
      ),
    [activeId],
  );

  // --- message ops (operate on the active conversation) ---

  const addMessage = useCallback(
    (message, { persist: doPersist = true } = {}) => {
      mutateActive((c) => ({ ...c, messages: [...c.messages, message] }));
      if (doPersist) persist();
    },
    [mutateActive, persist],
  );

  const patchMessage = useCallback(
    (msgId, patch, { persist: doPersist = true } = {}) => {
      mutateActive((c) => ({
        ...c,
        messages: c.messages.map((m) =>
          m.id === msgId ? { ...m, ...patch } : m,
        ),
      }));
      if (doPersist) persist();
    },
    [mutateActive, persist],
  );

  const removeMessage = useCallback(
    (msgId) => {
      mutateActive((c) => ({
        ...c,
        messages: c.messages.filter((m) => m.id !== msgId),
      }));
      persist();
    },
    [mutateActive, persist],
  );

  // Remove a message and everything after it (the cancel -> retract-to-input flow).
  const retractFrom = useCallback(
    (msgId) => {
      mutateActive((c) => {
        const idx = c.messages.findIndex((m) => m.id === msgId);
        return idx === -1 ? c : { ...c, messages: c.messages.slice(0, idx) };
      });
      persist();
    },
    [mutateActive, persist],
  );

  const setActiveField = useCallback(
    (field, value) => {
      mutateActive((c) => ({ ...c, [field]: value }));
      persist();
    },
    [mutateActive, persist],
  );

  // --- conversation CRUD ---

  const selectConversation = useCallback(
    (id) => {
      setActiveId(id);
      persist();
    },
    [persist],
  );

  const createConversation = useCallback(() => {
    // Inherit the current model so a new chat doesn't force re-picking it.
    const current = convRef.current.find((c) => c.id === activeRef.current);
    const c = makeConversation({ model: current?.model ?? DEFAULT_MODEL });
    setConversations((prev) => [c, ...prev]); // newest first
    setActiveId(c.id);
    persist();
  }, [persist]);

  const deleteConversation = useCallback(
    (id) => {
      const remaining = convRef.current.filter((c) => c.id !== id);
      if (remaining.length === 0) {
        const fresh = makeConversation();
        setConversations([fresh]);
        setActiveId(fresh.id);
      } else {
        setConversations(remaining);
        if (id === activeRef.current) setActiveId(remaining[0].id);
      }
      persist();
    },
    [persist],
  );

  const renameConversation = useCallback(
    (id, title) => {
      setConversations((prev) =>
        prev.map((c) => (c.id === id ? { ...c, title } : c)),
      );
      persist();
    },
    [persist],
  );

  const active = conversations.find((c) => c.id === activeId) || null;

  return {
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
  };
}
