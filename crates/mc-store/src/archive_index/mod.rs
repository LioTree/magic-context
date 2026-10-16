//! Raw archive extension. The archive owner registers store, FTS and ordinal modules here.

use crate::parity_schema_manifest::*;

// Expose message lookup, bounded range recovery and FTS search, but not ingestion.
#[allow(dead_code)]
mod fts;
#[allow(dead_code)]
mod ordinals;
#[allow(dead_code)]
mod store;

pub use fts::{search, FtsRow};
pub use store::{read_by_id, read_range, RawMessage as ArchivedMessage};

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
