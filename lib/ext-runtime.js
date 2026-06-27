"use client";

// lib/ext-runtime.js — the live-extension runtime.
//
// Each extension renders inside a sandboxed <iframe srcdoc sandbox="allow-scripts">
// (opaque origin: no parent DOM, no Tauri bridge). The extension's Preact/htm code runs
// inside; it reaches host capabilities ONLY via async postMessage to the singleton
// mediator here, which enforces the extension's manifest and dispatches ui/store.
//
// The runtime libs (preact + hooks + htm UMD) are fetched once from /ext-runtime and
// inlined into each srcdoc so the iframe is fully self-contained (no cross-origin loads).

import {
  extStoreGet,
  extStoreSet,
  extStoreDelete,
} from "./persistence";

let libsPromise = null;
export async function getRuntimeLibs() {
  if (!libsPromise) {
    libsPromise = (async () => {
      const files = [
        "/ext-runtime/preact.umd.js",
        "/ext-runtime/hooks.umd.js",
        "/ext-runtime/htm.umd.js",
      ];
      const parts = await Promise.all(
        files.map((f) => fetch(f).then((r) => r.text())),
      );
      return parts.join("\n");
    })();
  }
  return libsPromise;
}

// Keep extension/lib code from prematurely closing the inline <script>.
function neutralize(code) {
  return String(code).replace(/<\/script/gi, "<\\/script");
}

export function buildSrcdoc(extCode, libs, cssVars = "") {
  const head = `<!doctype html><html><head><meta charset="utf-8"><style>
:root{${cssVars}}
html,body{margin:0;padding:0;background:transparent;color:var(--pw-fg,#e5e5e5);font:13px/1.5 system-ui,-apple-system,sans-serif}
#root{padding:10px}
button{font:inherit;cursor:pointer;border-radius:8px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:inherit;padding:4px 10px}
button:hover{background:rgba(255,255,255,.12)}
input,textarea{font:inherit;border-radius:8px;border:1px solid rgba(255,255,255,.18);background:transparent;color:inherit;padding:4px 8px}
.pw-err{color:#f87171;white-space:pre-wrap;font-size:12px}
</style><script>${neutralize(libs)}</script></head><body><div id="root"></div><script>
(function(){
  var h=preact.h, render=preact.render;
  var html=htm.bind(h);
  var useState=preactHooks.useState, useEffect=preactHooks.useEffect, useRef=preactHooks.useRef, useMemo=preactHooks.useMemo;
  var _id=0,_pending={};
  addEventListener('message',function(e){var m=e.data;if(!m||!m.__pwext)return;if(m.id!=null&&_pending[m.id]){var p=_pending[m.id];delete _pending[m.id];m.ok?p.resolve(m.result):p.reject(new Error(m.error||'error'));}});
  function call(cap,args){return new Promise(function(res,rej){var id=++_id;_pending[id]={resolve:res,reject:rej};parent.postMessage({__pwext:true,id:id,cap:cap,args:args||[]},'*');});}
  var host={
    store:{get:function(k){return call('store.get',[k]);},set:function(k,v){return call('store.set',[k,v]);},delete:function(k){return call('store.delete',[k]);}},
    ui:{notify:function(msg){return call('ui.notify',[msg]);},setTitle:function(t){return call('ui.setTitle',[t]);}}
  };
  function reportHeight(){try{parent.postMessage({__pwext:true,type:'resize',height:document.documentElement.scrollHeight},'*');}catch(_){}}
  function fail(err){var msg=String(err&&err.message||err);try{render(html\`<div class="pw-err">\${msg}</div>\`,document.getElementById('root'));}catch(_){}try{parent.postMessage({__pwext:true,type:'error',error:msg},'*');}catch(_){}reportHeight();}
  try{
/* ---- extension code (defines function Extension) ---- */
${neutralize(extCode)}
/* ---- end extension code ---- */
    if(typeof Extension!=='function') throw new Error('extension must define function Extension()');
    render(h(Extension),document.getElementById('root'));
    try{new ResizeObserver(reportHeight).observe(document.documentElement);}catch(_){}
    reportHeight();
  }catch(e){fail(e);}
})();
</script></body></html>`;
  return head;
}

// --- the singleton mediator ---

let mediator = null;
export function getMediator() {
  if (mediator) return mediator;

  const registry = new Map(); // Window -> { ext, setTitle, setHeight, onError }
  let toast = null; // global notify handler

  async function dispatch(ext, cap, args, ctx) {
    // Enforce the manifest: capability namespace must be granted.
    const ns = cap.split(".")[0];
    if (!Array.isArray(ext.manifest) || !ext.manifest.includes(ns)) {
      throw new Error(`capability "${ns}" not granted`);
    }
    switch (cap) {
      case "store.get":
        return extStoreGet(ext.id, args[0]);
      case "store.set":
        return extStoreSet(ext.id, args[0], args[1]);
      case "store.delete":
        return extStoreDelete(ext.id, args[0]);
      case "ui.setTitle":
        ctx.setTitle?.(String(args[0] ?? ""));
        return true;
      case "ui.notify":
        toast?.(ext, String(args[0] ?? ""));
        return true;
      default:
        throw new Error(`unknown capability "${cap}"`);
    }
  }

  function onMessage(e) {
    const ctx = registry.get(e.source);
    if (!ctx) return; // not one of our extension frames
    const m = e.data;
    if (!m || !m.__pwext) return;

    if (m.type === "resize") {
      ctx.setHeight?.(m.height);
      return;
    }
    if (m.type === "error") {
      ctx.onError?.(m.error);
      return;
    }
    if (m.cap && m.id != null) {
      dispatch(ctx.ext, m.cap, m.args, ctx)
        .then((result) =>
          e.source.postMessage(
            { __pwext: true, id: m.id, ok: true, result },
            "*",
          ),
        )
        .catch((err) =>
          e.source.postMessage(
            {
              __pwext: true,
              id: m.id,
              ok: false,
              error: String(err?.message || err),
            },
            "*",
          ),
        );
    }
  }

  window.addEventListener("message", onMessage);

  mediator = {
    register(win, ctx) {
      registry.set(win, ctx);
    },
    unregister(win) {
      registry.delete(win);
    },
    setToast(fn) {
      toast = fn;
    },
  };
  return mediator;
}
