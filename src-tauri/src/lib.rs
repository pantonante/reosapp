mod commands;
mod error;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(
            tauri_plugin_sql::Builder::default()
                .build(),
        )
        .manage(commands::chat::ChatRegistry::default())
        .manage(commands::remote_server::RemoteServer::default())
        .setup(|app| {
            commands::config::ensure_config_dir().map_err(|e| e.to_string())?;
            if commands::config::load_config()?.server_enabled {
                if let Err(error) = commands::remote_server::start(&app.state::<commands::remote_server::RemoteServer>()) {
                    eprintln!("[remote_server] Could not restore server: {error}");
                }
            }
            #[cfg(debug_assertions)]
            {
                let window = app.get_webview_window("main").unwrap();
                window.open_devtools();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::alphaxiv::alphaxiv_credential_status,
            commands::alphaxiv::save_alphaxiv_api_key,
            commands::alphaxiv::delete_alphaxiv_api_key,
            commands::alphaxiv::test_alphaxiv_api_key,
            commands::alphaxiv::alphaxiv_get_paper_content,
            commands::alphaxiv::alphaxiv_fetch_image,
            commands::config::load_config,
            commands::config::save_config,
            commands::config::config_path,
            commands::rebuild_cache::rebuild_cache,
            commands::chat::chat_stream,
            commands::chat::chat_cancel,
            commands::extract::extract_pdf_metadata,
            commands::extract::extract_webpage_metadata,
            commands::finder::reveal_in_finder,
            commands::remote_server::remote_server_status,
            commands::remote_server::set_remote_server_enabled,
            commands::remote_server::set_remote_open_papers,
            commands::remote_server::share_remote_address,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
