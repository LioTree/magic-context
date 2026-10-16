//! Test-driver stage measurements for the synchronous resident hook path.
use std::{cell::RefCell, collections::BTreeMap, time::Instant};

thread_local! {
    static LAST: RefCell<BTreeMap<&'static str, f64>> = const { RefCell::new(BTreeMap::new()) };
}

pub(crate) struct Probe {
    since: Instant,
    stages: BTreeMap<&'static str, f64>,
}

impl Probe {
    pub(crate) fn new() -> Self {
        Self {
            since: Instant::now(),
            stages: BTreeMap::new(),
        }
    }
    pub(crate) fn stage(&mut self, name: &'static str) {
        let now = Instant::now();
        self.stages
            .insert(name, now.duration_since(self.since).as_secs_f64() * 1000.0);
        self.since = now;
    }

    pub(crate) fn value(&mut self, name: &'static str, value: f64) {
        self.stages.insert(name, value);
    }
}
impl Drop for Probe {
    fn drop(&mut self) {
        self.stage("finish");
        LAST.with(|last| last.replace(std::mem::take(&mut self.stages)));
    }
}

pub(crate) fn take() -> BTreeMap<&'static str, f64> {
    LAST.with(|last| std::mem::take(&mut *last.borrow_mut()))
}

#[test]
fn completed_probe_has_each_stage_and_is_drained_once() {
    take();
    let mut probe = Probe::new();
    probe.stage("resident_begin");
    drop(probe);
    let stages = take();
    assert!(stages.contains_key("resident_begin"));
    assert!(stages.contains_key("finish"));
    assert!(take().is_empty());
}
