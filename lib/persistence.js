"use client";

// lib/persistence.js — versioned persistence for the conversation blob.
//
// Async by design (SQLite is async). In the Tauri desktop app the blob lives in a SQLite
// DB via tauri-plugin-sql (no ~5MB cap); in a browser it falls back to localStorage. On
// the first desktop run the existing localStorage blob is migrated into SQLite once. The
// `version` field on the persisted shape is what makes future schema migrations possible.

const STORAGE_KEY = "pufferwave";
const SCHEMA_VERSION = 1;
const DB_URL = "sqlite:pufferwave.db";

function isTauri() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

// --- SQLite (desktop) ---

let dbPromise = null;
function getDb() {
  if (!dbPromise) {
    dbPromise = (async () => {
      const { default: Database } = await import("@tauri-apps/plugin-sql");
      const db = await Database.load(DB_URL);
      await db.execute(
        "CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT)",
      );
      return db;
    })();
  }
  return dbPromise;
}

async function readBlob() {
  if (isTauri()) {
    const db = await getDb();
    const rows = await db.select("SELECT value FROM app_state WHERE key = $1", [
      STORAGE_KEY,
    ]);
    if (rows.length) return rows[0].value;
    // First desktop run: migrate an existing localStorage blob into SQLite.
    const ls =
      typeof window !== "undefined"
        ? window.localStorage.getItem(STORAGE_KEY)
        : null;
    if (ls) await writeBlob(ls);
    return ls;
  }
  return typeof window !== "undefined"
    ? window.localStorage.getItem(STORAGE_KEY)
    : null;
}

async function writeBlob(str) {
  if (isTauri()) {
    const db = await getDb();
    await db.execute(
      "INSERT INTO app_state (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = $2",
      [STORAGE_KEY, str],
    );
    return;
  }
  if (typeof window !== "undefined") {
    window.localStorage.setItem(STORAGE_KEY, str);
  }
}

// --- shape migration (independent of the storage backend) ---

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.filter(
    (m) => m.role !== "assistant" || m.status === "complete",
  );
}

function migrate(parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  if (!Array.isArray(parsed.conversations)) return null;
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

export async function loadState() {
  let raw;
  try {
    raw = await readBlob();
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    return migrate(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function saveState(conversations, activeId) {
  const str = JSON.stringify({ version: SCHEMA_VERSION, conversations, activeId });
  try {
    await writeBlob(str);
  } catch {
    /* quota / db error — non-fatal for the MVP */
  }
}
