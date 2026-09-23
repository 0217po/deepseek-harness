//! Run-loop support without upstream permission UI.
pub fn pump_run_loop_briefly(seconds: f64) {
    unsafe {
        core_foundation::runloop::CFRunLoopRunInMode(
            core_foundation::runloop::kCFRunLoopDefaultMode,
            seconds,
            false as u8,
        );
    }
}
