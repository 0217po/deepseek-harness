//! Resolve AppKit sheet windows and their system-hosted keyboard recipient.
use crate::{apps, ax::bindings::*, owned_window, windows};
use anyhow::{bail, ensure, Result};
use core_foundation::base::{CFRelease, CFRetain, CFTypeRef};

const PANEL_SERVICE: &str = "com.apple.appkit.xpc.openAndSavePanelService";
// Bound parent walks even if an application's AX providers contain a cycle.
const MAX_ANCESTORS: usize = 100;

struct Element(AXUIElementRef);
impl Element {
    fn retained(pointer: AXUIElementRef) -> Self {
        unsafe { CFRetain(pointer as CFTypeRef) };
        Self(pointer)
    }
    fn attribute(&self, name: &str) -> Option<Self> {
        unsafe { copy_element_attr(self.0, name) }.map(Self)
    }
    fn string(&self, name: &str) -> Option<String> {
        unsafe { copy_string_attr(self.0, name) }
    }
    fn window_id(&self) -> Option<u32> {
        unsafe { ax_get_window_id(self.0) }
    }
}
impl Drop for Element {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0 as CFTypeRef) };
    }
}

/// Find an app-owned window or sheet above an element whose AXWindow may be absent.
pub fn enclosing_window(pid: i32, pointer: usize) -> Result<windows::WindowInfo> {
    let mut current = Some(Element::retained(pointer as AXUIElementRef));
    for _ in 0..MAX_ANCESTORS {
        let Some(element) = current else { break };
        if matches!(
            element.string("AXRole").as_deref(),
            Some("AXWindow" | "AXSheet")
        ) {
            if let Some(window) = element
                .window_id()
                .and_then(|id| owned_window(pid, id).ok())
            {
                return Ok(window);
            }
        }
        current = element.attribute("AXParent");
    }
    bail!("Element has no app-owned window or sheet; refresh getAXState")
}

fn panel_keyboard_target(
    app_pid: i32,
    targets: &[(i32, u32, String)],
) -> Result<Option<(i32, u32)>> {
    let mut selected = None;
    for (pid, window, bundle) in targets {
        if *pid == app_pid {
            continue;
        }
        ensure!(
            bundle == PANEL_SERVICE,
            "File panel refers to an unsupported remote process"
        );
        let target = (*pid, *window);
        ensure!(
            selected.is_none() || selected == Some(target),
            "File panel has ambiguous remote recipients"
        );
        selected = Some(target);
    }
    Ok(selected)
}

/// Route keys only to a system panel reached from this application's focused sheet.
/// The service's focus must still belong to that exact remote panel.
pub fn keyboard_pid(pid: i32) -> Result<i32> {
    let app = Element(unsafe { AXUIElementCreateApplication(pid) });
    let mut current = app.attribute("AXFocusedWindow");
    for _ in 0..MAX_ANCESTORS {
        let Some(element) = current else {
            return Ok(pid);
        };
        if matches!(
            element.string("AXIdentifier").as_deref(),
            Some("open-panel" | "save-panel")
        ) {
            let host_id = element
                .window_id()
                .ok_or_else(|| anyhow::anyhow!("File panel has no window ID"))?;
            owned_window(pid, host_id)?;
            let children: Vec<_> = unsafe { copy_children(element.0) }
                .into_iter()
                .map(Element)
                .collect();
            let targets: Vec<_> = children
                .iter()
                .filter_map(|child| {
                    let window = windows::window_info_by_id(child.window_id()?)?;
                    Some((
                        window.pid,
                        window.window_id,
                        apps::bundle_id_for_pid(window.pid).unwrap_or_default(),
                    ))
                })
                .collect();
            let Some((recipient, remote_window)) = panel_keyboard_target(pid, &targets)? else {
                return Ok(pid);
            };
            let service = Element(unsafe { AXUIElementCreateApplication(recipient) });
            let mut focus = service.attribute("AXFocusedWindow");
            for _ in 0..MAX_ANCESTORS {
                let Some(focused) = focus else { break };
                if focused.window_id() == Some(remote_window) {
                    return Ok(recipient);
                }
                focus = focused.attribute("AXParent");
            }
            bail!("System file panel focus changed; activate the application and read fresh state");
        }
        current = element.attribute("AXParent");
    }
    bail!("Focused accessibility ancestry exceeds the traversal limit")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn panel_recipient_must_be_one_system_service_window() {
        assert_eq!(panel_keyboard_target(1, &[]).unwrap(), None);
        assert_eq!(
            panel_keyboard_target(1, &[(1, 10, "app".into())]).unwrap(),
            None
        );
        let panel = (2, 20, PANEL_SERVICE.into());
        assert_eq!(
            panel_keyboard_target(1, &[panel.clone(), panel.clone()]).unwrap(),
            Some((2, 20))
        );
        assert!(panel_keyboard_target(1, &[(2, 20, "other.app".into())]).is_err());
        assert!(panel_keyboard_target(1, &[panel.clone(), (2, 21, PANEL_SERVICE.into())]).is_err());
        assert!(panel_keyboard_target(1, &[panel, (3, 30, PANEL_SERVICE.into())]).is_err());
    }
}
