"use client";

// lib/store.js — conversation state + versioned localStorage persistence.
//
// Owns the Conversation/Message shapes and all reads/writes to localStorage. Rules
// baked in here:
//   - persisted blob is { version, conversations } so a future SQLite/Supabase move
//     can migrate rather than discard.
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

// Slice 2: still hardcoded. The picker (Slice 3) writes conversation.model instead.
export const DEFAULT_MODEL = "qwen2.5-coder:3b";

export function makeConversation(overrides = {}) {
  return {
    id: crypto.randomUUID(),
    title: "New chat",
    model: DEFAULT_MODEL,
    systemPrompt: "",
    params: {}, // { temperature?, num_ctx? } — populated in Slice 3
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

// Keep only turns that are allowed to survive a reload: any user/system turn, plus
// assistant turns that actually completed. Drops streaming/aborted/errored partials.
function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.filter(
    (m) => m.role !== "assistant" || m.status === "complete",
  );
}

function migrate(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  if (!Array.isArray(parsed.conversations)) return null;
  // v1 is the only schema today. When v2 lands, branch on parsed.version here and
  // transform rather than discard. For now we accept shaped data and sanitize it.
  return parsed.conversations.map((c) => ({
    ...c,
    messages: sanitizeMessages(c.messages),
  }));
}

function loadConversations() {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return migrate(JSON.parse(raw));
  } catch {
    return null;
  }
}

function saveConversations(conversations) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: SCHEMA_VERSION, conversations }),
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
  // Synchronous setState in this effect is intentional and SSR-safe: the server renders
  // empty and the client populates post-mount, which AVOIDS a hydration mismatch.
  // useSyncExternalStore would be overkill for a store that React itself owns.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const loaded = loadConversations();
    if (loaded && loaded.length) {
      setConversations(loaded);
      setActiveId(loaded[0].id);
    } else {
      const c = makeConversation();
      setConversations([c]);
      setActiveId(c.id);
    }
    setHydrated(true);
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Latest-conversations ref so an explicit persist() always writes fresh data.
  const ref = useRef(conversations);
  useEffect(() => {
    ref.current = conversations;
  });

  // Persistence is explicit: terminal/structural events bump this tick; per-delta
  // streaming patches do NOT, keeping localStorage off the hot path.
  const [persistTick, setPersistTick] = useState(0);
  const persist = useCallback(() => setPersistTick((t) => t + 1), []);
  useEffect(() => {
    if (!hydrated || persistTick === 0) return;
    saveConversations(ref.current);
  }, [persistTick, hydrated]);

  const mutateActive = useCallback(
    (fn) =>
      setConversations((prev) =>
        prev.map((c) => (c.id === activeId ? fn(c) : c)),
      ),
    [activeId],
  );

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

  // For model / systemPrompt / params (Slice 3).
  const setActiveField = useCallback(
    (field, value) => {
      mutateActive((c) => ({ ...c, [field]: value }));
      persist();
    },
    [mutateActive, persist],
  );

  const active = conversations.find((c) => c.id === activeId) || null;

  return {
    hydrated,
    active,
    conversations,
    addMessage,
    patchMessage,
    removeMessage,
    setActiveField,
  };
}
