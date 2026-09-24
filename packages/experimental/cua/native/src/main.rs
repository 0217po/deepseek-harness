//! JSON-lines process owning macOS application identities and accessibility references.
#![allow(dead_code)]
mod apps;
mod ax;
mod element_input;
mod input;
mod panels;
mod permissions;
mod windows;

use anyhow::{bail, ensure, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use core_foundation::base::{CFRelease, CFTypeRef};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{self, BufRead, Read, Write},
};

const METHODS: &[&str] = &[
    "getCapabilities",
    "listApps",
    "getApp",
    "activate",
    "listWindows",
    "getState",
    "click",
    "setValue",
    "performSecondaryAction",
    "typeText",
    "pressKey",
    "scroll",
    "drag",
    "screenshot",
];

#[derive(Debug)]
struct DriverError {
    code: &'static str,
    message: String,
}
impl std::fmt::Display for DriverError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}
impl std::error::Error for DriverError {}
fn failure(code: &'static str, message: impl Into<String>) -> anyhow::Error {
    DriverError {
        code,
        message: message.into(),
    }
    .into()
}
fn require(condition: bool, code: &'static str, message: &str) -> Result<()> {
    if condition {
        Ok(())
    } else {
        Err(failure(code, message))
    }
}
fn invalid(message: impl Into<String>) -> anyhow::Error {
    failure("INVALID_ARGUMENT", message)
}
fn require_unlocked_session(locked: Option<bool>) -> Result<()> {
    match locked {
        Some(false) => Ok(()),
        Some(true) => Err(failure("SESSION_LOCKED", "macOS is locked. Ask the user to unlock it, then read fresh state before resuming; do not retry UI actions while locked")),
        None => Err(failure("SESSION_UNAVAILABLE", "No unlocked console session could be verified; restore the macOS desktop session before using CUA")),
    }
}
fn error_reply(error: anyhow::Error) -> Value {
    json!({"code":error.downcast_ref::<DriverError>().map_or("NATIVE_ERROR", |error| error.code),"message":error.to_string()})
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: String,
    method: String,
    params: Value,
}

#[derive(Clone, Copy, Debug)]
struct Target {
    pid: i32,
    started: (u64, u64),
}
struct Snapshot {
    id: String,
    window_id: Option<u32>,
    elements: HashMap<usize, usize>,
}
impl Drop for Snapshot {
    fn drop(&mut self) {
        for pointer in self.elements.values() {
            unsafe {
                CFRelease(*pointer as CFTypeRef);
            }
        }
    }
}

#[derive(Default)]
struct Driver {
    namespace: String,
    sequence: u64,
    targets: HashMap<String, Target>,
    snapshots: HashMap<(String, Option<u32>), Snapshot>,
}

fn integer(params: &Value, name: &str) -> Result<i32> {
    i32::try_from(
        params[name]
            .as_i64()
            .ok_or_else(|| invalid(format!("{name} must be an integer")))?,
    )
    .map_err(|_| invalid(format!("{name} is outside i32 range")))
}
fn text<'a>(params: &'a Value, name: &str) -> Result<&'a str> {
    params[name]
        .as_str()
        .ok_or_else(|| invalid(format!("{name} must be a string")))
}
fn number(params: &Value, name: &str) -> Result<f64> {
    params[name]
        .as_f64()
        .filter(|value| value.is_finite())
        .ok_or_else(|| invalid(format!("{name} must be finite")))
}
fn window_id(params: &Value) -> Result<u32> {
    let id = params["windowId"]
        .as_u64()
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value > 0);
    id.ok_or_else(|| invalid("windowId must be a positive u32 integer"))
}
fn process_started(pid: i32) -> Result<(u64, u64)> {
    unsafe {
        let mut info: libc::proc_bsdinfo = std::mem::zeroed();
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
        let result = libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            &mut info as *mut _ as *mut libc::c_void,
            size,
        );
        require(
            result == size,
            "APP_UNAVAILABLE",
            "Target application exited or cannot be inspected; select it again",
        )?;
        Ok((info.pbi_start_tvsec, info.pbi_start_tvusec))
    }
}
fn owned_window(pid: i32, id: u32) -> Result<windows::WindowInfo> {
    let window = windows::window_info_by_id(id).ok_or_else(|| {
        failure(
            "WINDOW_UNAVAILABLE",
            "Window closed or is unavailable; refresh getWindows",
        )
    })?;
    require(
        window.pid == pid,
        "WINDOW_UNAVAILABLE",
        "Window belongs to another application; refresh getWindows",
    )?;
    Ok(window)
}
fn window_json(window: &windows::WindowInfo) -> Value {
    json!({"windowId":window.window_id,"pid":window.pid,"appName":window.app_name,"title":window.title,"bounds":window.bounds,"isOnScreen":window.is_on_screen,"onCurrentSpace":window.on_current_space})
}
fn point(
    params: &Value,
    x_name: &str,
    y_name: &str,
    window: &windows::WindowInfo,
) -> Result<(f64, f64)> {
    let x = number(params, x_name)?;
    let y = number(params, y_name)?;
    require(
        x >= 0.0 && x < window.bounds.width && y >= 0.0 && y < window.bounds.height,
        "INVALID_ARGUMENT",
        "Point is outside the selected window; use window-local macOS points",
    )?;
    Ok((x, y))
}
fn modifiers(params: &Value) -> Result<Vec<String>> {
    let values: Vec<String> = params
        .get("modifiers")
        .map(|value| serde_json::from_value(value.clone()))
        .transpose()
        .map_err(|_| invalid("modifiers must be an array of modifier names"))?
        .unwrap_or_default();
    require(
        values.iter().all(|value| {
            matches!(
                value.as_str(),
                "command" | "cmd" | "shift" | "option" | "alt" | "control" | "ctrl" | "fn"
            )
        }),
        "INVALID_ARGUMENT",
        "Unsupported key modifier",
    )?;
    Ok(values)
}
fn scroll_delta(params: &Value, name: &str) -> Result<i32> {
    let value = if params.get(name).is_some() {
        integer(params, name)?
    } else {
        0
    };
    require(
        (-10..=10).contains(&value),
        "INVALID_ARGUMENT",
        "Scroll line deltas must be integers between -10 and 10",
    )?;
    Ok(value * 120)
}
fn png_dimensions(bytes: &[u8]) -> Result<(u32, u32)> {
    ensure!(
        bytes.len() >= 24 && bytes.starts_with(b"\x89PNG\r\n\x1a\n") && &bytes[12..16] == b"IHDR",
        "Capture did not produce a PNG header"
    );
    let width = u32::from_be_bytes(bytes[16..20].try_into()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into()?);
    ensure!(
        width > 0 && height > 0,
        "Capture produced empty PNG dimensions"
    );
    Ok((width, height))
}

impl Driver {
    fn observe_session(&mut self) -> Option<bool> {
        let locked = permissions::session_locked();
        if locked != Some(false) {
            self.snapshots.clear();
        }
        locked
    }
    fn identifier(&mut self, kind: &str) -> String {
        self.sequence += 1;
        format!("{}:{kind}:{}", self.namespace, self.sequence)
    }
    fn forget(&mut self, handle: &str) {
        self.targets.remove(handle);
        self.snapshots.retain(|(owner, _), _| owner != handle);
    }
    fn remember_app(&mut self, pid: i32, started: (u64, u64)) -> String {
        let existing = self
            .targets
            .iter()
            .find(|(_, target)| target.pid == pid)
            .map(|(handle, target)| (handle.clone(), *target));
        if let Some((handle, target)) = existing {
            if target.started == started {
                return handle;
            }
            self.forget(&handle);
        }
        let handle = self.identifier("app");
        self.targets.insert(handle.clone(), Target { pid, started });
        handle
    }
    fn validate_started(&mut self, handle: &str, observed: (u64, u64)) -> Result<Target> {
        let target =
            self.targets.get(handle).copied().ok_or_else(|| {
                failure("STALE_APP", "Application handle expired; call getApp again")
            })?;
        if target.started != observed {
            self.forget(handle);
            return Err(failure(
                "STALE_APP",
                "Application process changed; call getApp again",
            ));
        }
        Ok(target)
    }
    fn target(&mut self, handle: &str) -> Result<Target> {
        let target =
            self.targets.get(handle).copied().ok_or_else(|| {
                failure("STALE_APP", "Application handle expired; call getApp again")
            })?;
        match process_started(target.pid) {
            Ok(started) => self.validate_started(handle, started),
            Err(error) => {
                self.forget(handle);
                Err(error)
            }
        }
    }
    fn snapshot(&self, handle: &str, params: &Value) -> Result<&Snapshot> {
        let id = text(params, "snapshotId")?;
        self.snapshots
            .iter()
            .find(|((owner, _), snapshot)| owner == handle && snapshot.id == id)
            .map(|(_, snapshot)| snapshot)
            .ok_or_else(|| {
                failure(
                    "STALE_SNAPSHOT",
                    "Snapshot expired; refresh getAXState before using element indices",
                )
            })
    }
    fn element(&self, handle: &str, params: &Value) -> Result<usize> {
        let snapshot = self.snapshot(handle, params)?;
        let index = params["elementIndex"]
            .as_u64()
            .and_then(|value| usize::try_from(value).ok())
            .ok_or_else(|| invalid("elementIndex must be nonnegative"))?;
        snapshot
            .elements
            .get(&index)
            .copied()
            .ok_or_else(|| invalid("elementIndex is absent from the selected snapshot"))
    }
    fn coordinate_snapshot(&self, handle: &str, params: &Value, window_id: u32) -> Result<()> {
        if params.get("snapshotId").is_some() {
            let snapshot = self.snapshot(handle, params)?;
            require(
                snapshot.window_id.is_none() || snapshot.window_id == Some(window_id),
                "STALE_SNAPSHOT",
                "Snapshot belongs to another window; refresh the selected window",
            )?;
        }
        Ok(())
    }
    fn call(&mut self, method: &str, params: &Value) -> Result<Value> {
        let object = params
            .as_object()
            .ok_or_else(|| invalid("params must be an object"))?;
        let allowed: &[&str] = match method {
            "getCapabilities" | "listApps" => &[],
            "getApp" => &["selector"],
            "listWindows" | "activate" => &["appHandle"],
            "getState" => &["appHandle", "windowId", "maxElements", "maxDepth"],
            "click" => &[
                "appHandle",
                "snapshotId",
                "elementIndex",
                "windowId",
                "x",
                "y",
                "mouseButton",
                "clickCount",
            ],
            "setValue" => &["appHandle", "snapshotId", "elementIndex", "value"],
            "performSecondaryAction" => &["appHandle", "snapshotId", "elementIndex", "action"],
            "typeText" => &["appHandle", "text"],
            "pressKey" => &["appHandle", "key", "modifiers"],
            "scroll" => &[
                "appHandle",
                "windowId",
                "snapshotId",
                "x",
                "y",
                "deltaLinesX",
                "deltaLinesY",
            ],
            "drag" => &[
                "appHandle",
                "windowId",
                "snapshotId",
                "fromX",
                "fromY",
                "toX",
                "toY",
                "durationMs",
                "steps",
            ],
            "screenshot" => &["appHandle", "windowId"],
            _ => {
                return Err(failure(
                    "UNSUPPORTED",
                    format!("Unsupported native operation: {method}"),
                ))
            }
        };
        require(
            object.keys().all(|key| allowed.contains(&key.as_str())),
            "INVALID_ARGUMENT",
            "Unknown operation parameter",
        )?;
        let session_locked = self.observe_session();
        if method == "getCapabilities" {
            return Ok(
                json!({"platform":"macos","permissions":{"accessibility":permissions::accessibility(),"screenRecording":permissions::screen_recording()},"sessionLocked":session_locked,"methods":METHODS,"coordinateSpace":"window-points","browser":false}),
            );
        }
        if method == "listApps" {
            return Ok(json!(apps::list_apps()));
        }
        require_unlocked_session(session_locked)?;
        if method == "getApp" {
            let selector = text(params, "selector")?;
            let matches: Vec<_> = apps::list_apps()
                .into_iter()
                .filter(|app| {
                    app.name == selector
                        || app.bundle_id.as_deref() == Some(selector)
                        || app.pid.to_string() == selector
                        || (selector.starts_with('/')
                            && apps::path_for_pid(app.pid).as_deref() == Some(selector))
                })
                .collect();
            require(
                !matches.is_empty(),
                "APP_UNAVAILABLE",
                "No running app matches selector; open the app first or use listApps",
            )?;
            require(
                matches.len() == 1,
                "AMBIGUOUS_APP",
                "Selector matches multiple running apps; select an exact PID from listApps",
            )?;
            let app = &matches[0];
            let handle = self.remember_app(app.pid, process_started(app.pid)?);
            let mut result = json!({"pid":app.pid,"appHandle":handle,"name":app.name});
            if let Some(bundle_id) = &app.bundle_id {
                result["bundleId"] = json!(bundle_id);
            }
            return Ok(result);
        }
        let handle = text(params, "appHandle")?.to_owned();
        let target = self.target(&handle)?;
        let pid = target.pid;
        if method == "listWindows" {
            let windows: Vec<_> = windows::all_windows()
                .into_iter()
                .filter(|window| window.pid == pid)
                .collect();
            self.snapshots.retain(|(owner, scope), _| {
                owner != &handle
                    || scope.is_none()
                    || windows
                        .iter()
                        .any(|window| Some(window.window_id) == *scope)
            });
            return Ok(json!(windows.iter().map(window_json).collect::<Vec<_>>()));
        }
        if method == "getState" {
            let scope = if params.get("windowId").is_some() {
                Some(window_id(params)?)
            } else {
                None
            };
            // Permission and traversal failures cannot revive the previous observation.
            self.snapshots.remove(&(handle.clone(), scope));
        }
        if method != "screenshot" {
            require(permissions::accessibility(), "PERMISSION_DENIED", "Accessibility permission is required for the responsible DSH host/helper; enable it in macOS Privacy & Security")?;
        }
        match method {
            "activate" => {
                apps::activate(pid)?;
                Ok(json!({"dispatched":true,"verified":false}))
            }
            "getState" => {
                let window = if params.get("windowId").is_some() {
                    Some(window_id(params)?)
                } else {
                    None
                };
                let scope = (handle.clone(), window);
                if let Some(id) = window {
                    owned_window(pid, id)?;
                }
                let max_elements = params["maxElements"]
                    .as_u64()
                    .ok_or_else(|| invalid("maxElements must be positive"))?;
                let max_depth = params["maxDepth"]
                    .as_u64()
                    .ok_or_else(|| invalid("maxDepth must be positive"))?;
                require(
                    max_elements > 0 && max_elements <= 10000 && max_depth > 0 && max_depth <= 100,
                    "INVALID_ARGUMENT",
                    "Tree limits exceed maxElements 1..10000 or maxDepth 1..100",
                )?;
                let tree = ax::tree::walk_tree_bounded(
                    pid,
                    window,
                    None,
                    max_elements as usize,
                    max_depth as usize,
                );
                let id = self.identifier("snapshot");
                let snapshot = Snapshot {
                    id: id.clone(),
                    window_id: window,
                    elements: tree
                        .nodes
                        .iter()
                        .filter_map(|node| {
                            node.element_index.map(|index| (index, node.element_ptr))
                        })
                        .collect(),
                };
                self.validate_started(&handle, process_started(pid)?)?;
                require_unlocked_session(self.observe_session())?;
                if let Some(scope) = &tree.window_scope {
                    require(
                        scope.is_matched(),
                        "WINDOW_UNAVAILABLE",
                        "Selected window has no matching accessibility surface. If it is hidden or on another Space, activate the app explicitly before observing again",
                    )?;
                }
                let elements: Vec<_> = tree.nodes.iter().filter_map(|node| node.element_index.map(|index| json!({
                    "index":index,"role":node.role,"title":node.title,"value":node.value_state,"description":node.description,
                    "identifier":node.identifier,"bounds":node.frame,"actions":node.actions,"enabled":node.enabled,
                }))).collect();
                let result = json!({"appHandle":handle,"pid":pid,"windowId":window,"focusedWindowId":ax::bindings::focused_window_id_of_pid(pid),"snapshotId":id,"tree":tree.tree_markdown,"elements":elements,
                    "windows":windows::all_windows().into_iter().filter(|w| w.pid == pid).map(|w| window_json(&w)).collect::<Vec<_>>(),"truncated":tree.truncated});
                self.snapshots.insert(scope, snapshot);
                Ok(result)
            }
            "click" => {
                if params.get("elementIndex").is_some() {
                    require(
                        !["x", "y", "windowId"]
                            .iter()
                            .any(|key| params.get(*key).is_some()),
                        "INVALID_ARGUMENT",
                        "Element and coordinate targets cannot be combined",
                    )?;
                    let button = params
                        .get("mouseButton")
                        .map(|_| text(params, "mouseButton"))
                        .transpose()?
                        .unwrap_or("left");
                    let count = params
                        .get("clickCount")
                        .map(|_| integer(params, "clickCount"))
                        .transpose()?
                        .unwrap_or(1);
                    require(
                        matches!((button, count), ("left", 1 | 2) | ("right", 1)),
                        "INVALID_ARGUMENT",
                        "Unsupported mouse button or click count",
                    )?;
                    element_input::click(
                        pid,
                        self.element(&handle, params)?,
                        button,
                        count as usize,
                    )?;
                } else {
                    let id = window_id(params)?;
                    self.coordinate_snapshot(&handle, params, id)?;
                    let window = owned_window(pid, id)?;
                    let (x, y) = point(params, "x", "y", &window)?;
                    let count = params
                        .get("clickCount")
                        .map(|_| integer(params, "clickCount"))
                        .transpose()?
                        .unwrap_or(1);
                    require(
                        count == 1 || count == 2,
                        "INVALID_ARGUMENT",
                        "clickCount must be 1 or 2",
                    )?;
                    let button = params
                        .get("mouseButton")
                        .map(|_| text(params, "mouseButton"))
                        .transpose()?
                        .unwrap_or("left");
                    match button {
                        "left" => input::mouse::click_at_xy_with_window_local(
                            pid,
                            window.bounds.x + x,
                            window.bounds.y + y,
                            x,
                            y,
                            id,
                            count as usize,
                            &[],
                            input::mouse::WindowClickDelivery::Background,
                        )?,
                        "right" => {
                            require(
                                count == 1,
                                "INVALID_ARGUMENT",
                                "Right click supports count 1",
                            )?;
                            input::mouse::right_click_at_xy_with_window_local(
                                pid,
                                window.bounds.x + x,
                                window.bounds.y + y,
                                x,
                                y,
                                id,
                                &[],
                            )?;
                        }
                        _ => return Err(invalid("mouseButton must be left or right")),
                    }
                }
                Ok(json!({"dispatched":true,"verified":false}))
            }
            "setValue" => {
                input::ax_actions::set_ax_value(
                    self.element(&handle, params)?,
                    text(params, "value")?,
                )?;
                Ok(json!({"dispatched":true,"verified":false}))
            }
            "performSecondaryAction" => {
                element_input::secondary_action(
                    pid,
                    self.element(&handle, params)?,
                    text(params, "action")?,
                )?;
                Ok(json!({"dispatched":true,"verified":false}))
            }
            "typeText" => {
                input::keyboard::type_text(panels::keyboard_pid(pid)?, text(params, "text")?)?;
                Ok(json!({"dispatched":true,"verified":false}))
            }
            "pressKey" => {
                let modifiers = modifiers(params)?;
                let refs: Vec<_> = modifiers.iter().map(String::as_str).collect();
                input::keyboard::press_key(
                    panels::keyboard_pid(pid)?,
                    text(params, "key")?,
                    &refs,
                )?;
                Ok(json!({"dispatched":true,"verified":false}))
            }
            "scroll" => {
                let id = window_id(params)?;
                self.coordinate_snapshot(&handle, params, id)?;
                let window = owned_window(pid, id)?;
                let (x, y) = point(params, "x", "y", &window)?;
                let dx = scroll_delta(params, "deltaLinesX")?;
                let dy = scroll_delta(params, "deltaLinesY")?;
                require(
                    dx != 0 || dy != 0,
                    "INVALID_ARGUMENT",
                    "Provide at least one nonzero scroll line delta",
                )?;
                input::mouse::scroll_wheel_at_xy(
                    pid,
                    window.bounds.x + x,
                    window.bounds.y + y,
                    Some((x, y)),
                    Some(id),
                    dy,
                    dx,
                    1,
                )?;
                Ok(json!({"dispatched":true,"verified":false}))
            }
            "drag" => {
                let id = window_id(params)?;
                self.coordinate_snapshot(&handle, params, id)?;
                let window = owned_window(pid, id)?;
                let (fx, fy) = point(params, "fromX", "fromY", &window)?;
                let (tx, ty) = point(params, "toX", "toY", &window)?;
                let duration = integer(params, "durationMs")?;
                let steps = integer(params, "steps")?;
                require(
                    (1..=5000).contains(&duration) && (1..=240).contains(&steps),
                    "INVALID_ARGUMENT",
                    "Drag durationMs must be 1..5000 and steps 1..240",
                )?;
                input::mouse::drag_at_xy(
                    pid,
                    window.bounds.x + fx,
                    window.bounds.y + fy,
                    window.bounds.x + tx,
                    window.bounds.y + ty,
                    Some((fx, fy)),
                    Some((tx, ty)),
                    Some(id),
                    duration as u64,
                    steps as usize,
                    &[],
                    input::mouse::DragButton::Left,
                    false,
                )?;
                Ok(json!({"dispatched":true,"verified":false}))
            }
            "screenshot" => {
                require(permissions::screen_recording(), "PERMISSION_DENIED", "Screen Recording permission is required for the responsible DSH host/helper; enable it in macOS Privacy & Security")?;
                let id = window_id(params)?;
                let window = owned_window(pid, id)?;
                let directory = tempfile::tempdir()?;
                let path = directory.path().join("window.png");
                let output = std::process::Command::new("/usr/sbin/screencapture")
                    .args(["-x", "-o", "-l", &id.to_string(), "-t", "png"])
                    .arg(&path)
                    .output()
                    .context("Start system screencapture")?;
                ensure!(
                    output.status.success(),
                    "Window capture failed: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
                let bytes = std::fs::read(&path)
                    .context("screencapture returned without a readable image")?;
                let (width, height) = png_dimensions(&bytes)?;
                self.target(&handle)?;
                let after = owned_window(pid, id)?;
                require_unlocked_session(self.observe_session())?;
                require(
                    window.bounds.x == after.bounds.x
                        && window.bounds.y == after.bounds.y
                        && window.bounds.width == after.bounds.width
                        && window.bounds.height == after.bounds.height,
                    "WINDOW_CHANGED",
                    "Window moved or resized during capture; request a fresh screenshot",
                )?;
                Ok(
                    json!({"mimeType":"image/png","data":STANDARD.encode(bytes),"pixelWidth":width,"pixelHeight":height,"bounds":window.bounds,"coordinateSpace":"window-points","windowId":id}),
                )
            }
            _ => bail!("Native method dispatch is incomplete"),
        }
    }
}

fn main() -> Result<()> {
    let mut entropy = [0_u8; 16];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut entropy)?;
    let mut driver = Driver {
        namespace: entropy.iter().map(|byte| format!("{byte:02x}")).collect(),
        ..Driver::default()
    };
    let stdin = io::stdin();
    let mut stdout = io::stdout().lock();
    for line in stdin.lock().lines() {
        let line = line?;
        let response = match serde_json::from_str::<Request>(&line) {
            Ok(request) => match driver.call(&request.method, &request.params) {
                Ok(result) => json!({"id":request.id,"result":result}),
                Err(error) => json!({"id":request.id,"error":error_reply(error)}),
            },
            Err(error) => {
                json!({"id":null,"error":{"code":"INVALID_REQUEST","message":error.to_string()}})
            }
        };
        serde_json::to_writer(&mut stdout, &response)?;
        writeln!(stdout)?;
        stdout.flush()?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn snapshot(id: &str, window_id: Option<u32>) -> Snapshot {
        Snapshot {
            id: id.to_owned(),
            window_id,
            elements: HashMap::new(),
        }
    }
    #[test]
    fn reused_pid_invalidates_old_handle_and_can_be_acquired_again() {
        let mut driver = Driver::default();
        let original = driver.remember_app(42, (100, 20));
        driver
            .snapshots
            .insert((original.clone(), Some(7)), snapshot("old", Some(7)));
        assert_eq!(driver.remember_app(42, (100, 20)), original);
        assert_eq!(
            error_reply(driver.validate_started(&original, (200, 30)).unwrap_err())["code"],
            "STALE_APP"
        );
        assert!(driver.snapshots.is_empty());
        let replacement = driver.remember_app(42, (200, 30));
        assert_ne!(original, replacement);
        assert!(driver.validate_started(&replacement, (200, 30)).is_ok());
        assert!(driver.validate_started(&original, (100, 20)).is_err());
    }
    #[test]
    fn window_snapshots_remain_independent_and_reject_cross_window_coordinates() {
        let mut driver = Driver::default();
        driver
            .snapshots
            .insert(("app".to_owned(), Some(7)), snapshot("one", Some(7)));
        driver
            .snapshots
            .insert(("app".to_owned(), Some(8)), snapshot("two", Some(8)));
        driver.snapshots.remove(&("app".to_owned(), Some(7)));
        assert!(driver.snapshot("app", &json!({"snapshotId":"two"})).is_ok());
        assert_eq!(
            error_reply(
                driver
                    .snapshot("app", &json!({"snapshotId":"one"}))
                    .err()
                    .unwrap()
            )["code"],
            "STALE_SNAPSHOT"
        );
        assert!(driver
            .coordinate_snapshot("app", &json!({"snapshotId":"two"}), 8)
            .is_ok());
        assert!(driver
            .coordinate_snapshot("app", &json!({"snapshotId":"two"}), 7)
            .is_err());
    }
    #[test]
    fn invalid_parameters_have_stable_codes_before_app_discovery() {
        let mut driver = Driver::default();
        assert_eq!(
            error_reply(
                driver
                    .call("listApps", &json!({"launch":true}))
                    .unwrap_err()
            )["code"],
            "INVALID_ARGUMENT"
        );
        assert_eq!(
            error_reply(driver.call("absent", &json!({})).unwrap_err())["code"],
            "UNSUPPORTED"
        );
        assert!(window_id(&json!({"windowId":-1})).is_err());
        assert!(window_id(&json!({"windowId":4294967296_u64})).is_err());
    }
    #[test]
    fn line_scroll_preserves_small_signed_deltas_without_silent_truncation() {
        assert_eq!(
            scroll_delta(&json!({"deltaLinesY":1}), "deltaLinesY").unwrap(),
            120
        );
        assert_eq!(
            scroll_delta(&json!({"deltaLinesY":-1}), "deltaLinesY").unwrap(),
            -120
        );
        assert!(scroll_delta(&json!({"deltaLinesY":11}), "deltaLinesY").is_err());
        assert!(scroll_delta(&json!({"deltaLinesY":1.5}), "deltaLinesY").is_err());
    }
    #[test]
    fn png_dimensions_use_image_pixels_independently_of_window_points() {
        let mut bytes = b"\x89PNG\r\n\x1a\n\x00\x00\x00\x0dIHDR".to_vec();
        bytes.extend(840_u32.to_be_bytes());
        bytes.extend(400_u32.to_be_bytes());
        assert_eq!(png_dimensions(&bytes).unwrap(), (840, 400));
        assert!(png_dimensions(&bytes[..20]).is_err());
    }
}
