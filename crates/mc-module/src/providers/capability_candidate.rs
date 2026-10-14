//! Pins the profile, provider generations, and wire limits for Claude Code attachment.
//! The bundle is published only by an explicit default-off feature so releases do not
//! claim support for this lane.
use super::*;
use hooks::claude_code::{ClaudeCodeCapabilities, PayloadCaps};
use std::sync::LazyLock;

pub(super) static CANDIDATE: LazyLock<ClaudeCodeCapabilities> = LazyLock::new(build_candidate);

fn locked_package(name: &str) -> String {
    let lock = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../Cargo.lock"));
    let mut matches = lock.split("[[package]]").filter(|block| {
        block
            .lines()
            .any(|line| line == format!("name = \"{name}\""))
    });
    let block = matches.next().expect("capability dependency in Cargo.lock");
    assert!(matches.next().is_none(), "ambiguous capability dependency");
    let value = |field: &str| {
        block
            .lines()
            .find_map(|line| {
                line.strip_prefix(&format!("{field} = \""))
                    .and_then(|v| v.strip_suffix('"'))
            })
            .expect("locked package field")
            .to_owned()
    };
    assert_eq!(
        value("source"),
        "registry+https://github.com/rust-lang/crates.io-index"
    );
    value("version")
}

fn build_candidate() -> ClaudeCodeCapabilities {
    let compaction_version = locked_package("cortexkit-role-compaction-provider");
    let transform_version = locked_package("cortexkit-role-step-transform-provider");
    // Both registry releases were published from the commons source revision below.
    // Cargo.lock records registry checksums rather than the publication's Git SHA.
    let revision = "563e0984e2765710672220bbfecfb46a3b7f56c7".to_owned();
    assert_eq!(compaction_version, "0.2.2");
    assert_eq!(transform_version, "0.2.1");
    // The format fingerprints also select native conversation/message/view keys.
    // Legacy keys omit generations and retain their previous bytes and namespaces.
    let profile_generation = format!(
        "codec-sha256:{}",
        sha256_hex(include_bytes!("codec_claude_code.rs"))
    );
    let provider_generation = format!(
        "key-sha256:{}",
        sha256_hex(
            &serde_jcs::to_vec(&json!({
                "identity":sha256_hex(include_bytes!("records.rs")),
                "plan":sha256_hex(include_bytes!("native_plan.rs")),
                "view":sha256_hex(include_bytes!("native_view.rs")),
                "cut":sha256_hex(include_bytes!("native_cut.rs")),
                "reductions":sha256_hex(include_bytes!("native_reductions.rs")),
            }))
            .expect("native format fingerprints")
        )
    );
    ClaudeCodeCapabilities {
        capability: hooks::claude_code::CAPABILITY.into(),
        principal: format!("reserved:{CLAUDE_CODE_MODULE}"),
        harness: CLAUDE_CODE_HARNESS.into(),
        profile: codec::Codec::ClaudeCodeAnthropic
            .serializer_profile()
            .wire_id()
            .into(),
        profile_generation,
        provider_generation,
        observation: "answer".into(),
        commons_revision: revision,
        wire_majors: BTreeMap::from([
            (
                "compaction-provider".into(),
                compact::PROVIDES.rsplit('/').next().unwrap().into(),
            ),
            (
                "step-transform-provider".into(),
                hooks::PROVIDES.rsplit('/').next().unwrap().into(),
            ),
        ]),
        package_versions: BTreeMap::from([
            ("compaction-provider".into(), compaction_version),
            ("step-transform-provider".into(), transform_version),
        ]),
        epochs: BTreeMap::from([
            ("codec".into(), codec_claude_code::CODEC_FORMAT_EPOCH),
            (
                "raw_provenance".into(),
                codec_claude_code::RAW_PROVENANCE_FORMAT_EPOCH,
            ),
            (
                "render".into(),
                crate::PROFILE_EPOCH_CLAUDE_CODE_ANTHROPIC as u64,
            ),
            ("tagger".into(), crate::TAGGER_FEATURE_EPOCH as u64),
            ("memory".into(), crate::MEMORY_RENDER_FORMAT_EPOCH as u64),
            (
                "compartment".into(),
                crate::COMPARTMENT_RENDER_FORMAT_EPOCH as u64,
            ),
        ]),
        exact_endpoint: "native_top_level_inclusive".into(),
        partial_message_cut: false,
        caps: PayloadCaps {
            ingress_envelope_bytes: HOST_ENVELOPE_BYTES,
            hook_envelope_bytes: HOST_ENVELOPE_BYTES,
            // A message plus its raw sidecar is smaller than the whole RPC that
            // contains it. Admission now checks this per-message bound explicitly.
            single_message_bytes: HOST_ENVELOPE_BYTES - 1,
            // Page serialization shrinks this raw-byte allowance until the
            // escaped reply, including its metadata, is strictly below the cap.
            view_page_bytes: HOST_ENVELOPE_BYTES - 1,
        },
        raw_view_read: true,
        digest: "sha256".into(),
        cache_policy_revision: cache_policy::REVISION.to_string(),
        canonical_reduce: false,
        guidance: false,
        notice_dispatch_ack: false,
        bootstrap_complete: false,
        capabilities: vec![],
    }
}

#[cfg(test)]
fn canonical_bytes() -> Vec<u8> {
    serde_jcs::to_vec(&*CANDIDATE).expect("candidate canonical JSON")
}

#[cfg(test)]
fn discovery_candidate(binding: &SessionBinding) -> Result<Value, HandlerOutcome> {
    if !attested_claude_code(binding) {
        return Err(invalid_field(
            "claude_code",
            "candidate discovery requires the attested Claude Code route",
        ));
    }
    let HandlerOutcome::Response(bytes) = describe() else {
        return Err(invalid("discovery unavailable"));
    };
    let mut reply: Value = serde_json::from_slice(&bytes).map_err(invalid)?;
    reply["claude_code"] = serde_json::to_value(&*CANDIDATE).map_err(invalid)?;
    Ok(reply)
}

#[cfg(test)]
fn declaration_candidate(
    binding: &SessionBinding,
    params: &Value,
) -> Result<hooks::subscription::Declaration, HandlerOutcome> {
    let request: hooks::subscription::DeclareRequest = decode(params)?;
    if !attested_claude_code(binding)
        || request.claude_code.as_ref() != Some(&*CANDIDATE)
        || !answer_observation(&Value::Object(request.params.clone()))
        || request
            .params
            .get("serializer_profile")
            .and_then(Value::as_str)
            != Some(CANDIDATE.profile.as_str())
    {
        return Err(invalid_field(
            "claude_code",
            "candidate declaration requires attestation and the exact supported selection",
        ));
    }
    let mut reply = declaration(params)?;
    reply.claude_code = Some(CANDIDATE.clone());
    Ok(reply)
}

#[test]
#[cfg(not(feature = "advertise-claude-code-candidate"))]
fn candidate_bundle_bytes_are_pinned_and_not_advertised() {
    let expected = include_bytes!("../../testdata/codec/claude-code-capability-candidate.json");
    assert_eq!(
        canonical_bytes(),
        expected.strip_suffix(b"\n").unwrap_or(expected)
    );
    assert_eq!(
        CANDIDATE.validate(),
        Ok(()),
        "shape validation is not implementation readiness"
    );
    let HandlerOutcome::Response(discovery) = describe_for_discovery() else {
        panic!("discovery response")
    };
    let discovery: Value = serde_json::from_slice(&discovery).unwrap();
    assert!(
        discovery.get("claude_code").is_none(),
        "candidate must not be advertised"
    );
    let declaration = declaration(
        &json!({"params":{"serializer_profile":"claude-code-anthropic","observation":"answer"}}),
    )
    .unwrap();
    assert!(
        declaration.claude_code.is_none(),
        "candidate must not activate a plan"
    );
}

#[test]
#[cfg(feature = "advertise-claude-code-candidate")]
fn candidate_bundle_is_advertised_and_echoed_as_the_pinned_bytes() {
    let expected = include_bytes!("../../testdata/codec/claude-code-capability-candidate.json");
    let expected = expected.strip_suffix(b"\n").unwrap_or(expected);
    assert_eq!(canonical_bytes(), expected);

    let HandlerOutcome::Response(discovery) = describe_for_discovery() else {
        panic!("discovery response")
    };
    let discovery: Value = serde_json::from_slice(&discovery).unwrap();
    assert_eq!(
        serde_jcs::to_vec(&discovery["claude_code"]).unwrap(),
        expected
    );

    let declaration = declaration(&json!({
        "params": {
            "serializer_profile": CANDIDATE.profile,
            "observation": "answer"
        },
        "claude_code": &*CANDIDATE
    }))
    .unwrap();
    assert_eq!(
        serde_jcs::to_vec(declaration.claude_code.as_ref().unwrap()).unwrap(),
        expected
    );
}

#[test]
fn candidate_discovery_and_declaration_echo_identical_frozen_bytes() {
    let binding = super::claude_code_tests::binding(
        Path::new("/fixture"),
        super::claude_code_tests::thalamus(),
    );
    let discovery = discovery_candidate(&binding).unwrap();
    let params = json!({"params":{"serializer_profile":CANDIDATE.profile,"observation":"answer"},"claude_code":&*CANDIDATE});
    let declared = declaration_candidate(&binding, &params).unwrap();
    assert_eq!(
        serde_jcs::to_vec(&discovery["claude_code"]).unwrap(),
        canonical_bytes()
    );
    assert_eq!(
        serde_jcs::to_vec(&declared.claude_code.unwrap()).unwrap(),
        canonical_bytes()
    );
    let mut drift = params.clone();
    drift["claude_code"]["epochs"]["codec"] = json!(999);
    assert!(declaration_candidate(&binding, &drift).is_err());
    let mut direct = binding;
    direct.principal = None;
    assert!(discovery_candidate(&direct).is_err());
    assert!(declaration_candidate(&direct, &params).is_err());
}

#[tokio::test]
#[cfg(not(feature = "advertise-claude-code-candidate"))]
async fn live_capability_selection_is_named_refusal_while_publication_is_held() {
    let dir = tempfile::tempdir().unwrap();
    let h = super::claude_code_tests::handler(dir.path(), super::claude_code_tests::thalamus());
    for method in [
        "transform.declare",
        "compaction.setup",
        "compaction.step",
        "transform.hook",
    ] {
        let result=super::claude_code_tests::call(&h,method,json!({"params":{"serializer_profile":CANDIDATE.profile,"observation":"answer"},"claude_code":&*CANDIDATE})).await;
        assert!(
            matches!(result,HandlerOutcome::ErrorWithDetail { code,detail,.. } if code=="invalid_params" && detail["field"]=="claude_code"),
            "{method}"
        );
    }
}

#[tokio::test]
#[cfg(feature = "advertise-claude-code-candidate")]
async fn live_capability_selection_is_accepted_when_candidate_is_advertised() {
    let dir = tempfile::tempdir().unwrap();
    let h = super::claude_code_tests::handler(dir.path(), super::claude_code_tests::thalamus());
    let result = super::claude_code_tests::call(
        &h,
        "transform.declare",
        json!({
            "params": {
                "serializer_profile": CANDIDATE.profile,
                "observation": "answer"
            },
            "claude_code": &*CANDIDATE
        }),
    )
    .await;
    let HandlerOutcome::Response(bytes) = result else {
        panic!("advertised capability selection was refused: {result:?}");
    };
    let declaration: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        serde_jcs::to_vec(&declaration["claude_code"]).unwrap(),
        canonical_bytes()
    );
}

#[test]
#[ignore = "explicit candidate export; never regenerates the pinned fixture"]
fn print_candidate_bundle() {
    let bytes = canonical_bytes();
    println!(
        "CC_CANDIDATE_JSON={}",
        String::from_utf8(bytes.clone()).unwrap()
    );
    println!("CC_CANDIDATE_SHA256={}", sha256_hex(&bytes));
}
