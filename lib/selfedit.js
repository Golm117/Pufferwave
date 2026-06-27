"use client";

// lib/selfedit.js — client wrappers for the dev-mode self-modification commands.

import { invoke } from "@tauri-apps/api/core";

export function modifyApp(prompt) {
  return invoke("modify", { prompt });
}
export function repoStatus() {
  return invoke("repo_status");
}
export function repoDiff() {
  return invoke("repo_diff");
}
export function repoCommit(message) {
  return invoke("repo_commit", { message });
}
export function repoRevert() {
  return invoke("repo_revert");
}
