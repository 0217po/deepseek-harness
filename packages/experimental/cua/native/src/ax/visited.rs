//! Retained AX identities prevent cycles and repeated proxy subtrees during one observation.
use super::bindings::AXUIElementRef;
use core_foundation::base::{CFEqual, CFHash, CFRelease, CFRetain, CFTypeRef};
use std::collections::HashMap;

#[derive(Default)]
pub struct VisitedElements {
    buckets: HashMap<usize, Vec<AXUIElementRef>>,
}

impl VisitedElements {
    pub unsafe fn insert(&mut self, element: AXUIElementRef) -> bool {
        let bucket = self
            .buckets
            .entry(CFHash(element as CFTypeRef) as usize)
            .or_default();
        if bucket
            .iter()
            .any(|other| CFEqual(*other as CFTypeRef, element as CFTypeRef) != 0)
        {
            return false;
        }
        CFRetain(element as CFTypeRef);
        bucket.push(element);
        true
    }
}

impl Drop for VisitedElements {
    fn drop(&mut self) {
        for element in self.buckets.values().flatten() {
            unsafe { CFRelease(*element as CFTypeRef) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ax::bindings::AXUIElementCreateApplication;

    #[test]
    fn duplicate_proxies_for_one_application_are_visited_once() {
        unsafe {
            let pid = std::process::id() as i32;
            let first = AXUIElementCreateApplication(pid);
            let same = AXUIElementCreateApplication(pid);
            let other = AXUIElementCreateApplication(pid + 1);
            let mut visited = VisitedElements::default();
            assert!(visited.insert(first));
            assert!(!visited.insert(first));
            assert!(!visited.insert(same));
            assert!(visited.insert(other));
            for element in [first, same, other] {
                CFRelease(element as CFTypeRef);
            }
        }
    }
}
