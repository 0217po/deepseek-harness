//! Permission preflight reports current grants without opening system prompts.
pub mod panel;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGSessionCopyCurrentDictionary() -> core_foundation::dictionary::CFDictionaryRef;
}

pub fn accessibility() -> bool {
    unsafe { crate::ax::bindings::AXIsProcessTrusted() }
}
pub fn screen_recording() -> bool {
    unsafe { CGPreflightScreenCaptureAccess() }
}

fn lock_state(
    locked: Option<bool>,
    console: Option<bool>,
    logged_in: Option<bool>,
) -> Option<bool> {
    if locked == Some(true) {
        return Some(true);
    }
    (console == Some(true) && logged_in == Some(true)).then_some(false)
}

/// The screen-lock flag is absent in an unlocked, logged-in console session.
pub fn session_locked() -> Option<bool> {
    use core_foundation::{
        base::{CFGetTypeID, CFTypeRef, TCFType},
        boolean::CFBoolean,
        dictionary::CFDictionary,
        string::CFString,
    };
    unsafe {
        let value = CGSessionCopyCurrentDictionary();
        if value.is_null() {
            return None;
        }
        let dictionary: CFDictionary<CFTypeRef, CFTypeRef> =
            CFDictionary::wrap_under_create_rule(value);
        let flag = |key: &str| {
            let key = CFString::new(key);
            let value = *dictionary.find(key.as_CFTypeRef())?;
            (CFGetTypeID(value) == CFBoolean::type_id())
                .then(|| bool::from(CFBoolean::wrap_under_get_rule(value as _)))
        };
        lock_state(
            flag("CGSSessionScreenIsLocked"),
            flag("kCGSSessionOnConsoleKey"),
            flag("kCGSessionLoginDoneKey"),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::lock_state;

    #[test]
    fn locked_flag_takes_precedence_over_console_login() {
        assert_eq!(lock_state(Some(true), Some(true), Some(true)), Some(true));
        assert_eq!(lock_state(Some(false), Some(true), Some(true)), Some(false));
    }

    #[test]
    fn missing_lock_flag_requires_a_logged_in_console() {
        assert_eq!(lock_state(None, Some(true), Some(true)), Some(false));
        assert_eq!(lock_state(None, Some(false), Some(true)), None);
        assert_eq!(lock_state(None, Some(true), None), None);
        assert_eq!(lock_state(Some(false), Some(false), Some(true)), None);
        assert_eq!(lock_state(Some(false), Some(true), None), None);
    }
}
