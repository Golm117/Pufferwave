// selfedit.rs — dev-mode self-modification.
//
// Pufferwave drives Claude Code (headless) on its OWN repo: a prompt becomes real source
// edits, which `tauri dev` applies live (HMR for the frontend, rebuild for Rust). git is
// the safety net — review the change, then commit (keep) or revert (discard). This only
// works on a dev checkout (it needs the repo + the `claude` CLI + the toolchain).

use std::env;
use std::path::{Path, PathBuf};
use tokio::process::Command;

use crate::chat::read_anthropic_key;

// src-tauri's parent is the repo root (the binary is compiled in place in dev).
fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or(Path::new("."))
        .to_path_buf()
}

async fn run(cmd: &str, args: &[&str], dir: &Path) -> Result<String, String> {
    let out = Command::new(cmd)
        .args(args)
        .current_dir(dir)
        .output()
        .await
        .map_err(|e| format!("failed to run {cmd}: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).to_string();
        return Err(if err.trim().is_empty() {
            format!("{cmd} exited with {}", out.status)
        } else {
            err
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

// Drive Claude Code headless on the repo. Returns its final transcript text.
//
// Auth: spawn `claude` with a CLEAN env — drop any inherited Claude Code session vars and
// Anthropic base-url/token overrides (which would make a child process fail to
// authenticate), and authenticate with the user's own Anthropic key from the keychain.
// This makes self-edit independent of whatever `claude` login state the machine has.
#[tauri::command]
pub async fn modify(prompt: String) -> Result<String, String> {
    let repo = repo_root();
    let key = read_anthropic_key().ok_or_else(|| {
        "No Anthropic API key set. Add it in Settings (⚙) — self-edit uses it to run Claude Code."
            .to_string()
    })?;

    let clean_env: Vec<(String, String)> = env::vars()
        .filter(|(k, _)| {
            !(k.starts_with("CLAUDE_CODE_")
                || k.starts_with("CLAUDE_AGENT_")
                || k == "CLAUDE_EFFORT"
                || k == "ANTHROPIC_BASE_URL"
                || k == "ANTHROPIC_AUTH_TOKEN"
                || k == "ANTHROPIC_API_KEY")
        })
        .collect();

    let out = Command::new("claude")
        .arg("-p")
        .arg(&prompt)
        .arg("--dangerously-skip-permissions") // headless: no TTY to approve tools; git is the rollback
        .current_dir(&repo)
        .env_clear()
        .envs(clean_env)
        .env("ANTHROPIC_API_KEY", &key)
        .output()
        .await
        .map_err(|e| {
            format!("Couldn't run Claude Code: {e}. Is `claude` installed and on your PATH?")
        })?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    if !out.status.success() {
        return Err(if stderr.trim().is_empty() { stdout } else { stderr });
    }
    Ok(stdout)
}

// Concise change list of the working tree (`git status --short`).
#[tauri::command]
pub async fn repo_status() -> Result<String, String> {
    run("git", &["status", "--short"], &repo_root()).await
}

// Full unified diff of the working tree (tracked changes).
#[tauri::command]
pub async fn repo_diff() -> Result<String, String> {
    run("git", &["diff"], &repo_root()).await
}

#[tauri::command]
pub async fn repo_commit(message: String) -> Result<(), String> {
    let repo = repo_root();
    run("git", &["add", "-A"], &repo).await?;
    run("git", &["commit", "-m", &message], &repo).await?;
    Ok(())
}

// Discard ALL uncommitted changes — staged + unstaged tracked edits, plus new untracked
// files. (reset --hard catches staged changes that `git restore .` would miss.)
#[tauri::command]
pub async fn repo_revert() -> Result<(), String> {
    let repo = repo_root();
    run("git", &["reset", "--hard", "HEAD"], &repo).await?;
    run("git", &["clean", "-fd"], &repo).await?;
    Ok(())
}

// Undo the most recent commit (for when a self-edit was already committed).
#[tauri::command]
pub async fn repo_undo_last() -> Result<(), String> {
    run("git", &["reset", "--hard", "HEAD~1"], &repo_root()).await?;
    Ok(())
}

// Subject line of HEAD — shown so the user knows what "Undo last commit" would remove.
#[tauri::command]
pub async fn repo_head_subject() -> Result<String, String> {
    let s = run("git", &["log", "-1", "--format=%s"], &repo_root()).await?;
    Ok(s.trim().to_string())
}
