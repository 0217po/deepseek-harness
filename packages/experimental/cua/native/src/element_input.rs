//! Indexed clicks use advertised AX actions or the observed element's live window bounds.
use crate::{ax::bindings::*, input, panels};
use anyhow::{ensure, Context, Result};

fn action_key(value: &str) -> String {
    value
        .strip_prefix("AX")
        .unwrap_or(value)
        .chars()
        .filter(|character| !character.is_whitespace())
        .flat_map(char::to_lowercase)
        .collect()
}

pub fn secondary_action(pid: i32, pointer: usize, requested: &str) -> Result<()> {
    let element = pointer as AXUIElementRef;
    let actions = unsafe { copy_action_names(element) };
    let action = actions
        .iter()
        .find(|action| action_key(action) == action_key(requested))
        .context("Element does not advertise this action; refresh getAXState")?;
    input::ax_actions::ensure_ax_action_enabled(pointer, action)?;
    if action == "AXRaise" {
        crate::apps::activate(pid)?;
    }
    let error = unsafe { perform_action(element, action) };
    ensure!(
        error == kAXErrorSuccess,
        "Accessibility action {requested} failed with error {error}"
    );
    Ok(())
}

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
    let window = panels::enclosing_window(pid, pointer)?;
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

#[cfg(test)]
mod tests {
    use super::action_key;

    #[test]
    fn observed_native_and_display_action_names_match() {
        assert_eq!(action_key("AXRaise"), action_key("Raise"));
        assert_eq!(action_key("AXZoomWindow"), action_key("zoom window"));
        assert_ne!(action_key("AXRaise"), action_key("AXPress"));
    }
}
