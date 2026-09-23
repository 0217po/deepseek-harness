//! Running-application discovery adapted from Cua Driver's apps/mod.rs.
use serde::Serialize;

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
            if app.isTerminated() || app.activationPolicy() != NSApplicationActivationPolicy::Regular {
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
