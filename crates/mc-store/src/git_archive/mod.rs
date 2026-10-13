//! Git archive extension. The git owner registers index and FTS modules here.

pub mod fts;
pub mod index;

use crate::parity_schema_manifest::*;

pub struct UnavailableGitArchive;
pub static UNAVAILABLE: UnavailableGitArchive = UnavailableGitArchive;

impl GitArchiveStore for UnavailableGitArchive {
    fn availability(&self) -> Availability {
        unavailable("git_archive")
    }

    fn ingest(&self, _: &GitIngestRequest) -> CapabilityResult<PublishReceipt> {
        CapabilityResult::unavailable("git_archive")
    }

    fn search(&self, _: &ArchiveQuery) -> CapabilityResult<Vec<GitCommitRecord>> {
        CapabilityResult::unavailable("git_archive")
    }
}
