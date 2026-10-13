use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use reqwest::header::{ACCEPT, AUTHORIZATION, CONTENT_TYPE, USER_AGENT};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::time::Duration;

const MCP_ENDPOINT: &str = "https://api.alphaxiv.org/mcp/v1";
const MCP_PROTOCOL_VERSION: &str = "2025-06-18";
const KEYRING_SERVICE: &str = "ai.relari.reos.alphaxiv";
const KEYRING_USER: &str = "api-key";
const MAX_MCP_RESPONSE_BYTES: usize = 50 * 1024 * 1024;
const MAX_OVERVIEW_PAGE_BYTES: usize = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES: usize = 15 * 1024 * 1024;
const MAX_IMAGES: usize = 24;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlphaXivCredentialStatus {
    configured: bool,
    hint: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlphaXivImage {
    file_name: String,
    mime_type: String,
    data: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlphaXivPaperContent {
    markdown: String,
    images: Vec<AlphaXivImage>,
    image_urls: Vec<String>,
    image_warning: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlphaXivFetchedImage {
    mime_type: String,
    data: String,
}

struct McpConnection {
    client: reqwest::Client,
    api_key: String,
    session_id: Option<String>,
    protocol_version: String,
}

fn credential_entry() -> Result<keyring::Entry, String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .map_err(|error| format!("Could not open the system credential vault: {error}"))
}

fn load_api_key() -> Result<String, String> {
    credential_entry()?
        .get_password()
        .map_err(|error| match error {
            keyring::Error::NoEntry => {
                "No AlphaXiv API key is configured. Add one in Settings.".to_string()
            }
            other => format!("Could not read the AlphaXiv API key: {other}"),
        })
}

#[tauri::command]
pub fn alphaxiv_credential_status() -> Result<AlphaXivCredentialStatus, String> {
    match credential_entry()?.get_password() {
        Ok(key) => {
            let suffix: String = key
                .chars()
                .rev()
                .take(4)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            Ok(AlphaXivCredentialStatus {
                configured: true,
                hint: Some(format!("••••{suffix}")),
            })
        }
        Err(keyring::Error::NoEntry) => Ok(AlphaXivCredentialStatus {
            configured: false,
            hint: None,
        }),
        Err(error) => Err(format!(
            "Could not read the AlphaXiv credential status: {error}"
        )),
    }
}

#[tauri::command]
pub fn save_alphaxiv_api_key(api_key: String) -> Result<AlphaXivCredentialStatus, String> {
    let trimmed = api_key.trim();
    if trimmed.len() < 16 || !trimmed.is_ascii() {
        return Err("Enter a valid AlphaXiv API key.".to_string());
    }
    credential_entry()?
        .set_password(trimmed)
        .map_err(|error| format!("Could not save the AlphaXiv API key: {error}"))?;
    alphaxiv_credential_status()
}

#[tauri::command]
pub fn delete_alphaxiv_api_key() -> Result<AlphaXivCredentialStatus, String> {
    match credential_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(AlphaXivCredentialStatus {
            configured: false,
            hint: None,
        }),
        Err(error) => Err(format!("Could not remove the AlphaXiv API key: {error}")),
    }
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .user_agent(format!("ReOS/{}", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|error| format!("Could not create the AlphaXiv HTTP client: {error}"))
}

fn api_error(status: reqwest::StatusCode, body: &str) -> String {
    match status.as_u16() {
        401 | 403 => "AlphaXiv rejected the API key. Replace it in Settings.".to_string(),
        429 => "AlphaXiv quota exceeded or temporarily rate limited this request.".to_string(),
        _ => {
            let detail = body.trim();
            if detail.is_empty() {
                format!("AlphaXiv returned HTTP {status}.")
            } else {
                format!("AlphaXiv returned HTTP {status}: {}", truncate(detail, 500))
            }
        }
    }
}

fn truncate(value: &str, max_chars: usize) -> String {
    let mut chars = value.chars();
    let prefix: String = chars.by_ref().take(max_chars).collect();
    if chars.next().is_some() {
        format!("{prefix}…")
    } else {
        prefix
    }
}

fn parse_mcp_body(body: &str) -> Result<Value, String> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return Ok(Value::Null);
    }
    if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
        return Ok(value);
    }

    // Streamable HTTP may answer with an SSE stream. The final JSON-RPC
    // response is the last data event containing either a result or error.
    let mut latest = None;
    for line in trimmed.lines() {
        let Some(data) = line.strip_prefix("data:") else {
            continue;
        };
        if let Ok(value) = serde_json::from_str::<Value>(data.trim()) {
            if value.get("result").is_some() || value.get("error").is_some() {
                latest = Some(value);
            }
        }
    }
    latest.ok_or_else(|| "AlphaXiv returned an unreadable MCP response.".to_string())
}

fn mcp_result(value: Value) -> Result<Value, String> {
    if let Some(error) = value.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("Unknown MCP error");
        return Err(format!("AlphaXiv MCP error: {message}"));
    }
    value
        .get("result")
        .cloned()
        .ok_or_else(|| "AlphaXiv returned no MCP result.".to_string())
}

impl McpConnection {
    async fn open(api_key: String) -> Result<Self, String> {
        let mut connection = Self {
            client: http_client()?,
            api_key,
            session_id: None,
            protocol_version: MCP_PROTOCOL_VERSION.to_string(),
        };
        let initialize = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {
                    "name": "ReOS",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }
        });
        let initialized = mcp_result(connection.post("initialize", None, initialize).await?)?;
        if let Some(version) = initialized.get("protocolVersion").and_then(Value::as_str) {
            connection.protocol_version = version.to_string();
        }
        connection.notify_initialized().await?;
        Ok(connection)
    }

    async fn post(
        &mut self,
        method: &str,
        name: Option<&str>,
        payload: Value,
    ) -> Result<Value, String> {
        let mut request = self
            .client
            .post(MCP_ENDPOINT)
            .header(AUTHORIZATION, format!("Bearer {}", self.api_key))
            .header(ACCEPT, "application/json, text/event-stream")
            .header(CONTENT_TYPE, "application/json")
            .header("MCP-Protocol-Version", &self.protocol_version)
            .header("Mcp-Method", method)
            .json(&payload);
        if let Some(name) = name {
            request = request.header("Mcp-Name", name);
        }
        if let Some(session_id) = &self.session_id {
            request = request.header("Mcp-Session-Id", session_id);
        }

        let response = request
            .send()
            .await
            .map_err(|error| format!("Could not reach AlphaXiv: {error}"))?;
        let status = response.status();
        let session_id = response
            .headers()
            .get("mcp-session-id")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let bytes = response
            .bytes()
            .await
            .map_err(|error| format!("Could not read the AlphaXiv response: {error}"))?;
        if bytes.len() > MAX_MCP_RESPONSE_BYTES {
            return Err("AlphaXiv returned a response that is too large to import.".to_string());
        }
        let body = String::from_utf8_lossy(&bytes);
        if !status.is_success() {
            return Err(api_error(status, &body));
        }
        if let Some(session_id) = session_id {
            self.session_id = Some(session_id);
        }
        parse_mcp_body(&body)
    }

    async fn notify_initialized(&mut self) -> Result<(), String> {
        let payload = json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
            "params": {}
        });
        let mut request = self
            .client
            .post(MCP_ENDPOINT)
            .header(AUTHORIZATION, format!("Bearer {}", self.api_key))
            .header(ACCEPT, "application/json, text/event-stream")
            .header(CONTENT_TYPE, "application/json")
            .header("MCP-Protocol-Version", &self.protocol_version)
            .header("Mcp-Method", "notifications/initialized")
            .json(&payload);
        if let Some(session_id) = &self.session_id {
            request = request.header("Mcp-Session-Id", session_id);
        }
        let response = request
            .send()
            .await
            .map_err(|error| format!("Could not initialize the AlphaXiv session: {error}"))?;
        if response.status().is_success() {
            Ok(())
        } else {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            Err(api_error(status, &body))
        }
    }

    async fn call_tool(&mut self, name: &str, arguments: Value) -> Result<Value, String> {
        let payload = json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {
                "name": name,
                "arguments": arguments
            }
        });
        mcp_result(self.post("tools/call", Some(name), payload).await?)
    }
}

#[tauri::command]
pub async fn test_alphaxiv_api_key() -> Result<(), String> {
    let api_key = load_api_key()?;
    let mut connection = McpConnection::open(api_key).await?;
    let payload = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/list",
        "params": {}
    });
    let result = mcp_result(connection.post("tools/list", None, payload).await?)?;
    let available = result
        .get("tools")
        .and_then(Value::as_array)
        .map(|tools| {
            tools
                .iter()
                .any(|tool| tool.get("name").and_then(Value::as_str) == Some("get_paper_content"))
        })
        .unwrap_or(false);
    if available {
        Ok(())
    } else {
        Err("The AlphaXiv connection worked, but get_paper_content is unavailable.".to_string())
    }
}

#[tauri::command]
pub async fn alphaxiv_get_paper_content(paper_url: String) -> Result<AlphaXivPaperContent, String> {
    let parsed =
        reqwest::Url::parse(&paper_url).map_err(|_| "The paper URL is invalid.".to_string())?;
    let allowed_host = matches!(parsed.host_str(), Some("arxiv.org" | "www.alphaxiv.org"));
    if parsed.scheme() != "https" || !allowed_host {
        return Err("AlphaXiv imports only accept HTTPS arXiv or AlphaXiv paper URLs.".to_string());
    }

    let api_key = load_api_key()?;
    let mut connection = McpConnection::open(api_key).await?;
    let result = connection
        .call_tool(
            "get_paper_content",
            json!({ "url": paper_url, "fullText": false }),
        )
        .await?;
    if result.get("isError").and_then(Value::as_bool) == Some(true) {
        let message = result
            .get("content")
            .and_then(Value::as_array)
            .and_then(|items| items.first())
            .and_then(|item| item.get("text"))
            .and_then(Value::as_str)
            .unwrap_or("AlphaXiv could not read this paper.");
        return Err(message.to_string());
    }

    let blocks = result
        .get("content")
        .and_then(Value::as_array)
        .ok_or_else(|| "AlphaXiv returned no paper content.".to_string())?;
    let mut parts = Vec::new();
    let mut images = Vec::new();
    for block in blocks {
        match block.get("type").and_then(Value::as_str) {
            Some("text") => {
                if let Some(text) = block.get("text").and_then(Value::as_str) {
                    if !text.trim().is_empty() {
                        parts.push(text.trim().to_string());
                    }
                }
            }
            Some("image") if images.len() < MAX_IMAGES => {
                let Some(data) = block.get("data").and_then(Value::as_str) else {
                    continue;
                };
                let mime_type = block
                    .get("mimeType")
                    .and_then(Value::as_str)
                    .unwrap_or("image/png")
                    .to_string();
                if !is_supported_image_mime(&mime_type) {
                    continue;
                }
                let decoded_size = BASE64
                    .decode(data)
                    .map_err(|_| "AlphaXiv returned an invalid image payload.".to_string())?
                    .len();
                if decoded_size > MAX_IMAGE_BYTES {
                    return Err("An AlphaXiv report image is too large to cache.".to_string());
                }
                let extension = extension_for_mime(&mime_type);
                let file_name = format!("alphaxiv-api-{:02}.{extension}", images.len() + 1);
                parts.push(format!(
                    "![AlphaXiv summary image](summary-assets/{file_name})"
                ));
                images.push(AlphaXivImage {
                    file_name,
                    mime_type,
                    data: data.to_string(),
                });
            }
            Some("resource") => {
                if let Some(text) = block
                    .get("resource")
                    .and_then(|resource| resource.get("text"))
                    .and_then(Value::as_str)
                {
                    if !text.trim().is_empty() {
                        parts.push(text.trim().to_string());
                    }
                }
            }
            _ => {}
        }
    }
    let markdown = parts.join("\n\n");
    if markdown.trim().is_empty() {
        return Err("AlphaXiv returned an empty paper report.".to_string());
    }
    let (image_urls, image_warning) =
        match fetch_overview_image_urls(&connection.client, &parsed).await {
            Ok(urls) => (urls, None),
            Err(error) => (Vec::new(), Some(error)),
        };
    Ok(AlphaXivPaperContent {
        markdown,
        images,
        image_urls,
        image_warning,
    })
}

#[tauri::command]
pub async fn alphaxiv_fetch_image(url: String) -> Result<AlphaXivFetchedImage, String> {
    let parsed =
        reqwest::Url::parse(&url).map_err(|_| "Invalid AlphaXiv image URL.".to_string())?;
    if parsed.scheme() != "https" || parsed.host_str() != Some("paper-assets.alphaxiv.org") {
        return Err("Only AlphaXiv paper image assets can be downloaded.".to_string());
    }
    let response = http_client()?
        .get(parsed)
        .header(USER_AGENT, format!("ReOS/{}", env!("CARGO_PKG_VERSION")))
        .send()
        .await
        .map_err(|error| format!("Could not download an AlphaXiv image: {error}"))?;
    if response.url().scheme() != "https"
        || response.url().host_str() != Some("paper-assets.alphaxiv.org")
    {
        return Err("AlphaXiv redirected an image request to an unsupported host.".to_string());
    }
    let status = response.status();
    if !status.is_success() {
        return Err(format!("AlphaXiv image download returned HTTP {status}."));
    }
    if response.content_length().unwrap_or(0) as usize > MAX_IMAGE_BYTES {
        return Err("An AlphaXiv image is too large to cache.".to_string());
    }
    let mime_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .unwrap_or("application/octet-stream")
        .to_string();
    if !is_supported_image_mime(&mime_type) {
        return Err(format!("Unsupported AlphaXiv image type: {mime_type}."));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Could not read an AlphaXiv image: {error}"))?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("An AlphaXiv image is too large to cache.".to_string());
    }
    Ok(AlphaXivFetchedImage {
        mime_type,
        data: BASE64.encode(bytes),
    })
}

fn is_supported_image_mime(mime_type: &str) -> bool {
    matches!(
        mime_type,
        "image/png" | "image/jpeg" | "image/webp" | "image/gif"
    )
}

fn extension_for_mime(mime_type: &str) -> &'static str {
    match mime_type {
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "png",
    }
}

fn canonical_arxiv_id(url: &reqwest::Url) -> Option<String> {
    let raw = url
        .path_segments()?
        .filter(|part| !part.is_empty())
        .next_back()?;
    let raw = raw.strip_suffix(".pdf").unwrap_or(raw);
    let base = match raw.rsplit_once('v') {
        Some((candidate, version))
            if !version.is_empty() && version.chars().all(|c| c.is_ascii_digit()) =>
        {
            candidate
        }
        _ => raw,
    };
    let (year_month, sequence) = base.split_once('.')?;
    if year_month.len() == 4
        && (sequence.len() == 4 || sequence.len() == 5)
        && year_month.chars().all(|c| c.is_ascii_digit())
        && sequence.chars().all(|c| c.is_ascii_digit())
    {
        Some(base.to_string())
    } else {
        None
    }
}

fn extract_overview_image_urls(html: &str, arxiv_id: &str) -> Vec<String> {
    const ASSET_PREFIX: &str = "https://paper-assets.alphaxiv.org/";
    let expected_path_prefix = format!("/figures-normalized/figures/{arxiv_id}v");
    let mut seen = HashSet::new();
    let mut urls = Vec::new();

    for (start, _) in html.match_indices(ASSET_PREFIX) {
        let remainder = &html[start..];
        let end = remainder
            .find(|character: char| {
                character.is_whitespace() || matches!(character, '"' | '\'' | '<' | '>' | '\\')
            })
            .unwrap_or(remainder.len());
        let candidate = &remainder[..end];
        let Ok(url) = reqwest::Url::parse(candidate) else {
            continue;
        };
        let supported_extension = url
            .path()
            .rsplit_once('.')
            .map(|(_, extension)| {
                matches!(
                    extension.to_ascii_lowercase().as_str(),
                    "png" | "jpg" | "jpeg" | "webp" | "gif"
                )
            })
            .unwrap_or(false);
        if url.scheme() == "https"
            && url.host_str() == Some("paper-assets.alphaxiv.org")
            && url.path().starts_with(&expected_path_prefix)
            && supported_extension
            && seen.insert(candidate.to_string())
        {
            urls.push(candidate.to_string());
            if urls.len() == MAX_IMAGES {
                break;
            }
        }
    }
    urls
}

async fn fetch_overview_image_urls(
    client: &reqwest::Client,
    paper_url: &reqwest::Url,
) -> Result<Vec<String>, String> {
    let arxiv_id = canonical_arxiv_id(paper_url)
        .ok_or_else(|| "Could not determine the arXiv ID for overview images.".to_string())?;
    let overview_url = reqwest::Url::parse(&format!("https://www.alphaxiv.org/abs/{arxiv_id}"))
        .map_err(|_| "Could not construct the AlphaXiv overview URL.".to_string())?;
    let response = client
        .get(overview_url)
        .header(USER_AGENT, format!("ReOS/{}", env!("CARGO_PKG_VERSION")))
        .send()
        .await
        .map_err(|error| format!("Could not check the AlphaXiv overview for images: {error}"))?;
    if response.url().scheme() != "https" || response.url().host_str() != Some("www.alphaxiv.org") {
        return Err("AlphaXiv redirected the overview to an unsupported host.".to_string());
    }
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "AlphaXiv overview image discovery returned HTTP {status}."
        ));
    }
    if response.content_length().unwrap_or(0) as usize > MAX_OVERVIEW_PAGE_BYTES {
        return Err("The AlphaXiv overview page is too large to inspect.".to_string());
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("Could not read the AlphaXiv overview: {error}"))?;
    if bytes.len() > MAX_OVERVIEW_PAGE_BYTES {
        return Err("The AlphaXiv overview page is too large to inspect.".to_string());
    }
    let html = String::from_utf8_lossy(&bytes);
    Ok(extract_overview_image_urls(&html, &arxiv_id))
}

#[cfg(test)]
mod tests {
    use super::{
        canonical_arxiv_id, extension_for_mime, extract_overview_image_urls,
        is_supported_image_mime, mcp_result, parse_mcp_body,
    };
    use serde_json::json;

    #[test]
    fn parses_json_mcp_response() {
        let value = parse_mcp_body(r#"{"jsonrpc":"2.0","id":1,"result":{"ok":true}}"#)
            .expect("valid JSON response");
        assert_eq!(mcp_result(value).unwrap(), json!({ "ok": true }));
    }

    #[test]
    fn parses_final_sse_result() {
        let body = concat!(
            "event: message\n",
            "data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\n\n",
            "event: message\n",
            "data: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"content\":[]}}\n\n"
        );
        let value = parse_mcp_body(body).expect("valid SSE response");
        assert_eq!(mcp_result(value).unwrap(), json!({ "content": [] }));
    }

    #[test]
    fn reports_mcp_errors_without_debug_payloads() {
        let error = mcp_result(json!({
            "jsonrpc": "2.0",
            "id": 2,
            "error": { "code": -32602, "message": "Bad arguments" }
        }))
        .unwrap_err();
        assert_eq!(error, "AlphaXiv MCP error: Bad arguments");
    }

    #[test]
    fn maps_supported_image_types_to_safe_extensions() {
        assert_eq!(extension_for_mime("image/jpeg"), "jpg");
        assert_eq!(extension_for_mime("image/webp"), "webp");
        assert_eq!(extension_for_mime("image/svg+xml"), "png");
        assert!(is_supported_image_mime("image/png"));
        assert!(!is_supported_image_mime("image/svg+xml"));
    }

    #[test]
    fn extracts_deduplicated_overview_figure_urls_for_the_requested_paper() {
        let html = concat!(
            r#"<link rel="preload" as="image" href="https://paper-assets.alphaxiv.org/figures-normalized/figures/2607.15275v1/x1.png">"#,
            r#"<img src="https://paper-assets.alphaxiv.org/figures-normalized/figures/2607.15275v1/x1.png">"#,
            r#"<img src="https://paper-assets.alphaxiv.org/figures-normalized/figures/2607.15275v1/x2.webp">"#,
            r#"<img src="https://paper-assets.alphaxiv.org/figures-normalized/figures/9999.99999v1/x1.png">"#,
            r#"<img src="https://user.assets.alphaxiv.org/photo.png">"#,
        );
        assert_eq!(
            extract_overview_image_urls(html, "2607.15275"),
            vec![
                "https://paper-assets.alphaxiv.org/figures-normalized/figures/2607.15275v1/x1.png",
                "https://paper-assets.alphaxiv.org/figures-normalized/figures/2607.15275v1/x2.webp",
            ]
        );
    }

    #[test]
    fn reads_canonical_arxiv_id_from_supported_paper_urls() {
        let alpha = reqwest::Url::parse("https://www.alphaxiv.org/abs/2607.15275").unwrap();
        let arxiv = reqwest::Url::parse("https://arxiv.org/pdf/2607.15275v2.pdf").unwrap();
        assert_eq!(canonical_arxiv_id(&alpha).as_deref(), Some("2607.15275"));
        assert_eq!(canonical_arxiv_id(&arxiv).as_deref(), Some("2607.15275"));
    }
}
