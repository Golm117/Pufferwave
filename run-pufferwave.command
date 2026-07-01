#!/bin/bash
# Double-click to launch Pufferwave in dev mode (self-editing needs this — it watches
# the source and hot-reloads your changes). Keep this Terminal window open while using
# the app; closing it (or Ctrl+C) quits Pufferwave.
cd "$(dirname "$0")" || exit 1
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_HTTP_MULTIPLEXING=false
echo "Launching Pufferwave…  (first launch after code changes compiles Rust — give it a minute)"
npm run tauri dev
