"use client";

// lib/store.js — conversation state + versioned localStorage persistence.
//
// Owns the Conversation/Message shapes and all reads/writes to localStorage. Rules
// baked in here:
//   - persisted blob is { version, conversations, activeId } so a future SQLite/Supabase
//     move can migrate rather than discard. activeId is additive — older blobs without it
//     fall back to the first conversation.
//   - localStorage is client-only: every access is guarded, hydration happens once in a
//     mount effect (SSR renders empty, no hydration mismatch).
//   - persistence happens on terminal/structural events only, NEVER per streaming delta.
//   - aborted/errored/streaming assistant turns are never meant to survive a reload; we
//     sanitize them out on load so a refresh mid-stream can't leave a stuck bubble.
//   - the failed-connect log lives in its own capped key, isolated from the chat blob.

import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "pufferwave";
const ERROR_LOG_KEY = "pufferwave:errors";
const SCHEMA_VERSION = 1;
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

// --- persistence (client-only, guarded) ---

// Keep only turns allowed to survive a reload: any user/system turn, plus assistant
// turns that actually completed. Drops streaming/aborted/errored partials.
function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.filter(
    (m) => m.role !== "assistant" || m.status === "complete",
  );
}

function migrate(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  if (!Array.isArray(parsed.conversations)) return null;
  // v1 is the only schema today. When v2 lands, branch on parsed.version here.
  const conversations = parsed.conversations.map((c) => ({
    provider: "ollama", // additive — older blobs predate multi-provider
    ...c,
    messages: sanitizeMessages(c.messages),
  }));
  const activeId = conversations.some((c) => c.id === parsed.activeId)
    ? parsed.activeId
    : (conversations[0]?.id ?? null);
  return { conversations, activeId };
}

function loadState() {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return migrate(JSON.parse(raw));
  } catch {
    return null;
  }
}

function saveState(conversations, activeId) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: SCHEMA_VERSION, conversations, activeId }),
    );
  } catch {
    /* quota / private mode — non-fatal for the MVP */
  }
}

// Failed-connect log: separate capped key. Written at the inference catch site.
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

  // Hydrate once. localStorage is client-only, so this runs after the first paint.
  // Synchronous setState here is intentional and SSR-safe: the server renders empty and
  // the client populates post-mount, which AVOIDS a hydration mismatch. useSyncExternalStore
  // would be overkill for a store that React itself owns.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const loaded = loadState();
    if (loaded && loaded.conversations.length) {
      setConversations(loaded.conversations);
      setActiveId(loaded.activeId);
    } else {
      const c = makeConversation();
      setConversations([c]);
      setActiveId(c.id);
    }
    setHydrated(true);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

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
  // streaming patches do NOT, keeping localStorage off the hot path.
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
