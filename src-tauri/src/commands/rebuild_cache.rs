// Cache rebuild lives on the TS side via tauri-plugin-sql + tauri-plugin-fs.
// This command exists as a no-op shim so the frontend can call a single
// invoke target while it gathers the work itself; in V1 the rebuild orchestration
// happens in src/lib/tauri/rebuild.ts.

#[tauri::command]
pub async fn rebuild_cache() -> Result<(), String> {
    Ok(())
}
