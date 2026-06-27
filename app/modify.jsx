"use client";

// app/modify.jsx — "Modify Pufferwave": describe a change, Claude Code edits the real
// source, tauri dev applies it live, then commit (keep) or revert (discard).
//
// State is derived from git on open, so a mid-run HMR reset can't lose pending changes —
// reopening always shows the current working-tree status.

import { useEffect, useState } from "react";
import {
  modifyApp,
  repoStatus,
  repoCommit,
  repoRevert,
  repoUndoLast,
  repoHeadSubject,
} from "@/lib/selfedit";

export default function ModifyDialog({ onClose }) {
  const [prompt, setPrompt] = useState("");
  const [phase, setPhase] = useState("idle"); // idle | running | error
  const [output, setOutput] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [headSubject, setHeadSubject] = useState("");
  const [commitMsg, setCommitMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function refreshStatus() {
    try {
      setStatus(await repoStatus());
    } catch {
      /* ignore */
    }
    try {
      setHeadSubject(await repoHeadSubject());
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    let alive = true;
    Promise.all([
      repoStatus().catch(() => ""),
      repoHeadSubject().catch(() => ""),
    ]).then(([s, h]) => {
      if (!alive) return;
      setStatus(s);
      setHeadSubject(h);
    });
    return () => {
      alive = false;
    };
  }, []);

  async function run() {
    const p = prompt.trim();
    if (!p) return;
    setPhase("running");
    setError("");
    setOutput("");
    try {
      const out = await modifyApp(p);
      setOutput(out);
      setPhase("idle");
      setPrompt("");
    } catch (e) {
      setError(String(e?.message || e));
      setPhase("error");
    } finally {
      await refreshStatus();
    }
  }

  async function commit() {
    const msg = commitMsg.trim() || "Self-edit via Pufferwave";
    setBusy(true);
    try {
      await repoCommit(msg);
      setCommitMsg("");
      await refreshStatus();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function revert() {
    if (!confirm("Discard ALL uncommitted changes in the repo?")) return;
    setBusy(true);
    try {
      await repoRevert();
      await refreshStatus();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  async function undoLast() {
    if (
      !confirm(
        `Undo the last commit and reset to the one before it?\n\n"${headSubject}"`,
      )
    )
      return;
    setBusy(true);
    try {
      await repoUndoLast();
      await refreshStatus();
    } catch (e) {
      setError(String(e?.message || e));
    } finally {
      setBusy(false);
    }
  }

  const dirty = status.trim().length > 0;
  const btn = "rounded-xl px-3 py-2 text-sm font-medium disabled:opacity-40";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[88vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-white/15 bg-neutral-900 text-sm text-neutral-100 shadow-xl">
        <header className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <span className="font-medium">🛠 Modify Pufferwave</span>
          <button onClick={onClose} className="opacity-60 hover:opacity-100">
            ✕
          </button>
        </header>

        <div className="flex-1 space-y-3 overflow-y-auto p-4">
          <textarea
            autoFocus
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            disabled={phase === "running"}
            placeholder="Describe a change to the app itself… e.g. “make the send button purple”, “add a token counter under the input”"
            className="w-full rounded-xl border border-white/15 bg-transparent px-3 py-2 outline-none focus:border-sky-400 disabled:opacity-50"
          />
          <p className="text-xs opacity-50">
            Claude Code edits the real source; changes apply live via hot-reload. Review
            below, then commit or revert. Revert discards <b>all</b> uncommitted changes.
          </p>

          {phase === "running" && (
            <div className="flex items-center gap-3 py-3">
              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
              <span>Claude Code is editing the repo… (this can take a while)</span>
            </div>
          )}

          {phase === "error" && (
            <p className="whitespace-pre-wrap rounded-lg border border-red-400/40 bg-red-500/10 px-3 py-2 text-red-300">
              {error}
            </p>
          )}

          {output && (
            <details className="text-xs opacity-80" open>
              <summary className="cursor-pointer">Claude Code result</summary>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-black/40 p-2 text-[11px] leading-snug">
                {output}
              </pre>
            </details>
          )}

          <div>
            <div className="mb-1 text-xs font-semibold uppercase tracking-wider opacity-50">
              Pending changes
            </div>
            {dirty ? (
              <pre className="max-h-40 overflow-auto rounded-lg bg-black/40 p-2 font-mono text-[11px] leading-snug">
                {status}
              </pre>
            ) : (
              <p className="text-xs opacity-40">
                Working tree clean. Last commit:{" "}
                <span className="opacity-70">{headSubject || "—"}</span>
              </p>
            )}
          </div>

          {dirty && (
            <input
              value={commitMsg}
              onChange={(e) => setCommitMsg(e.target.value)}
              placeholder="Commit message (optional)"
              className="w-full rounded-xl border border-white/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-sky-400"
            />
          )}
        </div>

        <footer className="flex justify-end gap-2 border-t border-white/10 px-4 py-3">
          {!dirty && headSubject && (
            <button
              onClick={undoLast}
              disabled={busy || phase === "running"}
              className={btn + " mr-auto bg-white/10 hover:bg-white/20"}
              title={`Undo: ${headSubject}`}
            >
              Undo last commit
            </button>
          )}
          {dirty && (
            <button
              onClick={revert}
              disabled={busy || phase === "running"}
              className={btn + " bg-white/10 hover:bg-white/20"}
            >
              Revert
            </button>
          )}
          {dirty && (
            <button
              onClick={commit}
              disabled={busy || phase === "running"}
              className={btn + " bg-sky-500 text-white hover:bg-sky-600"}
            >
              Commit
            </button>
          )}
          <button
            onClick={run}
            disabled={!prompt.trim() || phase === "running"}
            className={btn + " bg-emerald-500 text-white hover:bg-emerald-600"}
          >
            {phase === "running" ? "Running…" : "Run"}
          </button>
        </footer>
      </div>
    </div>
  );
}
