// chat.rs — Rust port of the inference backend (the Next route's job).
//
// The frontend calls invoke("chat", { payload, onEvent, requestId }) with a Channel; we
// shape the request per provider and stream UNIFORM events back over the channel:
//   Delta{text} | Done | Error{kind,message}  -> {"type":"delta"|"done"|"error", ...}
// Cancellation: a per-request CancellationToken in shared state; invoke("cancel_chat", …)
// cancels it, which drops the upstream stream (stops Ollama too).

use std::collections::HashMap;
use std::sync::Mutex;

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tauri::ipc::Channel;
use tauri::State;
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
pub struct Message {
    pub role: String,
    pub content: String,
}

#[derive(Deserialize)]
pub struct ChatPayload {
    pub provider: String,
    pub model: String,
    #[serde(default)]
    pub system_prompt: String,
    #[serde(default)]
    pub params: Value,
    #[serde(default)]
    pub messages: Vec<Message>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum UniformEvent {
    Delta { text: String },
    Done,
    Error { kind: String, message: String },
}

#[derive(Default)]
pub struct Cancels(pub Mutex<HashMap<String, CancellationToken>>);

fn ollama_host() -> String {
    std::env::var("OLLAMA_HOST").unwrap_or_else(|_| "http://localhost:11434".to_string())
}

fn num_param(params: &Value, key: &str) -> Option<f64> {
    match params.get(key) {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(s)) if !s.is_empty() => s.parse().ok(),
        _ => None,
    }
}

#[tauri::command]
pub async fn cancel_chat(request_id: String, cancels: State<'_, Cancels>) -> Result<(), String> {
    if let Some(tok) = cancels.0.lock().unwrap().get(&request_id) {
        tok.cancel();
    }
    Ok(())
}

#[tauri::command]
pub async fn chat(
    payload: ChatPayload,
    on_event: Channel<UniformEvent>,
    request_id: String,
    cancels: State<'_, Cancels>,
) -> Result<(), String> {
    let token = CancellationToken::new();
    cancels
        .0
        .lock()
        .unwrap()
        .insert(request_id.clone(), token.clone());

    let result = match payload.provider.as_str() {
        "ollama" => ollama_chat(&payload, &on_event, &token).await,
        other => {
            let _ = on_event.send(UniformEvent::Error {
                kind: "bad_request".into(),
                message: format!("Provider \u{201c}{other}\u{201d} is not available yet."),
            });
            Ok(())
        }
    };

    cancels.0.lock().unwrap().remove(&request_id);
    result
}

async fn ollama_chat(
    payload: &ChatPayload,
    on_event: &Channel<UniformEvent>,
    token: &CancellationToken,
) -> Result<(), String> {
    // Ollama takes the system prompt as a leading system message.
    let mut messages: Vec<Value> = Vec::new();
    if !payload.system_prompt.trim().is_empty() {
        messages.push(json!({ "role": "system", "content": payload.system_prompt }));
    }
    for m in &payload.messages {
        messages.push(json!({ "role": m.role, "content": m.content }));
    }

    let mut options = Map::new();
    if let Some(t) = num_param(&payload.params, "temperature") {
        options.insert("temperature".into(), json!(t));
    }
    if let Some(n) = num_param(&payload.params, "num_ctx") {
        options.insert("num_ctx".into(), json!(n as i64));
    }

    let mut body = json!({
        "model": payload.model,
        "messages": messages,
        "stream": true,
    });
    if !options.is_empty() {
        body["options"] = Value::Object(options);
    }

    let host = ollama_host();
    let client = reqwest::Client::new();
    let resp = match client
        .post(format!("{host}/api/chat"))
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(_) => {
            let _ = on_event.send(UniformEvent::Error {
                kind: "unreachable".into(),
                message: format!("Cannot reach Ollama at {host}. Is `ollama serve` running?"),
            });
            return Ok(());
        }
    };

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let lower = text.to_lowercase();
        let kind = if lower.contains("not found") || lower.contains("try pulling") {
            "model_missing"
        } else {
            "upstream_error"
        };
        let _ = on_event.send(UniformEvent::Error {
            kind: kind.into(),
            message: if text.is_empty() {
                format!("Ollama responded {status}.")
            } else {
                text
            },
        });
        return Ok(());
    }

    let mut stream = resp.bytes_stream();
    let mut buffer = String::new();

    loop {
        tokio::select! {
            _ = token.cancelled() => {
                // Client hit Stop. Returning drops `stream`, which aborts the upstream
                // request so Ollama stops generating too.
                return Ok(());
            }
            chunk = stream.next() => {
                match chunk {
                    None => break,
                    Some(Err(_)) => {
                        let _ = on_event.send(UniformEvent::Error {
                            kind: "interrupted".into(),
                            message: "The connection dropped mid-response.".into(),
                        });
                        return Ok(());
                    }
                    Some(Ok(bytes)) => {
                        buffer.push_str(&String::from_utf8_lossy(&bytes));
                        while let Some(nl) = buffer.find('\n') {
                            let line = buffer[..nl].trim().to_string();
                            buffer.drain(..=nl);
                            if line.is_empty() {
                                continue;
                            }
                            let obj: Value = match serde_json::from_str(&line) {
                                Ok(v) => v,
                                Err(_) => continue,
                            };
                            if let Some(err) = obj.get("error").and_then(|e| e.as_str()) {
                                let _ = on_event.send(UniformEvent::Error {
                                    kind: "interrupted".into(),
                                    message: err.to_string(),
                                });
                                return Ok(());
                            }
                            if let Some(delta) = obj
                                .get("message")
                                .and_then(|m| m.get("content"))
                                .and_then(|c| c.as_str())
                            {
                                if !delta.is_empty() {
                                    let _ = on_event.send(UniformEvent::Delta {
                                        text: delta.to_string(),
                                    });
                                }
                            }
                            if obj.get("done").and_then(|d| d.as_bool()).unwrap_or(false) {
                                let _ = on_event.send(UniformEvent::Done);
                                return Ok(());
                            }
                        }
                    }
                }
            }
        }
    }

    // Reached only when the stream ended without a done:true line.
    let _ = on_event.send(UniformEvent::Error {
        kind: "interrupted".into(),
        message: "The stream ended unexpectedly.".into(),
    });
    Ok(())
}
