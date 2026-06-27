"use client";

// app/panels.jsx — the Panels column + the per-extension sandboxed frame.
// U1a: proves the runtime with a hardcoded test extension (TEST_EXTENSION).

import { useEffect, useMemo, useRef, useState } from "react";
import {
  getRuntimeLibs,
  buildSrcdoc,
  getMediator,
  newNonce,
} from "@/lib/ext-runtime";

// Design tokens injected into each iframe so panels match the app's dark theme.
const CSS_VARS = "--pw-fg:#e5e5e5";

// Hardcoded dogfood extension — exercises htm render, hooks, store (SQLite) + ui caps.
export const TEST_EXTENSION = {
  name: "Counter",
  description: "A counter panel that persists via the store capability.",
  manifest: ["store", "ui"],
  code: `function Extension(){
  const [n,setN]=useState(null);
  useEffect(function(){ host.store.get('count').then(function(v){ setN(v?Number(v):0); }); },[]);
  if(n===null) return html\`<div>Loading…</div>\`;
  async function inc(){ const next=n+1; setN(next); await host.store.set('count',next); host.ui.setTitle('Counter: '+next); }
  return html\`<div style="display:flex;flex-direction:column;gap:8px">
    <div>Count: <b>\${n}</b></div>
    <div style="display:flex;gap:8px">
      <button onClick=\${inc}>Increment</button>
      <button onClick=\${function(){ host.ui.notify('Hello from the extension! count='+n); }}>Notify</button>
    </div>
  </div>\`;
}`,
};

export function ExtensionFrame({ ext }) {
  const [srcdoc, setSrcdoc] = useState(null);
  const [title, setTitle] = useState(ext.name || "Extension");
  const [height, setHeight] = useState(80);
  const [error, setError] = useState(null);
  const nonce = useMemo(() => newNonce(), []);

  // Register by nonce on mount (race-free: routing doesn't depend on iframe load timing).
  useEffect(() => {
    getMediator().register(nonce, {
      ext,
      setTitle,
      setHeight: (h) => setHeight(Math.min(Math.max(h, 40), 600)),
      onError: (e) => setError(e),
      onReady: () => setError(null),
    });
    return () => getMediator().unregister(nonce);
  }, [nonce, ext]);

  useEffect(() => {
    let alive = true;
    getRuntimeLibs().then((libs) => {
      if (alive) setSrcdoc(buildSrcdoc(ext.code, libs, CSS_VARS, nonce));
    });
    return () => {
      alive = false;
    };
  }, [ext.code, nonce]);

  return (
    <div className="overflow-hidden rounded-xl border border-black/10 dark:border-white/15">
      <div className="truncate border-b border-black/10 px-3 py-1.5 text-xs font-medium opacity-70 dark:border-white/10">
        {title}
      </div>
      {srcdoc && (
        <iframe
          sandbox="allow-scripts"
          srcDoc={srcdoc}
          style={{ width: "100%", height, border: 0, display: "block" }}
          title={title}
        />
      )}
      {error && (
        <div className="px-3 py-1.5 text-xs text-red-500">⚠ {error}</div>
      )}
    </div>
  );
}

export default function Panels({ extensions, onCreate, onToggle, onDelete }) {
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    getMediator().setToast((ext, msg) => {
      const id = crypto.randomUUID();
      setToasts((t) => [...t, { id, name: ext.name, msg }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
    });
  }, []);

  const enabled = extensions.filter((e) => e.enabled);

  return (
    <aside className="flex w-72 shrink-0 flex-col border-l border-black/10 dark:border-white/10">
      <header className="flex items-center justify-between px-3 py-4">
        <span className="text-xs font-semibold uppercase tracking-wider opacity-50">
          Panels
        </span>
        <button
          type="button"
          onClick={onCreate}
          className="rounded-lg bg-emerald-500 px-2 py-1 text-xs font-medium text-white hover:bg-emerald-600"
        >
          + Extension
        </button>
      </header>
      <div className="flex-1 space-y-3 overflow-y-auto px-3 pb-3">
        {enabled.length === 0 && (
          <p className="mt-6 text-center text-xs opacity-40">
            No panels yet. Add one with “+ Extension”.
          </p>
        )}
        {enabled.map((ext) => (
            <div key={ext.id} className="group">
              <ExtensionFrame ext={ext} />
              <div className="mt-1 flex justify-end gap-2 text-[11px] opacity-0 transition-opacity group-hover:opacity-60">
                <button type="button" onClick={() => onToggle(ext.id, false)}>
                  disable
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(ext.id)}
                  className="hover:text-red-500"
                >
                  delete
                </button>
              </div>
            </div>
          ))}
      </div>
      {toasts.length > 0 && (
        <div className="space-y-1 p-3">
          {toasts.map((t) => (
            <div
              key={t.id}
              className="rounded-lg border border-sky-400/40 bg-sky-500/10 px-2 py-1 text-xs"
            >
              <b>{t.name}:</b> {t.msg}
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
