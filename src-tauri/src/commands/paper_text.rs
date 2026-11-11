use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::process::Stdio;
use std::time::UNIX_EPOCH;

use tokio::process::Command;

/// Below this many characters we assume the PDF is scanned / image-only and
/// let the chat fall back to handing Claude the PDF itself.
const MIN_USEFUL_CHARS: usize = 1000;

fn cache_dir() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".reos").join("cache").join("paper-text"))
}

/// Plain text of a paper's PDF, for the chat's system prompt.
///
/// Papers live on Google Drive, where the first read of a PDF can take tens of
/// seconds; letting Claude open the PDF with its Read tool on every chat turn
/// was the dominant chat latency. We extract the text once with `pdftotext`
/// and cache it locally, keyed by path + size + mtime so a replaced PDF is
/// re-extracted. Returns `None` when extraction isn't possible (no
/// `pdftotext`, or a scanned PDF with no text layer).
#[tauri::command]
pub async fn paper_text(pdf_path: String) -> Result<Option<String>, String> {
    let meta = match tokio::fs::metadata(&pdf_path).await {
        Ok(m) => m,
        Err(_) => return Ok(None),
    };
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut hasher = DefaultHasher::new();
    pdf_path.hash(&mut hasher);
    meta.len().hash(&mut hasher);
    mtime.hash(&mut hasher);
    let key = format!("{:016x}", hasher.finish());

    let cache_file = cache_dir().map(|d| d.join(format!("{key}.txt")));
    if let Some(f) = &cache_file {
        if let Ok(text) = tokio::fs::read_to_string(f).await {
            return Ok(Some(text));
        }
    }

    // No `-layout`: the default mode follows reading order, which keeps
    // two-column papers readable.
    let mut cmd = Command::new("pdftotext");
    cmd.arg("-enc").arg("UTF-8").arg(&pdf_path).arg("-");
    super::claude_env::prepare(&mut cmd);
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);

    let output = match cmd.output().await {
        Ok(o) if o.status.success() => o,
        Ok(o) => {
            eprintln!("[paper_text] pdftotext exited {:?} for {pdf_path}", o.status.code());
            return Ok(None);
        }
        Err(e) => {
            eprintln!("[paper_text] pdftotext unavailable: {e}");
            return Ok(None);
        }
    };
    let text = String::from_utf8_lossy(&output.stdout).into_owned();
    if text.trim().chars().count() < MIN_USEFUL_CHARS {
        return Ok(None);
    }

    if let Some(f) = &cache_file {
        if let Some(dir) = f.parent() {
            let _ = tokio::fs::create_dir_all(dir).await;
        }
        let _ = tokio::fs::write(f, &text).await;
    }
    Ok(Some(text))
}
