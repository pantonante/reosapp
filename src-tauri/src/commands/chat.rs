use std::collections::HashMap;
use std::process::Stdio;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[derive(Default)]
pub struct ChatRegistry(pub Arc<Mutex<HashMap<String, u32>>>);

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatStreamArgs {
    pub session_id: String,
    pub prompt: String,
    pub pdf_paths: Vec<String>,
    pub system: Option<String>,
    /// Absolute path to the thread folder. Becomes the CWD for `claude` so the
    /// agent can read/write notes, prior chats, summaries, and other papers in
    /// the same thread via its built-in file tools.
    pub workspace_dir: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "type")]
pub enum ChatEvent {
    #[serde(rename = "stdout")]
    Stdout { session_id: String, line: String },
    #[serde(rename = "stderr")]
    Stderr { session_id: String, line: String },
    #[serde(rename = "done")]
    Done { session_id: String, code: i32 },
    #[serde(rename = "error")]
    Error { session_id: String, message: String },
}

#[tauri::command]
pub async fn chat_stream(
    app: AppHandle,
    registry: State<'_, ChatRegistry>,
    args: ChatStreamArgs,
) -> Result<(), String> {
    let session_id = args.session_id.clone();

    // Fail fast with a clear message if the workspace dir doesn't exist —
    // otherwise `cmd.spawn()` produces an opaque OS error that's easy to miss.
    if !std::path::Path::new(&args.workspace_dir).exists() {
        let msg = format!(
            "workspace_dir does not exist: {} (paper folder may have been deleted or PDF not yet downloaded)",
            args.workspace_dir
        );
        eprintln!("[chat_stream:{session_id}] {msg}");
        let _ = app.emit(
            "chat:event",
            ChatEvent::Error {
                session_id: session_id.clone(),
                message: msg.clone(),
            },
        );
        return Err(msg);
    }

    // Resolve the bundled Re:OS skills directory. We pass it via `--add-dir`
    // so Claude's skill loader picks up `<dir>/.claude/skills/*` regardless of
    // CWD. See https://code.claude.com/docs/en/skills.md#skills-from-additional-directories
    let skills_dir = app
        .path()
        .resolve("reos-skills", BaseDirectory::Resource)
        .ok()
        .map(|p| p.to_string_lossy().into_owned());

    let mut cmd = Command::new("claude");
    cmd.arg("-p")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--input-format")
        .arg("text")
        .arg("--verbose");
    if let Some(system) = &args.system {
        cmd.arg("--system-prompt").arg(system);
    }
    if let Some(dir) = &skills_dir {
        cmd.arg("--add-dir").arg(dir);
    }

    // Compose the user prompt with PDF mentions appended on their own lines so
    // the CLI's @path resolver picks them up.
    let mut prompt = args.prompt.clone();
    for path in &args.pdf_paths {
        prompt.push_str("\n@");
        prompt.push_str(path);
    }
    // `--` terminates option parsing so the prompt isn't swallowed by a
    // preceding variadic flag like `--add-dir <directories...>`.
    cmd.arg("--").arg(prompt);

    // CWD = thread folder, so Claude's Read/Edit/Write/Bash tools operate on
    // notes.md, summary.md, prior chat.jsonl files etc. in the right place.
    cmd.current_dir(&args.workspace_dir);

    // Subscription billing safety: the Agent SDK and Claude CLI both prefer
    // `ANTHROPIC_API_KEY` over the user's stored Max OAuth token if the env
    // var is set. We never want to silently bill against the API. Strip it
    // (and a few siblings) from the child env regardless of how Re:OS was
    // launched.
    cmd.env_remove("ANTHROPIC_API_KEY");
    cmd.env_remove("ANTHROPIC_AUTH_TOKEN");
    cmd.env_remove("CLAUDE_CODE_OAUTH_TOKEN");

    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    // Diagnostic: print everything we're about to spawn. Goes to the terminal
    // running `npm run tauri dev`, so the user can see it without devtools.
    eprintln!(
        "[chat_stream:{session_id}] spawn: claude {:?}\n  cwd: {}\n  HOME={:?} PATH={:?}",
        cmd.as_std()
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect::<Vec<_>>(),
        args.workspace_dir,
        std::env::var("HOME").ok(),
        std::env::var("PATH").ok(),
    );

    let mut child = cmd.spawn().map_err(|e| {
        let msg = format!("failed to spawn `claude` CLI: {e}. Ensure it is installed and on PATH.");
        eprintln!("[chat_stream:{session_id}] spawn FAILED: {msg}");
        let _ = app.emit(
            "chat:event",
            ChatEvent::Error {
                session_id: session_id.clone(),
                message: msg.clone(),
            },
        );
        msg
    })?;

    // Track child PID so chat_cancel can kill it.
    if let Some(pid) = child.id() {
        eprintln!("[chat_stream:{session_id}] spawned PID {pid}");
        if let Ok(mut guard) = registry.0.lock() {
            guard.insert(session_id.clone(), pid);
        }
    }

    let stdout = child.stdout.take().expect("stdout piped");
    let stderr = child.stderr.take().expect("stderr piped");

    let app_for_stdout = app.clone();
    let sid_stdout = session_id.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stdout).lines();
        let mut count = 0u64;
        loop {
            match reader.next_line().await {
                Ok(Some(line)) => {
                    count += 1;
                    eprintln!("[chat_stream:{sid_stdout}] stdout #{count}: {line}");
                    let emit_res = app_for_stdout.emit(
                        "chat:event",
                        ChatEvent::Stdout {
                            session_id: sid_stdout.clone(),
                            line,
                        },
                    );
                    if let Err(e) = emit_res {
                        eprintln!("[chat_stream:{sid_stdout}] emit FAILED: {e}");
                    }
                }
                Ok(None) => {
                    eprintln!("[chat_stream:{sid_stdout}] stdout: EOF after {count} lines");
                    break;
                }
                Err(e) => {
                    eprintln!("[chat_stream:{sid_stdout}] stdout error: {e}");
                    let _ = app_for_stdout.emit(
                        "chat:event",
                        ChatEvent::Error {
                            session_id: sid_stdout.clone(),
                            message: e.to_string(),
                        },
                    );
                    break;
                }
            }
        }
    });

    let app_for_stderr = app.clone();
    let sid_stderr = session_id.clone();
    tauri::async_runtime::spawn(async move {
        let mut reader = BufReader::new(stderr).lines();
        let mut count = 0u64;
        while let Ok(Some(line)) = reader.next_line().await {
            count += 1;
            eprintln!("[chat_stream:{sid_stderr}] stderr #{count}: {line}");
            let emit_res = app_for_stderr.emit(
                "chat:event",
                ChatEvent::Stderr {
                    session_id: sid_stderr.clone(),
                    line,
                },
            );
            if let Err(e) = emit_res {
                eprintln!("[chat_stream:{sid_stderr}] emit FAILED: {e}");
            }
        }
        eprintln!("[chat_stream:{sid_stderr}] stderr: EOF after {count} lines");
    });

    let app_for_wait = app.clone();
    let sid_wait = session_id.clone();
    let registry_for_wait = registry.0.clone();
    tauri::async_runtime::spawn(async move {
        let started = std::time::Instant::now();
        let code = match child.wait().await {
            Ok(status) => status.code().unwrap_or(-1),
            Err(e) => {
                eprintln!("[chat_stream:{sid_wait}] wait error: {e}");
                let _ = app_for_wait.emit(
                    "chat:event",
                    ChatEvent::Error {
                        session_id: sid_wait.clone(),
                        message: e.to_string(),
                    },
                );
                -1
            }
        };
        eprintln!(
            "[chat_stream:{sid_wait}] exited code={code} after {:.1}s",
            started.elapsed().as_secs_f32()
        );
        if let Ok(mut guard) = registry_for_wait.lock() {
            guard.remove(&sid_wait);
        }
        let emit_res = app_for_wait.emit(
            "chat:event",
            ChatEvent::Done {
                session_id: sid_wait.clone(),
                code,
            },
        );
        if let Err(e) = emit_res {
            eprintln!("[chat_stream:{sid_wait}] done emit FAILED: {e}");
        } else {
            eprintln!("[chat_stream:{sid_wait}] done event emitted");
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn chat_cancel(
    session_id: String,
    registry: State<'_, ChatRegistry>,
) -> Result<(), String> {
    let pid = {
        let guard = registry.0.lock().map_err(|e| e.to_string())?;
        guard.get(&session_id).copied()
    };
    let Some(pid) = pid else {
        return Ok(());
    };
    // SIGTERM via libc kill — tokio::process::Child handles got moved into
    // the wait task, so we kill by PID. The reaper task picks up the exit
    // and emits `done`.
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(pid as i32, libc::SIGTERM);
        }
    }
    #[cfg(windows)]
    {
        // Windows fallback: use taskkill.
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .status();
    }
    Ok(())
}
