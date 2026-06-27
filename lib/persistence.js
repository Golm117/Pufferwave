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
      await db.execute(
        `CREATE TABLE IF NOT EXISTS extensions (
           id TEXT PRIMARY KEY, name TEXT, description TEXT, code TEXT,
           manifest TEXT, granted_scopes TEXT, enabled INTEGER DEFAULT 1,
           source_prompt TEXT, author_model TEXT, created_at INTEGER
         )`,
      );
      await db.execute(
        `CREATE TABLE IF NOT EXISTS extension_store (
           ext_id TEXT, key TEXT, value TEXT, PRIMARY KEY (ext_id, key)
         )`,
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

// --- extensions (desktop only; SQLite) ---

export async function listExtensions() {
  if (!isTauri()) return [];
  try {
    const db = await getDb();
    const rows = await db.select(
      "SELECT * FROM extensions ORDER BY created_at ASC",
    );
    return rows.map((r) => ({
      ...r,
      enabled: !!r.enabled,
      manifest: safeParse(r.manifest, []),
      granted_scopes: safeParse(r.granted_scopes, {}),
    }));
  } catch {
    return [];
  }
}

export async function saveExtension(ext) {
  if (!isTauri()) return;
  const db = await getDb();
  await db.execute(
    `INSERT INTO extensions
       (id, name, description, code, manifest, granted_scopes, enabled, source_prompt, author_model, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT(id) DO UPDATE SET
       name=$2, description=$3, code=$4, manifest=$5, granted_scopes=$6,
       enabled=$7, source_prompt=$8, author_model=$9`,
    [
      ext.id,
      ext.name ?? "",
      ext.description ?? "",
      ext.code ?? "",
      JSON.stringify(ext.manifest ?? []),
      JSON.stringify(ext.granted_scopes ?? {}),
      ext.enabled === false ? 0 : 1,
      ext.source_prompt ?? "",
      ext.author_model ?? "",
      ext.created_at ?? Date.now(),
    ],
  );
}

export async function setExtensionEnabled(id, enabled) {
  if (!isTauri()) return;
  const db = await getDb();
  await db.execute("UPDATE extensions SET enabled=$1 WHERE id=$2", [
    enabled ? 1 : 0,
    id,
  ]);
}

export async function deleteExtension(id) {
  if (!isTauri()) return;
  const db = await getDb();
  await db.execute("DELETE FROM extensions WHERE id=$1", [id]);
  await db.execute("DELETE FROM extension_store WHERE ext_id=$1", [id]);
}

// extension-local key/value store (the `store` capability)
export async function extStoreGet(extId, key) {
  if (!isTauri()) return null;
  const db = await getDb();
  const rows = await db.select(
    "SELECT value FROM extension_store WHERE ext_id=$1 AND key=$2",
    [extId, key],
  );
  return rows.length ? rows[0].value : null;
}

export async function extStoreSet(extId, key, value) {
  if (!isTauri()) return;
  const db = await getDb();
  await db.execute(
    `INSERT INTO extension_store (ext_id, key, value) VALUES ($1,$2,$3)
     ON CONFLICT(ext_id, key) DO UPDATE SET value=$3`,
    [extId, key, String(value)],
  );
}

export async function extStoreDelete(extId, key) {
  if (!isTauri()) return;
  const db = await getDb();
  await db.execute(
    "DELETE FROM extension_store WHERE ext_id=$1 AND key=$2",
    [extId, key],
  );
}

function safeParse(s, fallback) {
  try {
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
}
