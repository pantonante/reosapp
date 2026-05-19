use tokio::process::Command;

/// Apply env tweaks common to every `claude` CLI spawn:
///
/// 1. Prepend the standard system bin paths (incl. Homebrew) to PATH. When
///    Re:OS launches from Finder/Dock, the .app inherits macOS's minimal GUI
///    PATH and the `claude` subshells then can't find `pdftoppm`, `gs`, or
///    even bare `ls`. Prepending the canonical locations guarantees these
///    resolve while still preserving anything the user already had on PATH.
///
/// 2. Strip Anthropic API/auth env vars so the CLI uses the user's stored
///    Max OAuth session and we never silently bill against the API.
pub fn prepare(cmd: &mut Command) {
    let inherited_path = std::env::var("PATH").unwrap_or_default();
    let mut parts: Vec<&str> = vec![
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ];
    if !inherited_path.is_empty() {
        parts.push(inherited_path.as_str());
    }
    cmd.env("PATH", parts.join(":"));

    cmd.env_remove("ANTHROPIC_API_KEY");
    cmd.env_remove("ANTHROPIC_AUTH_TOKEN");
    cmd.env_remove("CLAUDE_CODE_OAUTH_TOKEN");
}
