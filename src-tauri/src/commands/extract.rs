use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tokio::process::Command;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractPdfArgs {
    pub pdf_path: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractedMetadata {
    pub title: String,
    pub authors: Vec<String>,
    pub year: String,
    #[serde(rename = "abstract")]
    pub abstract_text: String,
}

#[tauri::command]
pub async fn extract_pdf_metadata(args: ExtractPdfArgs) -> Result<ExtractedMetadata, String> {
    if !std::path::Path::new(&args.pdf_path).exists() {
        return Err(format!("PDF not found at: {}", args.pdf_path));
    }

    let prompt = format!(
        "Read the PDF at \"{}\" and extract the following metadata. Return ONLY a valid JSON object with these fields, no other text:\n{{\n  \"title\": \"the paper title\",\n  \"authors\": [\"author1\", \"author2\"],\n  \"year\": \"publication year as string\",\n  \"abstract\": \"the paper abstract\"\n}}\n\nIf you cannot find a field, use an empty string for strings or empty array for authors. Do not include any markdown formatting or code blocks, just raw JSON.",
        args.pdf_path
    );

    let mut cmd = Command::new("claude");
    cmd.arg("-p")
        .arg("--allowedTools")
        .arg("Read")
        .arg("--output-format")
        .arg("text")
        .arg("--")
        .arg(&prompt);

    // Match chat_stream's billing-safety: never silently use API keys when the
    // user has a Max OAuth session.
    cmd.env_remove("ANTHROPIC_API_KEY");
    cmd.env_remove("ANTHROPIC_AUTH_TOKEN");
    cmd.env_remove("CLAUDE_CODE_OAUTH_TOKEN");

    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    eprintln!("[extract_pdf_metadata] running claude on: {}", args.pdf_path);

    let output = cmd.output().await.map_err(|e| {
        format!("failed to spawn `claude` CLI: {e}. Ensure it is installed and on PATH.")
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let code = output.status.code().unwrap_or(-1);
        eprintln!("[extract_pdf_metadata] claude exited code={code}, stderr={stderr}");
        return Err(format!("Claude CLI exited with status {code}: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);

    // Claude sometimes wraps the JSON in prose or fenced blocks despite the
    // instruction; salvage the JSON object by slicing between the first '{'
    // and the last '}'.
    let start = stdout
        .find('{')
        .ok_or_else(|| format!("no JSON object found in claude output:\n{stdout}"))?;
    let end = stdout
        .rfind('}')
        .ok_or_else(|| format!("no JSON object close found in claude output:\n{stdout}"))?;
    let json_str = &stdout[start..=end];

    #[derive(Deserialize)]
    struct Raw {
        title: Option<String>,
        authors: Option<Vec<String>>,
        year: Option<serde_json::Value>,
        #[serde(rename = "abstract")]
        abstract_text: Option<String>,
    }

    let raw: Raw = serde_json::from_str(json_str)
        .map_err(|e| format!("failed to parse claude JSON: {e}\n--- json ---\n{json_str}"))?;

    let year = match raw.year {
        Some(serde_json::Value::String(s)) => s,
        Some(serde_json::Value::Number(n)) => n.to_string(),
        _ => String::new(),
    };

    Ok(ExtractedMetadata {
        title: raw.title.unwrap_or_default(),
        authors: raw.authors.unwrap_or_default(),
        year,
        abstract_text: raw.abstract_text.unwrap_or_default(),
    })
}
