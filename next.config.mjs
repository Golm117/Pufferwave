/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export: the whole UI is client-side, so it bundles into the Tauri webview as
  // plain HTML/JS. All inference goes through Rust commands now, so there are no API
  // routes left to block the export (removed in T3).
  output: "export",
};

export default nextConfig;
