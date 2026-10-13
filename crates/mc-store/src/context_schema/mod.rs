//! Context bootstrap extension. The schema owner registers bootstrap and fingerprints here.

use crate::parity_schema_manifest::*;

pub struct UnavailableContextSchema;
pub static UNAVAILABLE: UnavailableContextSchema = UnavailableContextSchema;

impl ContextSchemaStore for UnavailableContextSchema {
    fn availability(&self) -> Availability {
        unavailable("context_schema")
    }

    fn bootstrap(&self, _: &ContextSchemaRequest) -> CapabilityResult<ContextSchemaReport> {
        CapabilityResult::unavailable("context_schema")
    }
}
