//! Running-application discovery adapted from Cua Driver's apps/mod.rs.
use serde::Serialize;

/// Immediate focus observations; missing values do not establish focus or stacking.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForegroundObservation {
    pub front_pid: Option<i32>,
    /// The target application's AX focus, which can persist while the app is inactive.
    pub focused_window_id: Option<u32>,
    /// The first on-screen layer-0 window across all applications.
    pub front_window_id: Option<u32>,
    pub front_window_pid: Option<i32>,
}

/// Requests made by one operation; sequential before/after observations do not verify causality.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ForegroundAction {
    pub operation: &'static str,
    pub target_pid: i32,
    pub target_window_id: Option<u32>,
    pub before: ForegroundObservation,
    pub after: ForegroundObservation,
    pub activation_requested: bool,
    pub raise_requested: bool,
}

#[derive(Default)]
#[repr(C)]
struct ProcessSerialNumber {
    high: u32,
    low: u32,
}

type GetFrontProcess = unsafe extern "C" fn(*mut ProcessSerialNumber) -> i32;

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    // HIServices/Processes.h: OSStatus GetProcessPID(const ProcessSerialNumber *, pid_t *).
    fn GetProcessPID(psn: *const ProcessSerialNumber, pid: *mut libc::pid_t) -> i32;
}

fn read_front_pid(
    get_front: impl FnOnce(&mut ProcessSerialNumber) -> i32,
    get_pid: impl FnOnce(&ProcessSerialNumber, &mut i32) -> i32,
) -> Option<i32> {
    let mut psn = ProcessSerialNumber::default();
    if get_front(&mut psn) != 0 {
        return None;
    }
    let mut pid = 0;
    (get_pid(&psn, &mut pid) == 0 && pid > 0).then_some(pid)
}

/// Read WindowServer's front process directly; unavailable SPI leaves the observation unknown.
pub fn front_pid() -> Option<i32> {
    use std::sync::OnceLock;
    static GET_FRONT: OnceLock<Option<GetFrontProcess>> = OnceLock::new();
    let get_front = (*GET_FRONT.get_or_init(|| unsafe {
        // Retain the library for the cached function pointer's process lifetime.
        libc::dlopen(
            c"/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight".as_ptr(),
            libc::RTLD_LAZY | libc::RTLD_GLOBAL,
        );
        let symbol = libc::dlsym(libc::RTLD_DEFAULT, c"_SLPSGetFrontProcess".as_ptr());
        (!symbol.is_null())
            .then(|| std::mem::transmute::<*mut libc::c_void, GetFrontProcess>(symbol))
    }))?;
    read_front_pid(
        |psn| unsafe { get_front(psn) },
        |psn, pid| unsafe { GetProcessPID(psn, pid) },
    )
}

/// Observe the target's AX focus and the first on-screen normal window alongside WindowServer focus.
pub fn observe_foreground(pid: i32) -> ForegroundObservation {
    let focused_window_id = crate::ax::bindings::focused_window_id_of_pid(pid);
    let front_window = crate::windows::visible_windows().into_iter().next();
    let front_pid = front_pid();
    ForegroundObservation {
        front_pid,
        focused_window_id,
        front_window_id: front_window.as_ref().map(|window| window.window_id),
        front_window_pid: front_window.map(|window| window.pid),
    }
}

fn activate_if_needed(
    pid: i32,
    front_pid: Option<i32>,
    request: impl FnOnce() -> anyhow::Result<()>,
) -> anyhow::Result<bool> {
    if front_pid == Some(pid) {
        return Ok(false);
    }
    request()?;
    Ok(true)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub pid: i32,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
}

pub fn list_apps() -> Vec<AppInfo> {
    use objc2_app_kit::{NSApplicationActivationPolicy, NSWorkspace};
    let mut apps = Vec::new();
    unsafe {
        let running = NSWorkspace::sharedWorkspace().runningApplications();
        for index in 0..running.count() {
            let app = running.objectAtIndex(index);
            if app.isTerminated()
                || app.activationPolicy() != NSApplicationActivationPolicy::Regular
            {
                continue;
            }
            if let Some(name) = app.localizedName() {
                apps.push(AppInfo {
                    pid: app.processIdentifier(),
                    name: name.to_string(),
                    bundle_id: app.bundleIdentifier().map(|value| value.to_string()),
                });
            }
        }
    }
    apps
}

pub fn bundle_id_for_pid(pid: i32) -> Option<String> {
    use objc2_app_kit::NSRunningApplication;
    unsafe {
        let app = NSRunningApplication::runningApplicationWithProcessIdentifier(pid)?;
        Some(app.bundleIdentifier()?.to_string())
    }
}

pub fn path_for_pid(pid: i32) -> Option<String> {
    use objc2_app_kit::NSRunningApplication;
    unsafe {
        NSRunningApplication::runningApplicationWithProcessIdentifier(pid)?
            .bundleURL()?
            .path()
            .map(|value| value.to_string())
    }
}

/// Request activation unless WindowServer already reports this process frontmost.
pub fn activate(pid: i32) -> anyhow::Result<ForegroundAction> {
    use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication};
    let before = observe_foreground(pid);
    let activation_requested = activate_if_needed(pid, before.front_pid, || unsafe {
        let app = NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
            .ok_or_else(|| anyhow::anyhow!("Application exited before activation"))?;
        app.unhide();
        anyhow::ensure!(
            app.activateWithOptions(NSApplicationActivationOptions::empty()),
            "macOS refused application activation"
        );
        Ok(())
    })?;
    Ok(ForegroundAction {
        operation: "activate",
        target_pid: pid,
        target_window_id: None,
        before,
        after: observe_foreground(pid),
        activation_requested,
        raise_requested: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    #[test]
    fn front_process_read_requires_both_queries_and_a_positive_pid() {
        assert_eq!(
            read_front_pid(|_| -1, |_, _| panic!("no PSN was read")),
            None
        );
        assert_eq!(read_front_pid(|_| 0, |_, _| -1), None);
        assert_eq!(read_front_pid(|_| 0, |_, _| 0), None);
        assert_eq!(
            read_front_pid(
                |_| 0,
                |_, pid| {
                    *pid = 42;
                    0
                }
            ),
            Some(42)
        );
    }

    #[test]
    fn already_frontmost_process_does_not_request_activation() {
        assert!(!activate_if_needed(42, Some(42), || panic!("activation repeated")).unwrap());
    }

    #[test]
    fn other_or_unknown_front_process_preserves_activation_and_its_errors() {
        let calls = Cell::new(0);
        for front in [Some(7), None] {
            assert!(activate_if_needed(42, front, || {
                calls.set(calls.get() + 1);
                Ok(())
            })
            .unwrap());
        }
        assert_eq!(calls.get(), 2);
        let error =
            activate_if_needed(42, None, || anyhow::bail!("activation refused")).unwrap_err();
        assert_eq!(error.to_string(), "activation refused");
    }
}
