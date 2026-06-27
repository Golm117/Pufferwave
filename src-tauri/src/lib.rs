mod chat;

use chat::Cancels;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_sql::Builder::default().build())
    .manage(Cancels::default())
    .invoke_handler(tauri::generate_handler![
      chat::chat,
      chat::cancel_chat,
      chat::list_models,
      chat::set_anthropic_key,
      chat::anthropic_key_set,
      chat::clear_anthropic_key
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
