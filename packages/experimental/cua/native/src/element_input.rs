//! Indexed clicks use advertised AX actions or the observed element's live window bounds.
use crate::{apps, ax::bindings::*, input, panels};
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

/// Run an advertised action, reporting foreground requests only for AXRaise.
pub fn secondary_action(
    pid: i32,
    pointer: usize,
    requested: &str,
) -> Result<Option<apps::ForegroundAction>> {
    let element = pointer as AXUIElementRef;
    let actions = unsafe { copy_action_names(element) };
    let action = actions
        .iter()
        .find(|action| action_key(action) == action_key(requested))
        .context("Element does not advertise this action; refresh getAXState")?;
    input::ax_actions::ensure_ax_action_enabled(pointer, action)?;
    if action == "AXRaise" {
        return raise_window(pid, element, requested).map(Some);
    }
    let error = unsafe { perform_action(element, action) };
    ensure!(
        error == kAXErrorSuccess,
        "Accessibility action {requested} failed with error {error}"
    );
    Ok(None)
}

fn can_skip_raise(
    pid: i32,
    window_id: Option<u32>,
    before: &apps::ForegroundObservation,
    role: Option<&str>,
    main: Option<bool>,
    minimized: Option<bool>,
) -> bool {
    window_id.is_some()
        && role == Some("AXWindow")
        && main == Some(true)
        && minimized == Some(false)
        && before.front_pid == Some(pid)
        && before.focused_window_id == window_id
        && before.front_window_id == window_id
        && before.front_window_pid == Some(pid)
}

fn raise_window(
    pid: i32,
    element: AXUIElementRef,
    requested: &str,
) -> Result<apps::ForegroundAction> {
    let target_window_id = unsafe { ax_get_window_id(element) };
    let role = unsafe { copy_string_attr(element, "AXRole") };
    let main = unsafe { copy_bool_attr(element, "AXMain") };
    let minimized = unsafe { copy_bool_attr(element, "AXMinimized") };
    let before = apps::observe_foreground(pid);
    // App-level focus alone does not establish that this particular window is raised.
    let raise_requested = !can_skip_raise(
        pid,
        target_window_id,
        &before,
        role.as_deref(),
        main,
        minimized,
    );
    let activation_requested = if raise_requested {
        let activation = apps::activate(pid)?;
        let error = unsafe { perform_action(element, "AXRaise") };
        ensure!(
            error == kAXErrorSuccess,
            "Accessibility action {requested} failed with error {error}"
        );
        activation.activation_requested
    } else {
        false
    };
    Ok(apps::ForegroundAction {
        operation: "AXRaise",
        target_pid: pid,
        target_window_id,
        before,
        after: apps::observe_foreground(pid),
        activation_requested,
        raise_requested,
    })
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
    use super::*;

    #[test]
    fn observed_native_and_display_action_names_match() {
        assert_eq!(action_key("AXRaise"), action_key("Raise"));
        assert_eq!(action_key("AXZoomWindow"), action_key("zoom window"));
        assert_ne!(action_key("AXRaise"), action_key("AXPress"));
    }

    #[test]
    fn raise_requires_the_exact_focused_front_window_to_be_skipped() {
        let focused = apps::ForegroundObservation {
            front_pid: Some(42),
            focused_window_id: Some(7),
            front_window_id: Some(7),
            front_window_pid: Some(42),
        };
        assert!(can_skip_raise(
            42,
            Some(7),
            &focused,
            Some("AXWindow"),
            Some(true),
            Some(false)
        ));
        for window_id in [None, Some(8)] {
            assert!(!can_skip_raise(
                42,
                window_id,
                &focused,
                Some("AXWindow"),
                Some(true),
                Some(false)
            ));
        }
        for before in [
            apps::ForegroundObservation {
                front_pid: None,
                ..focused
            },
            apps::ForegroundObservation {
                front_pid: Some(99),
                ..focused
            },
            apps::ForegroundObservation {
                focused_window_id: None,
                ..focused
            },
            apps::ForegroundObservation {
                focused_window_id: Some(8),
                ..focused
            },
            apps::ForegroundObservation {
                front_window_id: None,
                ..focused
            },
            apps::ForegroundObservation {
                front_window_id: Some(8),
                ..focused
            },
            apps::ForegroundObservation {
                front_window_pid: None,
                ..focused
            },
            apps::ForegroundObservation {
                front_window_pid: Some(99),
                ..focused
            },
        ] {
            assert!(!can_skip_raise(
                42,
                Some(7),
                &before,
                Some("AXWindow"),
                Some(true),
                Some(false)
            ));
        }
        for (role, main, minimized) in [
            (None, Some(true), Some(false)),
            (Some("AXSheet"), Some(true), Some(false)),
            (Some("AXWindow"), None, Some(false)),
            (Some("AXWindow"), Some(false), Some(false)),
            (Some("AXWindow"), Some(true), None),
            (Some("AXWindow"), Some(true), Some(true)),
        ] {
            assert!(!can_skip_raise(
                42,
                Some(7),
                &focused,
                role,
                main,
                minimized
            ));
        }
    }
}
