//! Indexed clicks use advertised AX actions or the observed element's live window bounds.
use crate::{ax::bindings::*, input, owned_window};
use anyhow::{ensure, Context, Result};
use core_foundation::base::{CFRelease, CFTypeRef};

pub fn click(pid: i32, pointer: usize, button: &str, count: usize) -> Result<()> {
    ensure!(
        matches!((button, count), ("left", 1 | 2) | ("right", 1)),
        "Unsupported mouse button or click count"
    );
    let element = pointer as AXUIElementRef;
    let actions = unsafe { copy_action_names(element) };
    let action = if button == "right" && actions.iter().any(|name| name == "AXShowMenu") {
        Some("show_menu")
    } else if button == "left" && count == 1 {
        if actions.iter().any(|name| name == "AXPress") {
            Some("press")
        } else if actions.iter().any(|name| name == "AXPick") {
            Some("pick")
        } else {
            None
        }
    } else {
        None
    };
    if let Some(action) = action {
        return input::ax_actions::perform_ax_action(pointer, action);
    }
    let [x, y, width, height] = unsafe { element_screen_rect(element) }
        .context("Element has no pointer bounds; refresh getAXState")?;
    let window_element = unsafe { copy_element_attr(element, "AXWindow") }
        .context("Element has no owning window; refresh getAXState")?;
    let id = unsafe { ax_get_window_id(window_element) };
    unsafe { CFRelease(window_element as CFTypeRef) };
    let window = owned_window(pid, id.context("Element window is not available")?)?;
    let x = x + width / 2.0;
    let y = y + height / 2.0;
    let wx = x - window.bounds.x;
    let wy = y - window.bounds.y;
    ensure!(
        width > 0.0
            && height > 0.0
            && wx >= 0.0
            && wy >= 0.0
            && wx < window.bounds.width
            && wy < window.bounds.height,
        "Element is outside its window; refresh getAXState"
    );
    input::ax_actions::ensure_ax_action_enabled(pointer, "pointer click")?;
    if button == "right" {
        input::mouse::right_click_at_xy_with_window_local(pid, x, y, wx, wy, window.window_id, &[])
    } else {
        input::mouse::click_at_xy_with_window_local(
            pid,
            x,
            y,
            wx,
            wy,
            window.window_id,
            count,
            &[],
            input::mouse::WindowClickDelivery::Background,
        )
    }
}
