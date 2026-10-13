use std::collections::HashMap;
use std::fs;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::extract::{Path as RoutePath, Query, State};
use axum::http::header::{CACHE_CONTROL, CONTENT_TYPE, COOKIE, HOST, ORIGIN, RANGE, SET_COOKIE};
use axum::http::{HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State as TauriState};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use tokio::sync::oneshot;
use tokio_util::io::ReaderStream;
use uuid::Uuid;

use super::config::{load_config, save_config};

const PORT: u16 = 3847;
const MAX_NOTES_BYTES: usize = 1024 * 1024;

#[derive(Default)]
pub struct RemoteServer {
    running: Mutex<Option<RunningServer>>,
    open_papers: Arc<Mutex<OpenPaperState>>,
}

pub struct RunningServer {
    shutdown: oneshot::Sender<()>,
    token: String,
}

#[derive(Clone)]
struct RemoteContext {
    token: String,
    open_papers: Arc<Mutex<OpenPaperState>>,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenPaperState {
    ids: Vec<String>,
    active_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteServerStatus {
    enabled: bool,
    running: bool,
    addresses: Vec<String>,
    port: u16,
    airdrop_available: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteThread {
    id: String,
    title: String,
    question: String,
    status: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemotePaper {
    id: String,
    thread_id: String,
    title: String,
    authors: Vec<String>,
    abstract_text: String,
    published_date: String,
    reading_status: String,
    has_pdf: bool,
    has_summary: bool,
    has_notes: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Library {
    threads: Vec<RemoteThread>,
    papers: Vec<RemotePaper>,
}

#[derive(Serialize, Deserialize)]
struct TextDocument {
    text: String,
}

fn lan_addresses(token: &str) -> Vec<String> {
    let mut ips: Vec<Ipv4Addr> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|interface| match interface.ip() {
            IpAddr::V4(ip) if !ip.is_loopback() && !ip.is_link_local() => Some(ip),
            _ => None,
        })
        .collect();
    ips.sort();
    ips.dedup();
    ips.into_iter()
        .map(|ip| format!("http://{ip}:{PORT}/?token={token}"))
        .collect()
}

fn status(server: &RemoteServer) -> RemoteServerStatus {
    let guard = server.running.lock().expect("remote server mutex poisoned");
    let enabled = load_config()
        .map(|config| config.server_enabled)
        .unwrap_or(false);
    RemoteServerStatus {
        enabled,
        running: guard.is_some(),
        addresses: guard
            .as_ref()
            .map(|running| lan_addresses(&running.token))
            .unwrap_or_default(),
        port: PORT,
        airdrop_available: cfg!(target_os = "macos"),
    }
}

#[tauri::command]
pub fn remote_server_status(server: TauriState<'_, RemoteServer>) -> RemoteServerStatus {
    status(&server)
}

#[tauri::command]
pub fn set_remote_open_papers(
    server: TauriState<'_, RemoteServer>,
    ids: Vec<String>,
    active_id: Option<String>,
) {
    let ids: Vec<String> = ids
        .into_iter()
        .filter(|id| {
            id.len() <= 128
                && id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
        })
        .take(1000)
        .collect();
    let active_id = active_id.filter(|id| ids.contains(id));
    if let Ok(mut open) = server.open_papers.lock() {
        *open = OpenPaperState { ids, active_id };
    }
}

#[tauri::command]
pub fn set_remote_server_enabled(
    server: TauriState<'_, RemoteServer>,
    enabled: bool,
) -> Result<RemoteServerStatus, String> {
    let mut config = load_config().map_err(|e| e.to_string())?;
    if enabled {
        start(&server)?;
        config.server_enabled = true;
        if let Err(error) = save_config(config) {
            stop(&server);
            return Err(error.to_string());
        }
    } else {
        config.server_enabled = false;
        save_config(config).map_err(|e| e.to_string())?;
        stop(&server);
    }
    Ok(status(&server))
}

#[tauri::command]
pub async fn share_remote_address(
    app: AppHandle,
    server: TauriState<'_, RemoteServer>,
    address: String,
) -> Result<(), String> {
    let current = status(&server);
    if !current.running || !current.addresses.contains(&address) {
        return Err(
            "This iPad address is no longer active. Refresh Settings and try again.".into(),
        );
    }

    #[cfg(target_os = "macos")]
    {
        use objc2::runtime::AnyObject;
        use objc2_app_kit::{NSSharingService, NSSharingServiceNameSendViaAirDrop};
        use objc2_foundation::{NSArray, NSString, NSURL};

        let (sender, receiver) = tokio::sync::oneshot::channel();
        app.run_on_main_thread(move || {
            let result = (|| {
                let url = NSURL::URLWithString(&NSString::from_str(&address))
                    .ok_or("Could not create an AirDrop link.")?;
                let items = NSArray::<AnyObject>::from_slice(&[url.as_ref()]);
                let service = NSSharingService::sharingServiceNamed(unsafe {
                    NSSharingServiceNameSendViaAirDrop
                })
                .ok_or("AirDrop is not available on this Mac.")?;
                if !unsafe { service.canPerformWithItems(Some(&items)) } {
                    return Err("AirDrop cannot share this address right now.");
                }
                unsafe { service.performWithItems(&items) };
                Ok(())
            })();
            let _ = sender.send(result.map_err(str::to_owned));
        })
        .map_err(|e| e.to_string())?;
        receiver.await.map_err(|e| e.to_string())?
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        Err("AirDrop is available only on macOS.".into())
    }
}

pub fn start(server: &RemoteServer) -> Result<(), String> {
    let mut guard = server.running.lock().map_err(|e| e.to_string())?;
    if guard.is_some() {
        return Ok(());
    }
    let config = load_config().map_err(|e| e.to_string())?;
    let papers_dir = config
        .papers_dir
        .ok_or("Choose a papers folder before starting the iPad server.")?;
    if !Path::new(&papers_dir).is_dir() {
        return Err("The configured papers folder does not exist.".into());
    }
    let listener = std::net::TcpListener::bind(SocketAddr::from(([0, 0, 0, 0], PORT)))
        .map_err(|e| format!("Could not listen on port {PORT}: {e}"))?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let token = Uuid::new_v4().simple().to_string();
    let context = RemoteContext {
        token: token.clone(),
        open_papers: server.open_papers.clone(),
    };
    let router = Router::new()
        .route("/", get(index))
        .route("/api/library", get(library))
        .route("/api/open-papers", get(open_papers))
        .route("/api/papers/{id}/summary", get(summary))
        .route("/api/papers/{id}/notes", get(notes).put(save_notes))
        .route("/api/papers/{id}/pdf", get(pdf))
        .route("/assets/pdf.min.mjs", get(pdfjs_core))
        .route("/assets/pdf.worker.min.mjs", get(pdfjs_worker))
        .route("/assets/pdf_viewer.mjs", get(pdfjs_viewer))
        .route("/assets/pdf_viewer.css", get(pdfjs_viewer_css))
        .route("/assets/reader.mjs", get(reader_script))
        .with_state(context);
    let (shutdown, rx) = oneshot::channel();
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("[remote_server] Could not create async listener: {error}");
                return;
            }
        };
        if let Err(error) = axum::serve(listener, router)
            .with_graceful_shutdown(async move {
                let _ = rx.await;
            })
            .await
        {
            eprintln!("[remote_server] {error}");
        }
    });
    *guard = Some(RunningServer { shutdown, token });
    Ok(())
}

fn stop(server: &RemoteServer) {
    if let Ok(mut guard) = server.running.lock() {
        if let Some(running) = guard.take() {
            let _ = running.shutdown.send(());
        }
    }
}

fn authorized(headers: &HeaderMap, token: &str) -> bool {
    headers
        .get(COOKIE)
        .and_then(|value| value.to_str().ok())
        .and_then(|cookies| {
            cookies
                .split(';')
                .map(str::trim)
                .find_map(|part| part.strip_prefix("reos_remote="))
        })
        == Some(token)
}

fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

async fn index(
    State(context): State<RemoteContext>,
    headers: HeaderMap,
    Query(query): Query<HashMap<String, String>>,
) -> Response {
    if query.get("token") == Some(&context.token) {
        let mut response = no_store((StatusCode::SEE_OTHER, [("location", "/")]).into_response());
        response.headers_mut().insert(
            SET_COOKIE,
            HeaderValue::from_str(&format!(
                "reos_remote={}; HttpOnly; SameSite=Strict; Path=/",
                context.token
            ))
            .expect("token contains only hex digits"),
        );
        return response;
    }
    if !authorized(&headers, &context.token) {
        return no_store(
            (
                StatusCode::UNAUTHORIZED,
                "Open the address shown in Re:OS Settings.",
            )
                .into_response(),
        );
    }
    no_store(
        (
            [(CONTENT_TYPE, "text/html; charset=utf-8")],
            include_str!("../remote/index.html"),
        )
            .into_response(),
    )
}

async fn open_papers(State(context): State<RemoteContext>, headers: HeaderMap) -> Response {
    if !authorized(&headers, &context.token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Ok(open) = context.open_papers.lock() else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    no_store(Json(open.clone()).into_response())
}

fn static_asset(
    context: RemoteContext,
    headers: HeaderMap,
    content_type: &'static str,
    body: &'static str,
) -> Response {
    if !authorized(&headers, &context.token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    no_store(([(CONTENT_TYPE, content_type)], body).into_response())
}

async fn pdfjs_core(State(context): State<RemoteContext>, headers: HeaderMap) -> Response {
    static_asset(
        context,
        headers,
        "text/javascript; charset=utf-8",
        include_str!("../../../node_modules/pdfjs-dist/build/pdf.min.mjs"),
    )
}

async fn pdfjs_worker(State(context): State<RemoteContext>, headers: HeaderMap) -> Response {
    static_asset(
        context,
        headers,
        "text/javascript; charset=utf-8",
        include_str!("../../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs"),
    )
}

async fn pdfjs_viewer(State(context): State<RemoteContext>, headers: HeaderMap) -> Response {
    static_asset(
        context,
        headers,
        "text/javascript; charset=utf-8",
        include_str!("../../../node_modules/pdfjs-dist/web/pdf_viewer.mjs"),
    )
}

async fn pdfjs_viewer_css(State(context): State<RemoteContext>, headers: HeaderMap) -> Response {
    static_asset(
        context,
        headers,
        "text/css; charset=utf-8",
        include_str!("../../../node_modules/pdfjs-dist/web/pdf_viewer.css"),
    )
}

async fn reader_script(State(context): State<RemoteContext>, headers: HeaderMap) -> Response {
    static_asset(
        context,
        headers,
        "text/javascript; charset=utf-8",
        include_str!("../remote/reader.mjs"),
    )
}

fn papers_root() -> Result<PathBuf, StatusCode> {
    let config = load_config().map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    config
        .papers_dir
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)
}

fn paper_location(root: &Path, id: &str) -> Result<PathBuf, StatusCode> {
    if id.is_empty()
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let threads = fs::read_dir(root.join("threads")).map_err(|_| StatusCode::NOT_FOUND)?;
    for thread in threads.flatten() {
        if !thread
            .file_type()
            .map(|kind| kind.is_dir())
            .unwrap_or(false)
        {
            continue;
        }
        let papers = match fs::read_dir(thread.path().join("papers")) {
            Ok(papers) => papers,
            Err(_) => continue,
        };
        for paper in papers.flatten() {
            if !paper.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                continue;
            }
            let meta = paper.path().join("meta.json");
            let Ok(value) = fs::read_to_string(meta) else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&value) else {
                continue;
            };
            if value.get("id").and_then(|v| v.as_str()) == Some(id) {
                return Ok(paper.path());
            }
        }
    }
    Err(StatusCode::NOT_FOUND)
}

async fn library(State(context): State<RemoteContext>, headers: HeaderMap) -> Response {
    if !authorized(&headers, &context.token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Ok(root) = papers_root() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let mut result = Library {
        threads: Vec::new(),
        papers: Vec::new(),
    };
    let Ok(thread_dirs) = fs::read_dir(root.join("threads")) else {
        return Json(result).into_response();
    };
    for entry in thread_dirs.flatten() {
        if !entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
            continue;
        }
        let thread_id = entry.file_name().to_string_lossy().into_owned();
        let meta = fs::read_to_string(entry.path().join("meta.json"))
            .ok()
            .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
        let title = meta
            .as_ref()
            .and_then(|m| m.get("title"))
            .and_then(|v| v.as_str())
            .unwrap_or(&thread_id);
        let question = meta
            .as_ref()
            .and_then(|m| m.get("question"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let status = meta
            .as_ref()
            .and_then(|m| m.get("status"))
            .and_then(|v| v.as_str())
            .unwrap_or("active");
        result.threads.push(RemoteThread {
            id: thread_id.clone(),
            title: title.to_owned(),
            question: question.to_owned(),
            status: status.to_owned(),
        });
        let Ok(papers) = fs::read_dir(entry.path().join("papers")) else {
            continue;
        };
        for paper in papers.flatten() {
            if !paper.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                continue;
            }
            let path = paper.path();
            let Some(meta) = fs::read_to_string(path.join("meta.json"))
                .ok()
                .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
            else {
                continue;
            };
            let Some(id) = meta.get("id").and_then(|v| v.as_str()) else {
                continue;
            };
            let title = meta
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("Untitled paper");
            let authors = meta
                .get("authors")
                .and_then(|v| v.as_array())
                .map(|items| {
                    items
                        .iter()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect()
                })
                .unwrap_or_default();
            result.papers.push(RemotePaper {
                id: id.to_owned(),
                thread_id: thread_id.clone(),
                title: title.to_owned(),
                authors,
                abstract_text: meta
                    .get("abstract")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_owned(),
                published_date: meta
                    .get("publishedDate")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_owned(),
                reading_status: meta
                    .get("readingStatus")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unread")
                    .to_owned(),
                has_pdf: path.join("paper.pdf").is_file(),
                has_summary: path.join("summary.md").is_file(),
                has_notes: path.join("notes.md").is_file(),
            });
        }
    }
    result.threads.sort_by(|a, b| a.title.cmp(&b.title));
    result.papers.sort_by(|a, b| a.title.cmp(&b.title));
    no_store(Json(result).into_response())
}

async fn text_file(context: RemoteContext, headers: HeaderMap, id: String, name: &str) -> Response {
    if !authorized(&headers, &context.token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Ok(root) = papers_root() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let Ok(path) = paper_location(&root, &id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let text = fs::read_to_string(path.join(name)).unwrap_or_default();
    no_store(Json(TextDocument { text }).into_response())
}

async fn summary(
    State(context): State<RemoteContext>,
    headers: HeaderMap,
    RoutePath(id): RoutePath<String>,
) -> Response {
    text_file(context, headers, id, "summary.md").await
}

async fn notes(
    State(context): State<RemoteContext>,
    headers: HeaderMap,
    RoutePath(id): RoutePath<String>,
) -> Response {
    text_file(context, headers, id, "notes.md").await
}

async fn save_notes(
    State(context): State<RemoteContext>,
    headers: HeaderMap,
    RoutePath(id): RoutePath<String>,
    Json(document): Json<TextDocument>,
) -> Response {
    if !authorized(&headers, &context.token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let host = headers
        .get(HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let origin = headers
        .get(ORIGIN)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if origin != format!("http://{host}") {
        return StatusCode::FORBIDDEN.into_response();
    }
    if document.text.len() > MAX_NOTES_BYTES {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    }
    let Ok(root) = papers_root() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let Ok(path) = paper_location(&root, &id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let target = path.join("notes.md");
    let temporary = path.join(format!(".notes-{}.tmp", Uuid::new_v4()));
    if fs::write(&temporary, document.text).is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if fs::rename(&temporary, &target).is_err() {
        let _ = fs::remove_file(&temporary);
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    StatusCode::NO_CONTENT.into_response()
}

async fn pdf(
    State(context): State<RemoteContext>,
    headers: HeaderMap,
    RoutePath(id): RoutePath<String>,
) -> Response {
    if !authorized(&headers, &context.token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Ok(root) = papers_root() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let Ok(folder) = paper_location(&root, &id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(mut file) = tokio::fs::File::open(folder.join("paper.pdf")).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(metadata) = file.metadata().await else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let size = metadata.len();
    let requested = headers.get(RANGE).and_then(|v| v.to_str().ok());
    let (start, end, partial) = match requested {
        Some(raw) if raw.starts_with("bytes=") => {
            let raw = &raw[6..];
            let Some((first, last)) = raw.split_once('-') else {
                return StatusCode::RANGE_NOT_SATISFIABLE.into_response();
            };
            let (start, end) = if first.is_empty() {
                let Ok(suffix) = last.parse::<u64>() else {
                    return StatusCode::RANGE_NOT_SATISFIABLE.into_response();
                };
                if suffix == 0 || size == 0 {
                    return StatusCode::RANGE_NOT_SATISFIABLE.into_response();
                }
                (size.saturating_sub(suffix), size - 1)
            } else {
                let Ok(start) = first.parse::<u64>() else {
                    return StatusCode::RANGE_NOT_SATISFIABLE.into_response();
                };
                let end = if last.is_empty() {
                    size.saturating_sub(1)
                } else {
                    match last.parse::<u64>() {
                        Ok(value) => value.min(size.saturating_sub(1)),
                        Err(_) => return StatusCode::RANGE_NOT_SATISFIABLE.into_response(),
                    }
                };
                (start, end)
            };
            if start >= size || end < start {
                return StatusCode::RANGE_NOT_SATISFIABLE.into_response();
            }
            (start, end, true)
        }
        _ => (0, size.saturating_sub(1), false),
    };
    let length = if size == 0 { 0 } else { end - start + 1 };
    if file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let mut response = Response::new(Body::from_stream(ReaderStream::new(file.take(length))));
    *response.status_mut() = if partial {
        StatusCode::PARTIAL_CONTENT
    } else {
        StatusCode::OK
    };
    response
        .headers_mut()
        .insert(CONTENT_TYPE, HeaderValue::from_static("application/pdf"));
    response
        .headers_mut()
        .insert("accept-ranges", HeaderValue::from_static("bytes"));
    response.headers_mut().insert(
        "content-length",
        HeaderValue::from_str(&length.to_string()).unwrap(),
    );
    if partial {
        response.headers_mut().insert(
            "content-range",
            HeaderValue::from_str(&format!("bytes {start}-{end}/{size}")).unwrap(),
        );
    }
    no_store(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn reader_assets_and_open_papers_require_the_token() {
        let open_state = Arc::new(Mutex::new(OpenPaperState {
            ids: vec!["paper-1".into()],
            active_id: Some("paper-1".into()),
        }));
        let context = RemoteContext {
            token: "test-token".into(),
            open_papers: open_state,
        };
        assert_eq!(
            reader_script(State(context.clone()), HeaderMap::new())
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        let mut headers = HeaderMap::new();
        headers.insert(COOKIE, HeaderValue::from_static("reos_remote=test-token"));
        let script = reader_script(State(context.clone()), headers.clone()).await;
        assert_eq!(script.status(), StatusCode::OK);
        assert_eq!(
            script.headers()[CONTENT_TYPE],
            "text/javascript; charset=utf-8"
        );
        let open = open_papers(State(context), headers).await;
        assert_eq!(open.status(), StatusCode::OK);
        let bytes = axum::body::to_bytes(open.into_body(), 1024).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(&bytes).unwrap(),
            serde_json::json!({ "ids": ["paper-1"], "activeId": "paper-1" })
        );
    }

    #[tokio::test]
    async fn browser_requires_the_address_token() {
        let router = Router::new()
            .route("/", get(index))
            .with_state(RemoteContext {
                token: "test-token".into(),
                open_papers: Arc::new(Mutex::new(OpenPaperState::default())),
            });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let base = format!("http://{address}/");
        assert_eq!(
            client.get(&base).send().await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
        let response = client
            .get(format!("{base}?token=test-token"))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::SEE_OTHER);
        let cookie = response
            .headers()
            .get(SET_COOKIE)
            .unwrap()
            .to_str()
            .unwrap();
        assert!(cookie.contains("HttpOnly"));
        let response = client
            .get(&base)
            .header(COOKIE, "reos_remote=test-token")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert!(response.text().await.unwrap().contains("Field Reader"));
        task.abort();
    }

    #[test]
    fn paper_lookup_rejects_path_traversal() {
        let root = std::env::temp_dir().join(format!("reos-remote-test-{}", Uuid::new_v4()));
        let paper = root.join("threads/inbox/papers/example");
        fs::create_dir_all(&paper).unwrap();
        fs::write(paper.join("meta.json"), r#"{"id":"paper-1"}"#).unwrap();
        assert_eq!(paper_location(&root, "paper-1").unwrap(), paper);
        assert_eq!(
            paper_location(&root, "../paper-1").unwrap_err(),
            StatusCode::BAD_REQUEST
        );
        fs::remove_dir_all(root).unwrap();
    }
}
