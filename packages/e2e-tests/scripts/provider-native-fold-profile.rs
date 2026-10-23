//! Allocation/CPU probe included only in the generated timing-driver workspace.
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicU64, Ordering::Relaxed};
use std::time::Instant;

struct CountingAllocator;
static CALLS: AtomicU64 = AtomicU64::new(0);
static BYTES: AtomicU64 = AtomicU64::new(0);

pub fn allocated_bytes() -> u64 {
    BYTES.load(Relaxed)
}

unsafe impl GlobalAlloc for CountingAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        CALLS.fetch_add(1, Relaxed);
        BYTES.fetch_add(layout.size() as u64, Relaxed);
        unsafe { System.alloc(layout) }
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) }
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        CALLS.fetch_add(1, Relaxed);
        BYTES.fetch_add(size as u64, Relaxed);
        unsafe { System.realloc(ptr, layout, size) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        CALLS.fetch_add(1, Relaxed);
        BYTES.fetch_add(layout.size() as u64, Relaxed);
        unsafe { System.alloc_zeroed(layout) }
    }
}

#[global_allocator]
static ALLOCATOR: CountingAllocator = CountingAllocator;

pub struct Probe {
    wall: Instant,
    cpu: cpu_time::ProcessTime,
    calls: u64,
    bytes: u64,
    enabled: bool,
}
impl Probe {
    pub fn new(enabled: bool) -> Self {
        Self {
            wall: Instant::now(),
            cpu: cpu_time::ProcessTime::now(),
            calls: CALLS.load(Relaxed),
            bytes: BYTES.load(Relaxed),
            enabled,
        }
    }
    pub fn phase(&mut self, phase: &str) {
        let calls = CALLS.load(Relaxed);
        let bytes = BYTES.load(Relaxed);
        if self.enabled {
            eprintln!("NATIVE_FOLD_PROFILE phase={phase} wall_ms={:.3} cpu_ms={:.3} alloc_calls={} alloc_bytes={}",
                self.wall.elapsed().as_secs_f64() * 1000.0,
                self.cpu.elapsed().as_secs_f64() * 1000.0,
                calls - self.calls, bytes - self.bytes);
        }
        self.wall = Instant::now();
        self.cpu = cpu_time::ProcessTime::now();
        self.calls = CALLS.load(Relaxed);
        self.bytes = BYTES.load(Relaxed);
    }
}
