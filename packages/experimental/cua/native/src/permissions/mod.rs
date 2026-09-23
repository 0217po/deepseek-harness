//! Permission preflight reports current grants without opening system prompts.
pub mod panel;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
}

pub fn accessibility() -> bool {
    unsafe { crate::ax::bindings::AXIsProcessTrusted() }
}
pub fn screen_recording() -> bool {
    unsafe { CGPreflightScreenCaptureAccess() }
}
