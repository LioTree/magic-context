//! Retrieval extension. Provider clients implement EmbeddingProvider; lanes implement RetrievalLane.
//!
//! These adapters describe future parity services only. They are not substituted for the
//! existing literal-search backend, which remains on its original path.

use crate::parity_contract::*;

pub struct UnavailableLane {
    pub source: RetrievalSource,
}

impl RetrievalLane for UnavailableLane {
    fn source(&self) -> RetrievalSource {
        self.source
    }

    fn availability(&self) -> Availability {
        mc_store::parity_schema_manifest::unavailable("retrieval_lane")
    }

    fn retrieve<'a>(
        &'a self,
        _: &'a RequestContext,
        _: &'a RetrievalRequest,
    ) -> CallbackFuture<'a, Vec<RetrievalHit>> {
        Box::pin(async { CapabilityResult::unavailable("retrieval_lane") })
    }
}

pub static UNAVAILABLE_LANES: [UnavailableLane; 6] = [
    UnavailableLane {
        source: RetrievalSource::Memory,
    },
    UnavailableLane {
        source: RetrievalSource::RawMessage,
    },
    UnavailableLane {
        source: RetrievalSource::Compartment,
    },
    UnavailableLane {
        source: RetrievalSource::GitCommit,
    },
    UnavailableLane {
        source: RetrievalSource::Primer,
    },
    UnavailableLane {
        source: RetrievalSource::Note,
    },
];

pub struct UnavailableEmbeddingProvider;
pub static UNAVAILABLE_EMBEDDING: UnavailableEmbeddingProvider = UnavailableEmbeddingProvider;

impl EmbeddingProvider for UnavailableEmbeddingProvider {
    fn availability(&self) -> Availability {
        mc_store::parity_schema_manifest::unavailable("embedding_provider")
    }

    fn embed<'a>(
        &'a self,
        _: &'a RequestContext,
        _: &'a EmbeddingRequest,
    ) -> CallbackFuture<'a, EmbeddingResult> {
        Box::pin(async { CapabilityResult::unavailable("embedding_provider") })
    }
}
