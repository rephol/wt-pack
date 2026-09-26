// wt-dashboard desktop shell: reuse a running dashboard server on :7777 or start one (the live
// skill-pack source if present, else the bundled Node sidecar), then point one window at it.
// Native extras: tray (Needs-you count + menu), notifications relayed from the webview's
// /api/events stream, ⌥⌘H global toggle, launch at login.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{Read, Write};
use std::net::TcpStream;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Listener, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent, Wry};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use std::sync::atomic::{AtomicBool, Ordering};

/// Set once the app starts exiting: native handlers must not touch tray/menus/windows being torn down.
static EXITING: AtomicBool = AtomicBool::new(false);
/// The main window was opened on the error page (a data: URL). Tracked here because WebviewWindow::url() panics
/// inside wry (url_from_webview unwraps WKWebView.URL) while the webview has not committed a URL yet (WP-45).
static ON_ERROR_PAGE: AtomicBool = AtomicBool::new(false);
use tauri_plugin_notification::NotificationExt;

const ADDR: &str = "127.0.0.1:7777";
// wt-dashboard.localhost, not 127.0.0.1: Activity Monitor names the WebKit web process after the page's site.
const URL: &str = "http://wt-dashboard.localhost:7777/";
const HOTKEY: &str = "alt+cmd+h"; // ⌥⌘H toggles the window
/// `npm run service:install` makes the server a LaunchAgent; then the app never spawns or stops it.
const SERVICE: &str = "id.local.wtdashboard.server";

fn service_plist() -> std::path::PathBuf {
    std::path::PathBuf::from(format!("{}/Library/LaunchAgents/{SERVICE}.plist", std::env::var("HOME").unwrap_or_default()))
}
fn service_installed() -> bool {
    service_plist().is_file()
}
fn uid() -> String {
    Command::new("/usr/bin/id").arg("-u").output().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default()
}
/// launchctl kickstart [-k] gui/$UID/<label>; bootstraps the plist first if it is installed but not loaded.
fn kickstart(kill: bool) -> Result<(), String> {
    let target = format!("gui/{}/{SERVICE}", uid());
    let loaded = Command::new("/bin/launchctl").args(["print", &target]).stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false);
    if !loaded {
        let st = Command::new("/bin/launchctl").args(["bootstrap", &format!("gui/{}", uid()), &service_plist().to_string_lossy()]).status().map_err(|e| e.to_string())?;
        log(&format!("service: bootstrap -> {st}"));
    }
    let mut args = vec!["kickstart"];
    if kill { args.push("-k") }
    args.push(&target);
    let o = Command::new("/bin/launchctl").args(&args).output().map_err(|e| e.to_string())?;
    log(&format!("service: launchctl {} -> {}", args.join(" "), o.status));
    if o.status.success() { Ok(()) } else { Err(format!("launchctl kickstart failed: {}", String::from_utf8_lossy(&o.stderr).trim())) }
}
/// `npm run service:install` equivalent, run with the login PATH's node from the live source.
fn install_service() -> Result<(), String> {
    let root = live_root();
    let path = login_path();
    let node = path.split(':').map(|d| std::path::Path::new(d).join("node")).find(|p| p.is_file()).ok_or("node not found on the login PATH")?;
    let o = Command::new(node).arg("scripts/service.mjs").arg("install").current_dir(&root).env("PATH", &path).output().map_err(|e| e.to_string())?;
    log(&format!("service: install -> {} {}", o.status, String::from_utf8_lossy(&o.stderr).trim()));
    if o.status.success() { Ok(()) } else { Err(format!("service install failed: {}", String::from_utf8_lossy(&o.stderr).trim())) }
}

struct Sidecar(Mutex<Option<Child>>);

/// In-app browser: ONE reused window ("browser") for links clicked in the dashboard. Isolated from the
/// dashboard: no capability names it (so no IPC or plugin access), and it has its own website data store
/// (separate cookies/sign-in from the dashboard AND from the system browser). Its toolbar is injected into
/// each page; "Open in browser" navigates to wtd-open://…, which on_navigation hands to the system browser.
const BROWSER_STORE: [u8; 16] = *b"wtdash-browser01";
const TOOLBAR_JS: &str = r#"(() => {
  if (window.top !== window || document.getElementById('__wtd_bar')) return;
  const mount = () => {
    if (document.getElementById('__wtd_bar') || !document.body) return;
    const host = document.createElement('div'); host.id = '__wtd_bar';
    host.style.cssText = 'position:fixed;top:0;left:0;right:0;height:36px;z-index:2147483647';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `<style>
      .b{display:flex;gap:4px;align-items:center;height:36px;padding:0 8px;background:#1b1b1b;color:#ddd;font:13px system-ui;border-bottom:1px solid #333;box-sizing:border-box}
      button{background:none;border:0;color:#ddd;font:15px system-ui;width:28px;height:28px;border-radius:6px;cursor:pointer}
      button:hover{background:#333} .u{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.75;padding:0 6px}
      .o{width:auto;padding:0 10px;font-size:12px;border:1px solid #444}</style>
      <div class="b"><button title="Back">‹</button><button title="Forward">›</button><button title="Reload">↻</button>
      <span class="u"></span><button class="o">Open in browser</button></div>`;
    const [back, fwd, reload, , open] = root.querySelectorAll('.b > *');
    root.querySelector('.u').textContent = location.href;
    back.onclick = () => history.back(); fwd.onclick = () => history.forward(); reload.onclick = () => location.reload();
    open.onclick = () => { location.href = 'wtd-open://open?u=' + encodeURIComponent(location.href) };
    document.documentElement.appendChild(host);
    document.documentElement.style.setProperty('margin-top', '36px', 'important');
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();"#;
fn open_browser(app: &AppHandle, raw: &str) {
    let Ok(url) = tauri::Url::parse(raw) else { return };
    if url.scheme() != "http" && url.scheme() != "https" { return }
    if let Some(w) = app.get_webview_window("browser") {
        let _ = w.navigate(url);
        let _ = w.show();
        let _ = w.set_focus();
        return;
    }
    let opener = app.clone();
    let r = WebviewWindowBuilder::new(app, "browser", WebviewUrl::External(url))
        .title("wt-dashboard — browser")
        .inner_size(1100.0, 800.0)
        .data_store_identifier(BROWSER_STORE)
        .initialization_script(TOOLBAR_JS)
        .on_navigation(move |u| {
            if u.scheme() == "wtd-open" {
                if let Some(target) = u.query_pairs().find(|(k, _)| k == "u").map(|(_, v)| v.to_string()) {
                    if target.starts_with("http://") || target.starts_with("https://") {
                        use tauri_plugin_opener::OpenerExt;
                        let _ = opener.opener().open_url(target, None::<&str>);
                    }
                }
                return false;
            }
            matches!(u.scheme(), "http" | "https" | "about" | "blob" | "data")
        })
        .build();
    if let Err(e) = r { log(&format!("browser window: {e}")) }
}

/// ~/Library/Logs/wt-dashboard/app.log — the only place a GUI app's diagnostics survive.
fn log(msg: &str) {
    let dir = format!("{}/Library/Logs/wt-dashboard", std::env::var("HOME").unwrap_or_default());
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(format!("{dir}/app.log")) {
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let _ = writeln!(f, "{t} {msg}");
    }
}

/// Our server answers /api/health with {"ok":true,"app":"wt-dashboard",...}.
fn healthy() -> bool {
    let Ok(mut s) = TcpStream::connect_timeout(&ADDR.parse().unwrap(), Duration::from_millis(500)) else {
        return false;
    };
    let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
    if s.write_all(b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:7777\r\nConnection: close\r\n\r\n").is_err() {
        return false;
    }
    let mut body = String::new();
    let _ = s.read_to_string(&mut body);
    body.starts_with("HTTP/1.1 200") && body.contains("\"app\":\"wt-dashboard\"")
}
/// The answering server says it runs under launchd (its /api/health managedBy).
fn healthy_launchd() -> bool {
    let Ok(mut s) = TcpStream::connect_timeout(&ADDR.parse().unwrap(), Duration::from_millis(500)) else { return false };
    let _ = s.set_read_timeout(Some(Duration::from_secs(2)));
    if s.write_all(b"GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:7777\r\nConnection: close\r\n\r\n").is_err() { return false }
    let mut body = String::new();
    let _ = s.read_to_string(&mut body);
    body.contains("\"managedBy\":\"launchd\"")
}

/// GUI apps get a minimal PATH; herdr/git/gh/node live in user dirs. Ask a login shell, then add the usual suspects.
fn login_path() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut parts: Vec<String> = vec![];
    if let Ok(o) = Command::new("/bin/zsh").args(["-lc", "echo $PATH"]).stdin(Stdio::null()).output() {
        let p = String::from_utf8_lossy(&o.stdout).trim().to_string();
        if !p.is_empty() {
            parts.push(p);
        }
    }
    if let Ok(rd) = std::fs::read_dir(format!("{home}/.nvm/versions/node")) {
        for e in rd.flatten() {
            parts.push(format!("{}/bin", e.path().display()));
        }
    }
    parts.extend(["/opt/homebrew/bin".into(), "/usr/local/bin".into()]);
    parts.extend([format!("{home}/.cargo/bin"), format!("{home}/.local/bin")]);
    parts.push(std::env::var("PATH").unwrap_or_default());
    parts.join(":")
}

/// ~/.config/wt-dashboard/env: KEY=VALUE lines (e.g. LINEAR_API_KEY), passed to the server.
/// Falls back to the pre-rename ~/.config/herdr-dash/env (logged) when the new file is missing.
fn env_file() -> Vec<(String, String)> {
    let home = std::env::var("HOME").unwrap_or_default();
    let text = std::fs::read_to_string(format!("{home}/.config/wt-dashboard/env")).or_else(|_| {
        let old = format!("{home}/.config/herdr-dash/env");
        let r = std::fs::read_to_string(&old);
        if r.is_ok() {
            log(&format!("env: using legacy {old}; move it to ~/.config/wt-dashboard/env"));
        }
        r
    });
    text.unwrap_or_default()
        .lines()
        .filter(|l| !l.trim_start().starts_with('#'))
        .filter_map(|l| l.split_once('='))
        .map(|(k, v)| (k.trim().to_string(), v.trim().trim_matches('"').to_string()))
        .filter(|(k, _)| !k.is_empty())
        .collect()
}

/// Where the live source lives: $WT_DASHBOARD_HOME, else the skill-pack install
/// (~/.claude/skills/wt-dashboard, a symlink into wt-pack, resolved).
fn live_root() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    let p = std::env::var("WT_DASHBOARD_HOME").unwrap_or(format!("{home}/.claude/skills/wt-dashboard"));
    std::fs::canonicalize(&p).unwrap_or_else(|_| p.into())
}

/// Prefer the live source (a reload picks up rebuilt changes); else the bundled sidecar.
fn start_server(app: &AppHandle) -> Result<Child, String> {
    let root = live_root();
    let path = login_path();
    let node = path.split(':').map(|d| std::path::Path::new(d).join("node")).find(|p| p.is_file());
    if let (true, true, Some(node)) = (root.join("server.mjs").is_file(), root.join("web/dist/index.html").is_file(), node) {
        log(&format!("server: live {} via {}", root.join("server.mjs").display(), node.display()));
        let mut cmd = Command::new(node);
        cmd.arg("server.mjs").current_dir(&root);
        cmd.env("PATH", &path);
        cmd.env("WT_DASHBOARD_APP", "1");
        return cmd.envs(env_file()).stdin(Stdio::null()).spawn().map_err(|e| format!("could not start the dashboard server: {e}"));
    }
    log("server: bundled sidecar");
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let bin = exe.parent().ok_or("no exe dir")?.join("wt-dashboard-server");
    let dist = app.path().resource_dir().map_err(|e| e.to_string())?.join("web");
    let mut cmd = Command::new(bin);
    cmd.env("PATH", &path);
    cmd.env("WT_DASHBOARD_SERVE", "1");
    cmd.env("WT_DASHBOARD_APP", "1");
    cmd.env("WT_DASHBOARD_DIST", dist);
    cmd.envs(env_file()).stdin(Stdio::null()).spawn().map_err(|e| format!("could not start the dashboard server: {e}"))
}

fn error_page(msg: &str) -> WebviewUrl {
    let html = format!(
        "<body style='font:15px system-ui;padding:40px;color-scheme:light dark'><h2>wt-dashboard could not start</h2><p>{}</p>\
         <p>Is something else using port 7777? Try <code>npm start</code> in ~/.claude/skills/wt-dashboard, then reopen the app.</p></body>",
        msg.replace('<', "&lt;")
    );
    let enc: String = html
        .bytes()
        .map(|b| if b.is_ascii_alphanumeric() { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect();
    WebviewUrl::External(format!("data:text/html,{enc}").parse().unwrap())
}

#[derive(serde::Deserialize, Default, Clone)]
struct TrayAgent {
    key: String,
    name: String,
    #[serde(default)]
    question: Option<String>,
}
#[derive(serde::Deserialize, Default, Clone)]
struct TrayState {
    needs: Vec<TrayAgent>,
    working: Vec<TrayAgent>,
}
#[derive(serde::Deserialize)]
struct Notify {
    title: String,
    body: String,
}

fn short(s: &str, n: usize) -> String {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.chars().count() > n { format!("{}…", s.chars().take(n).collect::<String>()) } else { s }
}

// ---- server lifecycle: who owns :7777, supervision, restart/take over ----
#[derive(Clone, Copy, PartialEq, Debug)]
enum Srv {
    Starting,
    AppManaged,
    Launchd,
    External,
    Down,
}
static SRV: Mutex<Srv> = Mutex::new(Srv::Starting);
static LAST_TRAY: Mutex<Option<TrayState>> = Mutex::new(None);
static RESTARTS: Mutex<Vec<Instant>> = Mutex::new(Vec::new());
static BUSY: AtomicBool = AtomicBool::new(false);
/// A new web build is waiting (WP-55): a dot on the tray title and the Dock icon until reloaded/dismissed.
static UPDATE: AtomicBool = AtomicBool::new(false);
static NEEDS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
fn tray_title(n: usize) -> Option<String> {
    let dot = if UPDATE.load(Ordering::Relaxed) { "•" } else { "" };
    if n > 0 || !dot.is_empty() { Some(format!("{}{dot}", if n > 0 { n.to_string() } else { String::new() })) } else { None }
}
const MAX_AUTO_RESTARTS: usize = 3; // per 5 minutes

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}
fn srv() -> Srv {
    *lock(&SRV)
}
fn child_exists(app: &AppHandle) -> bool {
    lock(&app.state::<Sidecar>().0).is_some()
}
fn child_alive(app: &AppHandle) -> bool {
    match lock(&app.state::<Sidecar>().0).as_mut() {
        Some(c) => matches!(c.try_wait(), Ok(None)),
        None => false,
    }
}
fn stop_child(app: &AppHandle) {
    if let Some(mut c) = lock(&app.state::<Sidecar>().0).take() {
        log(&format!("server: stopping app-managed pid {}", c.id()));
        let _ = c.kill();
        let _ = c.wait();
    }
}
fn listening_pids() -> Vec<String> {
    Command::new("/usr/sbin/lsof")
        .args(["-nP", "-iTCP:7777", "-sTCP:LISTEN", "-t"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).split_whitespace().filter(|p| p.chars().all(|c| c.is_ascii_digit())).map(String::from).collect())
        .unwrap_or_default()
}
fn wait_until(secs: u64, f: impl Fn() -> bool) -> bool {
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(secs) {
        if f() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    f()
}
fn spawn_and_wait(app: &AppHandle) -> Result<(), String> {
    if service_installed() {
        // launchd owns the server; the app only asks it to start.
        kickstart(false)?;
        return if wait_until(15, healthy) { Ok(()) } else { Err("the launchd service did not become healthy within 15s (see ~/Library/Logs/wt-dashboard/server.log)".into()) };
    }
    let c = start_server(app)?;
    log(&format!("server: spawned pid {}", c.id()));
    *lock(&app.state::<Sidecar>().0) = Some(c);
    if wait_until(10, healthy) { Ok(()) } else { Err("the server did not become healthy within 10s".into()) }
}
/// Recompute who serves :7777; on change, log, refresh the tray, and leave the error page if we can.
fn update_state(app: &AppHandle) {
    let s = if healthy() { if child_alive(app) { Srv::AppManaged } else if healthy_launchd() { Srv::Launchd } else { Srv::External } } else { Srv::Down };
    let prev = std::mem::replace(&mut *lock(&SRV), s);
    if prev != s {
        log(&format!("server state: {prev:?} -> {s:?}"));
        refresh_tray(app);
    }
    if s != Srv::Down {
        if let Some(w) = app.get_webview_window("main") {
            if ON_ERROR_PAGE.swap(false, Ordering::Relaxed) {
                let _ = w.navigate(URL.parse().unwrap());
            }
        }
    }
}
fn refresh_tray(app: &AppHandle) {
    let st = lock(&LAST_TRAY).clone().unwrap_or_default();
    if let (Some(t), Ok(m)) = (app.tray_by_id("main"), build_menu(app, &st)) {
        let _ = t.set_menu(Some(m));
    }
}
/// restart | takeover | start — from the tray or the webview. One at a time, off the main thread.
fn control(app: &AppHandle, action: &str) {
    if BUSY.swap(true, Ordering::SeqCst) {
        log(&format!("control: {action} ignored, another action is running"));
        return;
    }
    let app = app.clone();
    let action = action.to_string();
    std::thread::spawn(move || {
        log(&format!("control: {action}"));
        let r: Result<(), String> = match action.as_str() {
            "restart" if srv() == Srv::Launchd || (service_installed() && !child_exists(&app)) => {
                kickstart(true).and_then(|_| {
                    std::thread::sleep(Duration::from_millis(500));
                    if wait_until(15, healthy) { Ok(()) } else { Err("the service did not come back within 15s".into()) }
                })
            }
            "install" => {
                // An external (npm start) server holds :7777: stop it (only after /api/health said it is ours), then
                // hand the port to the LaunchAgent.
                if healthy() && !healthy_launchd() {
                    for pid in listening_pids() {
                        log(&format!("install: kill {pid}"));
                        let _ = Command::new("/bin/kill").arg(&pid).status();
                    }
                    wait_until(5, || listening_pids().is_empty());
                }
                stop_child(&app);
                install_service().and_then(|_| if wait_until(15, healthy) { Ok(()) } else { Err("the service did not become healthy within 15s".into()) })
            }
            "restart" if child_exists(&app) => {
                stop_child(&app);
                wait_until(5, || !healthy());
                spawn_and_wait(&app)
            }
            "restart" => Err("the server is not app-managed; use Take over".into()),
            "takeover" if child_alive(&app) => Err("the server is already app-managed".into()),
            "takeover" if !healthy() => Err("no wt-dashboard server is answering on :7777; use Start".into()),
            "takeover" => {
                // Only the pid LISTENING on :7777, and only after /api/health said it is ours.
                for pid in listening_pids() {
                    log(&format!("takeover: kill {pid}"));
                    let _ = Command::new("/bin/kill").arg(&pid).status();
                }
                if !wait_until(5, || listening_pids().is_empty()) {
                    Err("the external server did not exit".into())
                } else {
                    spawn_and_wait(&app)
                }
            }
            "start" if healthy() => Err("a server is already running".into()),
            "start" => {
                stop_child(&app);
                lock(&RESTARTS).clear();
                spawn_and_wait(&app)
            }
            _ => Err(format!("unknown action {action}")),
        };
        log(&format!("control: {action} -> {r:?}"));
        update_state(&app);
        let _ = app.emit_to("main", "server-control-result", serde_json::json!({ "action": action, "ok": r.is_ok(), "error": r.err() }));
        BUSY.store(false, Ordering::SeqCst);
    });
}
/// Every 5s: an app-managed server that died is restarted (max 3 per 5 min, then down + notification).
/// An external one is never restarted — the tray offers Take over.
fn supervise(app: AppHandle) {
    let mut bad = 0;
    let mut notified = false;
    loop {
        std::thread::sleep(Duration::from_secs(5));
        if EXITING.load(Ordering::Relaxed) {
            return;
        }
        if BUSY.load(Ordering::SeqCst) {
            continue;
        }
        let h = healthy();
        bad = if h { 0 } else { bad + 1 };
        if h {
            notified = false;
        }
        if child_exists(&app) && (!child_alive(&app) || bad >= 2) {
            let mut rs = lock(&RESTARTS);
            rs.retain(|t| t.elapsed() < Duration::from_secs(300));
            let allowed = rs.len() < MAX_AUTO_RESTARTS;
            if allowed {
                rs.push(Instant::now());
            }
            let n = rs.len();
            drop(rs);
            stop_child(&app);
            if allowed {
                log(&format!("supervisor: app-managed server died, auto-restart {n}/{MAX_AUTO_RESTARTS}"));
                let r = spawn_and_wait(&app);
                log(&format!("supervisor: auto-restart -> {r:?}"));
                bad = 0;
            } else if !notified {
                notified = true;
                log("supervisor: restart budget spent; server down");
                let _ = app.notification().builder().title("wt-dashboard server is down")
                    .body("It crashed 3 times in 5 minutes. Use Start server in the menu-bar icon.").show();
            }
        }
        update_state(&app);
    }
}

fn build_menu(app: &AppHandle, st: &TrayState) -> tauri::Result<Menu<Wry>> {
    let mut items: Vec<Box<dyn IsMenuItem<Wry>>> = vec![];
    if st.needs.is_empty() {
        items.push(Box::new(MenuItem::new(app, "Nobody needs you", false, None::<&str>)?));
    } else {
        items.push(Box::new(MenuItem::new(app, format!("Needs you ({})", st.needs.len()), false, None::<&str>)?));
        for a in &st.needs {
            let label = match &a.question { Some(q) => format!("{} — {}", a.name, short(q, 60)), None => a.name.clone() };
            items.push(Box::new(MenuItem::with_id(app, format!("agent:{}", a.key), label, true, None::<&str>)?));
        }
    }
    let working: Vec<MenuItem<Wry>> = st
        .working
        .iter()
        .map(|a| MenuItem::with_id(app, format!("agent:{}", a.key), &a.name, true, None::<&str>))
        .collect::<tauri::Result<_>>()?;
    let wrefs: Vec<&dyn IsMenuItem<Wry>> = working.iter().map(|m| m as &dyn IsMenuItem<Wry>).collect();
    items.push(Box::new(Submenu::with_items(app, format!("Working ({})", working.len()), !working.is_empty(), &wrefs)?));
    items.push(Box::new(PredefinedMenuItem::separator(app)?));
    let s = srv();
    let line = match s {
        Srv::Starting => "Server: starting…",
        Srv::AppManaged => "Server: healthy (app-managed)",
        Srv::Launchd => "Server: healthy (launchd)",
        Srv::External => "Server: healthy (external)",
        Srv::Down => "Server: down",
    };
    items.push(Box::new(MenuItem::new(app, line, false, None::<&str>)?));
    match s {
        Srv::AppManaged | Srv::Launchd => items.push(Box::new(MenuItem::with_id(app, "srv:restart", "Restart server", true, None::<&str>)?)),
        Srv::External => items.push(Box::new(MenuItem::with_id(app, "srv:install", "Install as service", true, None::<&str>)?)),
        Srv::Down => items.push(Box::new(MenuItem::with_id(app, "srv:start", "Start server", true, None::<&str>)?)),
        Srv::Starting => {}
    }
    items.push(Box::new(PredefinedMenuItem::separator(app)?));
    items.push(Box::new(MenuItem::with_id(app, "open", "Open wt-dashboard", true, None::<&str>)?));
    let on = app.autolaunch().is_enabled().unwrap_or(false);
    items.push(Box::new(CheckMenuItem::with_id(app, "autostart", "Launch at login", true, on, None::<&str>)?));
    items.push(Box::new(MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?));
    let refs: Vec<&dyn IsMenuItem<Wry>> = items.iter().map(|b| b.as_ref()).collect();
    Menu::with_items(app, &refs)
}

fn show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "open" => show(app),
        "quit" => app.exit(0),
        "autostart" => {
            let al = app.autolaunch();
            let r = if al.is_enabled().unwrap_or(false) { al.disable() } else { al.enable() };
            log(&format!("autostart toggled: {r:?} now={:?}", al.is_enabled()));
        }
        id if id.starts_with("srv:") => control(app, &id[4..]),
        id if id.starts_with("agent:") => {
            show(app);
            let _ = app.emit_to("main", "open-agent", &id[6..]);
        }
        _ => {}
    }
}

fn main() {
    // A panic inside an AppKit callback aborts the process with no message; record it first.
    std::panic::set_hook(Box::new(|info| {
        log(&format!("PANIC: {info}\n{}", std::backtrace::Backtrace::force_capture()));
    }));
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _s, ev| {
                    if ev.state() != ShortcutState::Pressed || EXITING.load(Ordering::Relaxed) {
                        return;
                    }
                    if let Some(w) = app.get_webview_window("main") {
                        if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
                            let _ = w.hide();
                        } else {
                            show(app)
                        }
                    }
                })
                .build(),
        )
        .on_window_event(|w, ev| {
            if EXITING.load(Ordering::Relaxed) {
                return;
            }
            // Closing hides; the app lives on in the tray. Quit is in the tray menu.
            if let WindowEvent::CloseRequested { api, .. } = ev {
                api.prevent_close();
                let _ = w.hide();
            }
        })
        .manage(Sidecar(Mutex::new(None)))
        .setup(|app| {
            let h = app.handle().clone();
            // Ask on first launch so the first real notification isn't the one that raises the prompt.
            log(&format!("notification permission: {:?}", h.notification().request_permission()));
            if let Err(e) = h.global_shortcut().register(HOTKEY) {
                log(&format!("hotkey {HOTKEY} not registered: {e}"));
            }
            let mut tb = TrayIconBuilder::with_id("main");
            if let Some(icon) = app.default_window_icon() {
                tb = tb.icon(icon.clone());
            }
            tb = tb.tooltip("wt-dashboard");
            let tray = tb
                .menu(&build_menu(&h, &TrayState::default())?)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, e| if !EXITING.load(Ordering::Relaxed) { on_menu(app, e.id().as_ref()) })
                .build(app)?;
            // The webview relays the server's /api/events stream: tray state and notifications.
            let hh = h.clone();
            let last = std::sync::atomic::AtomicUsize::new(usize::MAX);
            app.listen("tray", move |e| {
                if EXITING.load(Ordering::Relaxed) { return }
                let Ok(st) = serde_json::from_str::<TrayState>(e.payload()) else { return };
                *lock(&LAST_TRAY) = Some(st.clone());
                let n = st.needs.len();
                NEEDS.store(n, Ordering::Relaxed);
                let _ = tray.set_title(tray_title(n));
                if last.swap(n, std::sync::atomic::Ordering::Relaxed) != n {
                    log(&format!("tray: needs={n} working={}", st.working.len()));
                }
                if let Ok(m) = build_menu(&hh, &st) {
                    let _ = tray.set_menu(Some(m));
                }
            });
            let hh = h.clone();
            app.listen("update", move |e| {
                if EXITING.load(Ordering::Relaxed) { return }
                UPDATE.store(e.payload() == "true", Ordering::Relaxed);
                if let Some(t) = hh.tray_by_id("main") { let _ = t.set_title(tray_title(NEEDS.load(Ordering::Relaxed))); }
                if let Some(w) = hh.get_webview_window("main") { let _ = w.set_badge_label(UPDATE.load(Ordering::Relaxed).then(|| "•".to_string())); }
            });
            let hh = h.clone();
            app.listen("notify", move |e| {
                if EXITING.load(Ordering::Relaxed) { return }
                let Ok(n) = serde_json::from_str::<Notify>(e.payload()) else { return };
                let r = hh.notification().builder().title(&n.title).body(&n.body).show();
                log(&format!("notify: {} | {} -> {r:?}", n.title, n.body));
            });
            let hh = h.clone();
            app.listen("server-control", move |e| {
                if EXITING.load(Ordering::Relaxed) { return }
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(e.payload()) {
                    if let Some(a) = v.get("action").and_then(|a| a.as_str()) {
                        control(&hh, a);
                    }
                }
            });
            let hh = h.clone();
            app.listen("browser", move |e| {
                if EXITING.load(Ordering::Relaxed) { return }
                let Some(u) = serde_json::from_str::<serde_json::Value>(e.payload()).ok()
                    .and_then(|v| v.get("url").and_then(|u| u.as_str()).map(String::from)) else { return };
                let hh = hh.clone();
                std::thread::spawn(move || open_browser(&hh, &u));
            });
            let handle = h;
            std::thread::spawn(move || {
                let url = if healthy() {
                    log("server: reusing the one already on :7777 (external)");
                    WebviewUrl::External(URL.parse().unwrap())
                } else {
                    // Launch (incl. at login): no server → app-managed one; one retry before the error page.
                    let mut r = spawn_and_wait(&handle);
                    if let Err(e) = &r {
                        log(&format!("server: first start failed ({e}); retrying once"));
                        stop_child(&handle);
                        r = spawn_and_wait(&handle);
                    }
                    match r {
                        Ok(()) => WebviewUrl::External(URL.parse().unwrap()),
                        Err(e) => { ON_ERROR_PAGE.store(true, Ordering::Relaxed); error_page(&e) }
                    }
                };
                update_state(&handle);
                let sup = handle.clone();
                std::thread::spawn(move || supervise(sup));
                // Test hook: WT_DASHBOARD_SELFTEST=restart|takeover|start runs that control 15s after launch,
                // through the same path as the tray and the status bar.
                if let Ok(action) = std::env::var("WT_DASHBOARD_SELFTEST") {
                    let t = handle.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_secs(15));
                        log(&format!("selftest: {action}"));
                        control(&t, &action);
                    });
                }
                let _ = WebviewWindowBuilder::new(&handle, "main", url)
                    .title("wt-dashboard")
                    .inner_size(1440.0, 900.0)
                    .min_inner_size(900.0, 600.0)
                    .build();
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .unwrap_or_else(|e| {
            log(&format!("startup failed: {e}"));
            std::process::exit(1)
        });

    app.run(|handle, event| match event {
        RunEvent::Reopen { .. } => show(handle), // dock icon click
        RunEvent::ExitRequested { .. } => EXITING.store(true, Ordering::Relaxed),
        RunEvent::Exit => {
            EXITING.store(true, Ordering::Relaxed);
            log("exit");
            if let Some(mut c) = handle.state::<Sidecar>().0.lock().unwrap_or_else(|p| p.into_inner()).take() {
                let _ = c.kill();
                let _ = c.wait();
            }
        }
        _ => {}
    });
}
