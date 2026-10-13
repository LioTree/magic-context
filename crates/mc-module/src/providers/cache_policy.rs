//! Freeze whether Claude Code cache markers omit TTL, use the provider default,
//! or request a supported lifetime. Only the gateway knows actual dispatch and
//! response completion times, so it alone detects expiry and requests a rebuild.
use super::*;
use crate::config::CacheTtlProvenance;
pub(super) const REVISION: u64 = 1;

pub(super) fn resolve(
    binding: &SessionBinding,
    model: &str,
    preset: transform::compaction::Preset,
) -> Result<Value, HandlerOutcome> {
    let resolved = binding
        .config
        .resolve_cache_ttl_with_provenance(Some(model));
    let value = resolved.value.trim();
    let millis = if value.is_empty() {
        0
    } else {
        crate::scheduler::parse_cache_ttl(value)
            .map_err(|_| invalid_field("cache_policy", "invalid assumed cache lifetime"))?
    };
    let explicit = resolved.provenance == CacheTtlProvenance::Explicit;
    let subagent = preset == transform::compaction::Preset::Worker;
    let marker = if !explicit {
        json!({"intent":"absent"})
    } else if subagent {
        json!({"intent":"authored","ttl":"5m"})
    } else if millis == 0 {
        json!({"intent":"provider_default"})
    } else {
        json!({"intent":"authored","ttl":if millis == 300_000 { "5m" } else { "1h" }})
    };
    let assumed: String = if resolved.provenance == CacheTtlProvenance::Default {
        "1h".into()
    } else if value.eq_ignore_ascii_case("never") {
        "never".into()
    } else if subagent {
        "5m".into()
    } else if millis > 3_600_000 {
        "1h".into()
    } else {
        resolved.value
    };
    Ok(
        json!({"revision":REVISION,"marker_ttl":marker,"assumed_lifetime":assumed,
        "provenance":match resolved.provenance { CacheTtlProvenance::Default=>"default", CacheTtlProvenance::ConfiguredDefault=>"configured_default", CacheTtlProvenance::Explicit=>"explicit" },
        "expiry_owner":"runner"}),
    )
}

pub(super) fn head_slots(
    view: &transform::compaction::View,
    raw: &[String],
    preset: transform::compaction::Preset,
) -> Vec<Value> {
    if preset != transform::compaction::Preset::Head {
        return vec![];
    }
    view.replacement.iter().zip(raw).take(2).enumerate().filter(|(_, (message, _))| message.meta.synthetic)
        .map(|(index, (_, bytes))|json!({"index":index,"rank":if index==0 {2} else {1},"bytes_sha256":sha256_hex(bytes.as_bytes()),"byte_length":bytes.len()})).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn binding() -> SessionBinding {
        SessionBinding { connection_incarnation: 0, native_generation: None, principal: None, project_root: PathBuf::from("/fixture"),
        harness: "claude-code".into(),
        session: "cc".into(),
        model_key: None,
        config: McModuleConfig::default(),
        history_budget_tokens: 4000.0, }
    }
    #[test]
    fn marker_intents_preserve_absent_provider_default_and_authored() {
        let mut b = binding();
        let default = resolve(&b, "model", transform::compaction::Preset::Head).unwrap();
        assert_eq!(default["marker_ttl"], json!({"intent":"absent"}));
        assert_eq!(default["assumed_lifetime"], "1h");
        for (configured, intent, ttl, assumed) in [
            ("0", "provider_default", None, "0"),
            ("5m", "authored", Some("5m"), "5m"),
            ("90m", "authored", Some("1h"), "1h"),
            ("never", "authored", Some("1h"), "never"),
        ] {
            b.config
                .cache_ttl_by_model
                .insert("model".into(), configured.into());
            let policy = resolve(&b, "model", transform::compaction::Preset::Head).unwrap();
            assert_eq!(policy["marker_ttl"]["intent"], intent);
            assert_eq!(policy["marker_ttl"]["ttl"].as_str(), ttl);
            assert_eq!(policy["assumed_lifetime"], assumed);
            assert_eq!(policy["expiry_owner"], "runner");
        }
        b.config
            .cache_ttl_by_model
            .insert("model".into(), "bad".into());
        assert!(resolve(&b, "model", transform::compaction::Preset::Head).is_err());
        b.config.cache_ttl_by_model.clear();
        b.config.cache_ttl = "10m".into();
        b.config
            .cache_ttl_by_model
            .insert("default".into(), "10m".into());
        let configured = resolve(&b, "model", transform::compaction::Preset::Head).unwrap();
        assert_eq!(configured["marker_ttl"]["intent"], "absent");
        assert_eq!(configured["assumed_lifetime"], "10m");
    }
    #[test]
    fn head_identity_hashes_actual_raw_bytes_and_survives_delta_only_changes() {
        let mut view = transform::compaction::View {
            compaction_id: "v".into(),
            version: 1,
            range: transform::compaction::Range {
                lineage_id: "L".into(),
                from: 0,
                to: 2,
            },
            replacement: vec![
                ck_wire::CkWireMessage::synthetic_user_text("head"),
                ck_wire::CkWireMessage::synthetic_user_text("delta"),
            ],
        };
        let first = vec![
            r#"{ "role":"user","content":"head" }"#.into(),
            r#"{"role":"user","content":"delta"}"#.into(),
        ];
        let slots = head_slots(&view, &first, transform::compaction::Preset::Head);
        assert_eq!(slots[0]["bytes_sha256"], sha256_hex(first[0].as_bytes()));
        view.version = 2;
        let second = vec![
            first[0].clone(),
            r#"{"role":"user","content":"new delta"}"#.into(),
        ];
        let new = head_slots(&view, &second, transform::compaction::Preset::Head);
        assert_eq!(slots[0], new[0]);
        assert_ne!(slots[1], new[1]);
        let canonical = vec![
            r#"{"role":"user","content":"head"}"#.into(),
            first[1].clone(),
        ];
        assert_ne!(
            slots[0],
            head_slots(&view, &canonical, transform::compaction::Preset::Head)[0]
        );
    }
}
