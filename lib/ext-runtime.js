"use client";

// lib/ext-runtime.js — the live-extension runtime.
//
// Each extension renders inside a sandboxed <iframe srcdoc sandbox="allow-scripts">
// (opaque origin: no parent DOM, no Tauri bridge). The extension's Preact/htm code runs
// inside; it reaches host capabilities ONLY via async postMessage to the singleton
// mediator here, which enforces the extension's manifest and dispatches ui/store.
//
// Messages are routed by a per-frame NONCE (unguessable), not window identity — this is
// race-free (works even before the iframe's window settles) and keeps frames isolated
// from each other (an extension can't forge another's nonce).

import { extStoreGet, extStoreSet, extStoreDelete } from "./persistence";

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

function neutralize(code) {
  return String(code).replace(/<\/script/gi, "<\\/script");
}

export function buildSrcdoc(extCode, libs, cssVars = "", nonce = "") {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
:root{${cssVars}}
html,body{margin:0;padding:0;background:transparent;color:var(--pw-fg,#e5e5e5);font:13px/1.5 system-ui,-apple-system,sans-serif}
#root{padding:10px}
button{font:inherit;cursor:pointer;border-radius:8px;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:inherit;padding:4px 10px}
button:hover{background:rgba(255,255,255,.12)}
input,textarea{font:inherit;border-radius:8px;border:1px solid rgba(255,255,255,.18);background:transparent;color:inherit;padding:4px 8px}
.pw-err{color:#f87171;white-space:pre-wrap;font-size:12px}
</style><script>${neutralize(libs)}</script></head><body><div id="root"></div><script>
(function(){
  var NONCE=${JSON.stringify(nonce)};
  var h=preact.h, render=preact.render;
  var html=htm.bind(h);
  var useState=preactHooks.useState, useEffect=preactHooks.useEffect, useRef=preactHooks.useRef, useMemo=preactHooks.useMemo;
  var _id=0,_pending={};
  addEventListener('message',function(e){var m=e.data;if(!m||!m.__pwext)return;if(m.id!=null&&_pending[m.id]){var p=_pending[m.id];delete _pending[m.id];m.ok?p.resolve(m.result):p.reject(new Error(m.error||'error'));}});
  function send(o){o.__pwext=true;o.nonce=NONCE;parent.postMessage(o,'*');}
  function call(cap,args){return new Promise(function(res,rej){var id=++_id;_pending[id]={resolve:res,reject:rej};send({id:id,cap:cap,args:args||[]});});}
  var host={
    store:{get:function(k){return call('store.get',[k]);},set:function(k,v){return call('store.set',[k,v]);},delete:function(k){return call('store.delete',[k]);}},
    ui:{notify:function(msg){return call('ui.notify',[msg]);},setTitle:function(t){return call('ui.setTitle',[t]);}}
  };
  function reportHeight(){try{send({type:'resize',height:document.documentElement.scrollHeight});}catch(_){}}
  function fail(err){var msg=String(err&&err.message||err);try{render(html\`<div class="pw-err">\${msg}</div>\`,document.getElementById('root'));}catch(_){}try{send({type:'error',error:msg});}catch(_){}reportHeight();}
  try{
/* ---- extension code (defines function Extension) ---- */
${neutralize(extCode)}
/* ---- end extension code ---- */
    if(typeof Extension!=='function') throw new Error('extension must define function Extension()');
    render(h(Extension),document.getElementById('root'));
    try{new ResizeObserver(reportHeight).observe(document.documentElement);}catch(_){}
    reportHeight();
    send({type:'ready'});
  }catch(e){fail(e);}
})();
</script></body></html>`;
}

export function newNonce() {
  return crypto.randomUUID();
}

// --- the singleton mediator (nonce-routed) ---

let mediator = null;
export function getMediator() {
  if (mediator) return mediator;
  const registry = new Map(); // nonce -> { ext, setTitle, setHeight, onError, onReady }
  let toast = null;

  async function dispatch(ext, cap, args, ctx) {
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
    const m = e.data;
    if (!m || !m.__pwext || !m.nonce) return;
    const ctx = registry.get(m.nonce);
    if (!ctx) return;
    if (m.type === "resize") return void ctx.setHeight?.(m.height);
    if (m.type === "error") return void ctx.onError?.(m.error);
    if (m.type === "ready") return void ctx.onReady?.();
    if (m.cap && m.id != null) {
      dispatch(ctx.ext, m.cap, m.args, ctx)
        .then((result) =>
          e.source.postMessage({ __pwext: true, id: m.id, ok: true, result }, "*"),
        )
        .catch((err) =>
          e.source.postMessage(
            { __pwext: true, id: m.id, ok: false, error: String(err?.message || err) },
            "*",
          ),
        );
    }
  }

  window.addEventListener("message", onMessage);
  mediator = {
    register: (nonce, ctx) => registry.set(nonce, ctx),
    unregister: (nonce) => registry.delete(nonce),
    setToast: (fn) => (toast = fn),
  };
  return mediator;
}

// Headless load-test used by the authoring repair loop: render in a hidden iframe and
// resolve { ok } on the extension's "ready" signal, { ok:false, error } on failure/timeout.
export async function previewExtension(ext) {
  const libs = await getRuntimeLibs();
  const nonce = newNonce();
  const srcdoc = buildSrcdoc(ext.code, libs, "--pw-fg:#e5e5e5", nonce);
  const mediator = getMediator();
  return new Promise((resolve) => {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.style.cssText =
      "position:fixed;left:-9999px;top:0;width:320px;height:240px;border:0";
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      mediator.unregister(nonce);
      iframe.remove();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, error: "Timed out — the extension didn't render." }),
      6000,
    );
    mediator.register(nonce, {
      ext: { id: "__preview__", manifest: ext.manifest || [], name: ext.name },
      onReady: () => finish({ ok: true }),
      onError: (err) => finish({ ok: false, error: err }),
      setTitle: () => {},
      setHeight: () => {},
    });
    iframe.srcdoc = srcdoc;
    document.body.appendChild(iframe);
  });
}
