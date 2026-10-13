//! Dream scheduler extension. The scheduler owner registers leases, schedules and budget here.

use crate::parity_schema_manifest::*;

pub struct UnavailableDreamScheduler;
pub static UNAVAILABLE: UnavailableDreamScheduler = UnavailableDreamScheduler;

impl DreamSchedulerStore for UnavailableDreamScheduler {
    fn availability(&self) -> Availability {
        unavailable("dream_scheduler")
    }

    fn claim(&self, _: &DreamClaimRequest) -> CapabilityResult<DreamLease> {
        CapabilityResult::unavailable("dream_scheduler")
    }

    fn heartbeat(&self, _: &DreamLease, _: i64) -> CapabilityResult<DreamLease> {
        CapabilityResult::unavailable("dream_scheduler")
    }

    fn finish(&self, _: &DreamFinishRequest) -> CapabilityResult<PublishReceipt> {
        CapabilityResult::unavailable("dream_scheduler")
    }
}
