//! Native cache baselines keep only live measurements in the hashed section.
//! Covered measurements are recovered from immutable message facts at its cut.
//! The small-row marker deliberately uses a key that older readers reject.
use super::*;
use crate::provider_log::{ProviderEnginePolicy, ProviderError};

const FORMAT: &str = "mc_native_tail_v1";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct NativeReference {
    format: String,
    pub(super) cut_id: u64,
    pub(super) prefix_count: usize,
}

#[derive(Deserialize)]
pub(super) struct NativeBody {
    reference: NativeReference,
    baseline: TailHygieneBaseline,
}

#[derive(Deserialize)]
#[serde(untagged)]
pub(super) enum TailBody {
    Full(TailHygieneBaseline),
    Native(NativeBody),
}

impl TailBody {
    pub(super) fn into_baseline(
        self,
        reference: Option<&NativeReference>,
    ) -> Result<TailHygieneBaseline, CodecError> {
        match (self, reference) {
            (Self::Full(baseline), None) => Ok(baseline),
            (Self::Native(body), Some(reference)) if &body.reference == reference => {
                Ok(body.baseline)
            }
            _ => Err(CodecError::Serde(
                "native tail section and small-row marker disagree".into(),
            )),
        }
    }
}

pub(super) fn reference(json: &str) -> Result<Option<NativeReference>, CodecError> {
    let parsed = entries(json)?;
    let Some((_, raw)) = parsed.0.iter().find(|(key, _)| key == SECTION_TAIL) else {
        return Ok(None);
    };
    let value: serde_json::Value =
        serde_json::from_str(raw.get()).map_err(|error| CodecError::Serde(error.to_string()))?;
    if value.get("format").is_none() {
        return Err(CodecError::MovedKeyInSmallBlob { key: SECTION_TAIL });
    }
    let reference: NativeReference =
        serde_json::from_value(value).map_err(|error| CodecError::Serde(error.to_string()))?;
    if reference.format != FORMAT {
        return Err(CodecError::Serde(format!(
            "unsupported native tail format: {}",
            reference.format
        )));
    }
    Ok(Some(reference))
}

fn stamp(mut meta: String, reference: &NativeReference) -> Result<String, CodecError> {
    meta.pop();
    if meta.len() > 1 {
        meta.push(',');
    }
    meta.push_str(&format!("\"{SECTION_TAIL}\":"));
    meta.push_str(
        &serde_json::to_string(reference).map_err(|error| CodecError::Serde(error.to_string()))?,
    );
    meta.push('}');
    Ok(meta)
}

pub(crate) fn preserve_native_marker(meta: String, old: &str) -> Result<String, CodecError> {
    match reference(old)? {
        Some(reference) => stamp(meta, &reference),
        None => Ok(meta),
    }
}

/// The native provider handler alone enables `policy.native_tail_section`.
/// Its conversation must also be the namespace's sole owner. Other transform
/// callers keep the complete baseline vector and its existing JSON layout.
pub(crate) fn encode_native_row(
    conn: &rusqlite::Connection,
    namespace: &str,
    core: &CoreState,
    meta: &ModuleMeta,
    policy: &ProviderEnginePolicy,
) -> Result<Option<EncodedRow>, CodecError> {
    if !policy.native_tail_section {
        return Ok(None);
    }
    let Some(baseline) = &meta.tail_hygiene_baseline else {
        return Ok(None);
    };
    let owners: Vec<String> = conn.prepare_cached("SELECT c.conv_key FROM mc_provider_conversations_v2 c WHERE c.engine_namespace=?1 AND NOT EXISTS(SELECT 1 FROM mc_provider_conversations_v2 other WHERE other.engine_namespace=c.engine_namespace AND other.conv_key<>c.conv_key)")?
        .query_map([namespace], |row| row.get(0))?.collect::<rusqlite::Result<_>>()?;
    if owners.len() != 1 {
        return Ok(None);
    }
    let Some(cut_id) = crate::provider_policy_overlay::current_cut_tx(conn, &owners[0])? else {
        return Ok(None);
    };
    let live_prefix_count = policy
        .parts
        .iter()
        .take_while(|part| {
            meta.coverage_ordinal
                .is_some_and(|through| part.ordinal <= through)
        })
        .filter(|part| part.kind != "header")
        .count();
    if live_prefix_count > baseline.baseline_parts.len() {
        return Ok(None);
    }
    // coverage_ordinal is the last message summarized by the cached history.
    // The hygiene walk gives every covered part zero tokens and no tag, protection
    // or drop state. Only its key/hash remain; any other measurement values require
    // storing the complete baseline vector rather than replacing its prefix with facts.
    if baseline.baseline_parts[..live_prefix_count]
        .iter()
        .any(|part| {
            part.kind != crate::TailHygienePartKind::Excluded
                || part.tokens != 0
                || part.u_tokens != 0
                || part.tag_number.is_some()
                || part.tag_status.is_some()
                || part.protected
                || part.queued_for_drop
        })
    {
        return Ok(None);
    }
    let reference = NativeReference {
        format: FORMAT.into(),
        cut_id,
        prefix_count: live_prefix_count
            + policy
                .native_prefix
                .as_ref()
                .map_or(0, |prefix| prefix.parts),
    };
    #[derive(Serialize)]
    struct Body<'a> {
        reference: &'a NativeReference,
        baseline: RecordFields<'a, TailHygieneBaseline>,
    }
    let body = serde_json::to_string(&Body {
        reference: &reference,
        baseline: RecordFields {
            value: baseline,
            omit: &[],
            baseline_parts: Some(&baseline.baseline_parts[live_prefix_count..]),
        },
    })
    .map_err(|error| CodecError::Serde(error.to_string()))?;
    let mut encoded = encode_row_parts(core, meta, Some(super::encoded(body)))?;
    encoded.meta_json = stamp(encoded.meta_json, &reference)?;
    Ok(Some(encoded))
}

pub(super) fn hydrate(
    conn: &rusqlite::Connection,
    namespace: &str,
    reference: &NativeReference,
    decoded: &mut DecodedRow,
) -> Result<(), CodecError> {
    if decoded.sections.tail.discard_reason().is_some() {
        return Ok(());
    }
    let Some(mut baseline) = decoded.meta.tail_hygiene_baseline.take() else {
        return Err(CodecError::Serde("native tail baseline is missing".into()));
    };
    let owners: Vec<String> = conn.prepare_cached("SELECT c.conv_key FROM mc_provider_conversations_v2 c WHERE c.engine_namespace=?1 AND NOT EXISTS(SELECT 1 FROM mc_provider_conversations_v2 other WHERE other.engine_namespace=c.engine_namespace AND other.conv_key<>c.conv_key)")?
        .query_map([namespace], |row| row.get(0))?.collect::<rusqlite::Result<_>>()?;
    if owners.len() != 1 {
        return Err(CodecError::Serde(
            "native tail owner is missing or ambiguous".into(),
        ));
    }
    let parts =
        crate::provider_policy_overlay::baseline_prefix_tx(conn, &owners[0], reference.cut_id)
            .map_err(|error: ProviderError| CodecError::Serde(error.to_string()))?;
    if parts.len() != reference.prefix_count {
        return Err(CodecError::Serde(
            "native tail prefix source count mismatch".into(),
        ));
    }
    let mut complete = parts;
    complete.append(&mut baseline.baseline_parts);
    baseline.baseline_parts = complete;
    decoded.meta.tail_hygiene_baseline = Some(baseline);
    Ok(())
}
