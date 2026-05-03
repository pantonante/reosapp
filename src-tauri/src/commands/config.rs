use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReosConfig {
    pub papers_dir: Option<String>,
}

fn config_dir() -> AppResult<PathBuf> {
    let home = dirs::home_dir().ok_or(AppError::NoHome)?;
    Ok(home.join(".reos"))
}

fn config_file() -> AppResult<PathBuf> {
    Ok(config_dir()?.join("config.json"))
}

pub fn ensure_config_dir() -> AppResult<()> {
    let dir = config_dir()?;
    if !dir.exists() {
        fs::create_dir_all(&dir)?;
    }
    let cache_dir = dir.join("cache");
    if !cache_dir.exists() {
        fs::create_dir_all(&cache_dir)?;
    }
    Ok(())
}

#[tauri::command]
pub fn load_config() -> AppResult<ReosConfig> {
    let path = config_file()?;
    if !path.exists() {
        return Ok(ReosConfig::default());
    }
    let raw = fs::read_to_string(&path)?;
    let cfg: ReosConfig = serde_json::from_str(&raw).unwrap_or_default();
    Ok(cfg)
}

#[tauri::command]
pub fn save_config(config: ReosConfig) -> AppResult<()> {
    ensure_config_dir()?;
    let path = config_file()?;
    let pretty = serde_json::to_string_pretty(&config)?;
    fs::write(&path, pretty)?;
    Ok(())
}

#[tauri::command]
pub fn config_path() -> AppResult<String> {
    Ok(config_file()?.to_string_lossy().into_owned())
}
