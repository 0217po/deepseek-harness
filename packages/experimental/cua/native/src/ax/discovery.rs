//! Checked window discovery preserves AX errors before an unresolved window is accepted.
use super::bindings::*;
use super::window_scope::TopLevelCandidate;
use core_foundation::{
    array::CFArray,
    base::{CFEqual, CFGetTypeID, CFRelease, CFRetain, CFType, CFTypeRef, TCFType},
    string::CFString,
};

// Defined by the macOS AXError header; applications without AX may return this.
const AX_NOT_IMPLEMENTED: AXError = -25208;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DiscoveryError {
    pub operation: &'static str,
    pub code: Option<AXError>,
}
impl DiscoveryError {
    pub fn is_permission_denied(&self) -> bool {
        self.code == Some(kAXErrorAPIDisabled)
    }
}
impl std::fmt::Display for DiscoveryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.code {
            Some(code) => write!(
                f,
                "Accessibility discovery {} failed with AX error {code}",
                self.operation
            ),
            None => write!(
                f,
                "Accessibility discovery {} returned an invalid value",
                self.operation
            ),
        }
    }
}

fn present(code: AXError, operation: &'static str) -> Result<bool, DiscoveryError> {
    match code {
        kAXErrorSuccess => Ok(true),
        kAXErrorAttributeUnsupported | kAXErrorNoValue | AX_NOT_IMPLEMENTED => Ok(false),
        _ => Err(DiscoveryError {
            operation,
            code: Some(code),
        }),
    }
}
fn invalid(operation: &'static str) -> DiscoveryError {
    DiscoveryError {
        operation,
        code: None,
    }
}

pub struct OwnedElement(AXUIElementRef);
impl OwnedElement {
    pub fn pointer(&self) -> AXUIElementRef {
        self.0
    }
}
impl Drop for OwnedElement {
    fn drop(&mut self) {
        unsafe { CFRelease(self.0 as CFTypeRef) };
    }
}

pub struct Discovery {
    pub application: OwnedElement,
    pub roots: Vec<OwnedElement>,
    pub candidates: Vec<TopLevelCandidate>,
}

unsafe fn attribute(
    element: AXUIElementRef,
    name: &'static str,
) -> Result<Option<CFType>, DiscoveryError> {
    let key = CFString::new(name);
    let mut raw = std::ptr::null();
    let status = AXUIElementCopyAttributeValue(element, key.as_concrete_TypeRef(), &mut raw);
    let value = (!raw.is_null()).then(|| CFType::wrap_under_create_rule(raw));
    if !present(status, name)? {
        return Ok(None);
    }
    value.map(Some).ok_or_else(|| invalid(name))
}
unsafe fn elements(
    element: AXUIElementRef,
    name: &'static str,
) -> Result<Vec<OwnedElement>, DiscoveryError> {
    let Some(value) = attribute(element, name)? else {
        return Ok(Vec::new());
    };
    if CFGetTypeID(value.as_CFTypeRef()) != CFArray::<CFTypeRef>::type_id() {
        return Err(invalid(name));
    }
    let array = CFArray::<CFTypeRef>::wrap_under_get_rule(value.as_CFTypeRef() as _);
    let mut result = Vec::new();
    for index in 0..array.len() {
        let pointer = *array.get(index).ok_or_else(|| invalid(name))?;
        if CFGetTypeID(pointer) != AXUIElementGetTypeID() {
            return Err(invalid(name));
        }
        CFRetain(pointer);
        result.push(OwnedElement(pointer as AXUIElementRef));
    }
    Ok(result)
}
unsafe fn element(
    element: AXUIElementRef,
    name: &'static str,
) -> Result<Option<OwnedElement>, DiscoveryError> {
    let Some(value) = attribute(element, name)? else {
        return Ok(None);
    };
    let pointer = value.as_CFTypeRef();
    if CFGetTypeID(pointer) != AXUIElementGetTypeID() {
        return Err(invalid(name));
    }
    CFRetain(pointer);
    Ok(Some(OwnedElement(pointer as AXUIElementRef)))
}
unsafe fn string(
    element: AXUIElementRef,
    name: &'static str,
) -> Result<Option<String>, DiscoveryError> {
    let Some(value) = attribute(element, name)? else {
        return Ok(None);
    };
    if CFGetTypeID(value.as_CFTypeRef()) != CFString::type_id() {
        return Err(invalid(name));
    }
    Ok(Some(
        CFString::wrap_under_get_rule(value.as_CFTypeRef() as _).to_string(),
    ))
}
unsafe fn window_id(element: AXUIElementRef) -> Result<Option<u32>, DiscoveryError> {
    let mut id = 0;
    if !present(
        _AXUIElementGetWindow(element, &mut id),
        "_AXUIElementGetWindow",
    )? {
        return Ok(None);
    }
    Ok((id != 0).then_some(id))
}
unsafe fn push_unique(roots: &mut Vec<OwnedElement>, element: OwnedElement) {
    if !roots
        .iter()
        .any(|other| CFEqual(other.0 as CFTypeRef, element.0 as CFTypeRef) != 0)
    {
        roots.push(element);
    }
}

/// Own all retained discovery elements, including on an attribute-read failure.
///
/// # Safety
/// Requires the macOS AX APIs and a thread with a CF run loop.
pub unsafe fn discover(
    pid: i32,
    scoped: bool,
    max_elements: usize,
    timeout: f32,
) -> Result<Discovery, DiscoveryError> {
    let pointer = AXUIElementCreateApplication(pid);
    if pointer.is_null() {
        return Err(DiscoveryError {
            operation: "AXUIElementCreateApplication",
            code: Some(kAXErrorFailure),
        });
    }
    let application = OwnedElement(pointer);
    AXUIElementSetMessagingTimeout(pointer, timeout);
    super::enablement::ensure_chromium_ax_enabled(pid, pointer);
    let mut roots = elements(pointer, "AXChildren")?;
    for element in elements(pointer, "AXWindows")? {
        push_unique(&mut roots, element);
    }
    if let Some(element) = element(pointer, "AXFocusedWindow")? {
        push_unique(&mut roots, element);
    }
    let mut cursor = 0;
    while cursor < roots.len() && cursor < max_elements {
        let parent = roots[cursor].pointer();
        cursor += 1;
        AXUIElementSetMessagingTimeout(parent, timeout);
        if !matches!(
            string(parent, "AXRole")?.as_deref(),
            Some("AXWindow" | "AXSheet")
        ) {
            continue;
        }
        for child in elements(parent, "AXChildren")? {
            AXUIElementSetMessagingTimeout(child.pointer(), timeout);
            if roots.len() < max_elements
                && string(child.pointer(), "AXRole")?.as_deref() == Some("AXSheet")
            {
                push_unique(&mut roots, child);
            }
        }
    }
    let mut candidates = Vec::new();
    for root in roots.iter().filter(|_| scoped) {
        let pointer = root.pointer();
        AXUIElementSetMessagingTimeout(pointer, timeout);
        let role = string(pointer, "AXRole")?.unwrap_or_default();
        let ax_window_id = if matches!(role.as_str(), "AXWindow" | "AXSheet") {
            window_id(pointer)?
        } else {
            None
        };
        candidates.push(TopLevelCandidate {
            role,
            ax_window_id,
            subrole: string(pointer, "AXSubrole")?,
            identifier: string(pointer, "AXIdentifier")?,
        });
    }
    Ok(Discovery {
        application,
        roots,
        candidates,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn optional_attribute_absence_differs_from_permission_and_transport_failure() {
        for code in [
            kAXErrorAttributeUnsupported,
            kAXErrorNoValue,
            AX_NOT_IMPLEMENTED,
        ] {
            assert_eq!(present(code, "AXWindows"), Ok(false));
        }
        assert_eq!(present(kAXErrorSuccess, "AXWindows"), Ok(true));
        let denied = present(kAXErrorAPIDisabled, "AXWindows").unwrap_err();
        assert!(denied.is_permission_denied());
        for code in [-25204, kAXErrorInvalidUIElement, kAXErrorFailure] {
            let failure = present(code, "AXWindows").unwrap_err();
            assert_eq!(failure.code, Some(code));
            assert!(!failure.is_permission_denied());
        }
    }
}
