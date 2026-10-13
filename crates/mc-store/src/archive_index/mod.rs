//! Raw archive extension. The archive owner registers store, FTS and ordinal modules here.

use crate::parity_schema_manifest::*;

pub struct UnavailableRawArchive;
pub static UNAVAILABLE: UnavailableRawArchive = UnavailableRawArchive;

impl RawArchiveStore for UnavailableRawArchive {
    fn availability(&self) -> Availability {
        unavailable("raw_archive")
    }

    fn ingest(&self, _: &RawArchiveBatch) -> CapabilityResult<PublishReceipt> {
        CapabilityResult::unavailable("raw_archive")
    }

    fn read(&self, _: &RawReadRequest) -> CapabilityResult<Vec<RawMessage>> {
        CapabilityResult::unavailable("raw_archive")
    }

    fn search(&self, _: &ArchiveQuery) -> CapabilityResult<Vec<RawMessage>> {
        CapabilityResult::unavailable("raw_archive")
    }
}
