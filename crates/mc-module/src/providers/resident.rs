//! Offline resident-state builder. It is compiled only in test executables and
//! has no provider route, checkpoint publication, or serving consumer.
use super::codec::Codec;
use super::*;
use mc_store::{ProviderResidentAuthority, StoredCompartment};
use sha2::{Digest, Sha256};
use std::mem::size_of;

#[derive(Clone, Copy)]
struct Slice {
    start: usize,
    len: usize,
}
#[derive(Clone, Copy)]
struct Part {
    block: Slice,
    value: Slice,
    ordinal: u64,
    index: i64,
}
#[derive(Clone, Copy)]
struct Tail {
    ordinal: u64,
    mid: Slice,
    native: Slice,
    ck: Slice,
}
#[derive(Clone, Copy)]
struct Fragment {
    key: Slice,
    text: Slice,
    tokens: usize,
}

/// An owned arena makes retained capacities explicit. Sorted integer indexes
/// refer into the arena instead of owning another copy of every policy string.
pub(crate) struct ResidentState {
    arena: Vec<u8>,
    header: Slice,
    domains: Slice,
    parts: Vec<Part>,
    by_block: Vec<usize>,
    by_tag: Vec<(i64, usize)>,
    raw_prefix_tokens: Vec<(i64, i64)>,
    tail: Vec<Tail>,
    fragments: Vec<Fragment>,
}
impl ResidentState {
    pub(crate) fn build(
        authority: &ProviderResidentAuthority,
        domains: &Value,
        compartments: &[StoredCompartment],
        importance: &BTreeMap<i64, i32>,
        render_identity: &str,
        tokenizer_identity: &str,
        cap: usize,
    ) -> Result<Self, String> {
        let empty = Slice { start: 0, len: 0 };
        let mut state = Self {
            arena: Vec::new(),
            header: empty,
            domains: empty,
            parts: Vec::new(),
            by_block: Vec::new(),
            by_tag: Vec::new(),
            raw_prefix_tokens: Vec::new(),
            tail: Vec::new(),
            fragments: Vec::new(),
        };
        let header = json!({"conversation_key":authority.conversation_key,"runtime_store_instance":authority.store_instance,
            "conversation":authority.conversation,"policy_revision":authority.policy_revision,
            "ancestry":authority.ancestry,"coverage":authority.coverage,
            "render_identity":render_identity,"tokenizer_identity":tokenizer_identity});
        state.header = state.json(&header, cap)?;
        state.domains = state.json(domains, cap)?;
        for part in &authority.parts {
            let block = state.push(part.block_id.as_bytes(), cap)?;
            let value = state.json(part, cap)?;
            state.parts.push(Part {
                block,
                value,
                ordinal: part.ordinal,
                index: part.block_index,
            });
            if let Some(tag) = part.tag_number {
                state.by_tag.push((tag, state.parts.len() - 1));
            }
            let (tokens, user) = state
                .raw_prefix_tokens
                .last()
                .copied()
                .unwrap_or((0i64, 0i64));
            state.raw_prefix_tokens.push((
                tokens
                    .checked_add(part.measurement.tokens)
                    .ok_or("resident raw token prefix overflow")?,
                user.checked_add(part.measurement.u_tokens)
                    .ok_or("resident raw user prefix overflow")?,
            ));
        }
        state.by_tag.sort_unstable();
        state.by_block = (0..state.parts.len()).collect();
        let arena = &state.arena;
        let parts = &state.parts;
        let block = |index: usize| {
            let slice = parts[index].block;
            &arena[slice.start..slice.start + slice.len]
        };
        state.by_block.sort_by(|&a, &b| block(a).cmp(block(b)));
        for message in &authority.tail {
            let native: Value =
                serde_json::from_slice(&message.message_bytes).map_err(|e| e.to_string())?;
            let entry = compact::status::StatusMessage {
                ordinal: message.ordinal,
                mid: message.mid.clone(),
                message: native,
                raw_message: None,
            };
            let codec = Codec::from_params(&serde_json::from_str::<Value>(&authority.conversation.params_json).map_err(|e| e.to_string())?)
                .map_err(|e| format!("resident codec: {e:?}"))?;
            let ck = codec
                .decode_message(&entry)
                .map_err(|e| format!("resident native decode: {e:?}"))?;
            let mid = state.push(message.mid.as_bytes(), cap)?;
            let native = state.push(&message.message_bytes, cap)?;
            let ck = state.json(&ck, cap)?;
            state.tail.push(Tail {
                ordinal: message.ordinal,
                mid,
                native,
                ck,
            });
        }
        for compartment in compartments {
            for temporal in [false, true] {
                let mut rendered = crate::decay_render::DecayRenderCompartment::from(compartment);
                if let Some(score) = importance.get(&compartment.sequence) {
                    rendered.importance = Some(*score);
                }
                if !temporal {
                    rendered.start_date = None;
                    rendered.end_date = None;
                }
                for tier in 1..=5 {
                    // The full source tuple is retained alongside the locator,
                    // including null tiers, dates and selected score. Hash equality
                    // alone is never input equality, even in this offline builder.
                    let key = json!({"source":compartment,"selected_importance":rendered.importance,
                        "temporal":temporal,"tier":tier,"renderer":render_identity,"tokenizer":tokenizer_identity});
                    let text = crate::decay_render::render_compartment_at_tier(&rendered, tier);
                    let tokens = mc_tokenizer::estimate_tokens(&text);
                    let key = state.json(&key, cap)?;
                    let text = state.push(text.as_bytes(), cap)?;
                    state.fragments.push(Fragment { key, text, tokens });
                }
            }
        }
        if state.retained_bytes() > cap {
            return Err("resident retained capacity exceeds cap".into());
        }
        Ok(state)
    }

    fn bytes(&self, slice: Slice) -> &[u8] {
        &self.arena[slice.start..slice.start + slice.len]
    }
    fn value(&self, slice: Slice) -> Value {
        serde_json::from_slice(self.bytes(slice)).expect("owned resident JSON")
    }
    fn push(&mut self, bytes: &[u8], cap: usize) -> Result<Slice, String> {
        let start = self.arena.len();
        if start.checked_add(bytes.len()).is_none_or(|size| size > cap) {
            return Err("resident arena exceeds cap".into());
        }
        if self.arena.capacity() < start + bytes.len() {
            let chunk = 1024 * 1024;
            let target = (start + bytes.len())
                .div_ceil(chunk)
                .saturating_mul(chunk)
                .min(cap);
            self.arena
                .try_reserve_exact(target.saturating_sub(self.arena.len()))
                .map_err(|e| e.to_string())?;
        }
        self.arena.extend_from_slice(bytes);
        Ok(Slice {
            start,
            len: bytes.len(),
        })
    }
    fn json(&mut self, value: &impl Serialize, cap: usize) -> Result<Slice, String> {
        self.push(&serde_json::to_vec(value).map_err(|e| e.to_string())?, cap)
    }
    pub(crate) fn retained_bytes(&self) -> usize {
        size_of::<Self>()
            + self.arena.capacity()
            + self.parts.capacity() * size_of::<Part>()
            + self.by_block.capacity() * size_of::<usize>()
            + self.by_tag.capacity() * size_of::<(i64, usize)>()
            + self.raw_prefix_tokens.capacity() * size_of::<(i64, i64)>()
            + self.tail.capacity() * size_of::<Tail>()
            + self.fragments.capacity() * size_of::<Fragment>()
    }
    pub(crate) fn snapshot(&self) -> Value {
        json!({"header":self.value(self.header),"domains":self.value(self.domains),
            "tag_index":self.by_tag,"raw_prefix_tokens":self.raw_prefix_tokens,
            "parts":self.parts.iter().map(|part|json!({"ordinal":part.ordinal,"index":part.index,"part":self.value(part.value)})).collect::<Vec<_>>(),
            "block_index":self.by_block.iter().map(|&index|String::from_utf8(self.bytes(self.parts[index].block).to_vec()).unwrap()).collect::<Vec<_>>(),
            "tail":self.tail.iter().map(|tail|json!({"ordinal":tail.ordinal,"mid":String::from_utf8(self.bytes(tail.mid).to_vec()).unwrap(),
                "native":self.value(tail.native),"native_bytes":self.bytes(tail.native),"ck":self.value(tail.ck)})).collect::<Vec<_>>(),
            "fragments":self.fragments.iter().map(|fragment|json!({"key":self.value(fragment.key),"key_sha256":format!("{:x}",Sha256::digest(self.bytes(fragment.key))),
                "text":String::from_utf8(self.bytes(fragment.text).to_vec()).unwrap(),"tokens":fragment.tokens})).collect::<Vec<_>>(),
            "retained_bytes":self.retained_bytes()})
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mc_store::provider_records::{ProviderConversation, ProviderPolicyPart};
    const CAP: usize = 128 * 1024 * 1024;
    fn authority() -> ProviderResidentAuthority {
        let part = ProviderPolicyPart {
            mid: "m".into(),
            ordinal: 2,
            block_id: "m#0".into(),
            block_index: 0,
            kind: "tool_result".into(),
            role: "assistant".into(),
            measurement: mc_store::TailHygienePartMeasurement {
                key: "m#0\0tool_result".into(),
                content_hash: "hash".into(),
                kind: mc_store::TailHygienePartKind::ToolOutput,
                tokens: 13,
                u_tokens: 0,
                tag_number: Some(7),
                tag_status: Some("active".into()),
                protected: true,
                queued_for_drop: true,
            },
            tag_kind: Some("tool_result".into()),
            tag_number: Some(7),
            tag_tokens: 13,
            tool_name: "read".into(),
            arc_id: Some("arc".into()),
            subject_part: "part".into(),
            active: true,
            served: true,
            reduced: false,
            queued: true,
            real_user: false,
            created_at_ms: Some(1),
            completed_at_ms: Some(2),
        };
        ProviderResidentAuthority {
            conversation_key: "fixture".into(),
            store_instance: 1,
            conversation: ProviderConversation::default(),
            policy_revision: 9,
            ancestry: vec![("L".into(), 2)],
            parts: vec![part],
            tail: vec![],
            coverage: Some(1),
            tail_blob_rows: 0,
            tail_blob_bytes: 0,
        }
    }
    fn build(
        input: &ProviderResidentAuthority,
        rows: &[StoredCompartment],
        cap: usize,
    ) -> Result<ResidentState, String> {
        ResidentState::build(
            input,
            &json!({"frozen_units":[],"tags":[],"memories":[]}),
            rows,
            &BTreeMap::new(),
            "renderer-v1",
            "tokenizer-v1",
            cap,
        )
    }
    #[test]
    fn resident_snapshot_preserves_every_effective_part_fact() {
        let input = authority();
        let state = build(&input, &[], CAP).unwrap();
        let snapshot = state.snapshot();
        assert_eq!(
            snapshot["parts"][0]["part"],
            json!({
            "mid":"m","ordinal":2,"block_id":"m#0","block_index":0,"kind":"tool_result","role":"assistant",
            "measurement":{"key":"m#0\0tool_result","content_hash":"hash","kind":"toolOutput","tokens":13,"u_tokens":0,
                "tag_number":7,"tag_status":"active","protected":true,"queued_for_drop":true},
            "tag_kind":"tool_result","tag_number":7,"tag_tokens":13,"tool_name":"read","arc_id":"arc","subject_part":"part",
            "active":true,"served":true,"reduced":false,"queued":true,"real_user":false,"created_at_ms":1,"completed_at_ms":2})
        );
        assert_eq!(snapshot["block_index"], json!(["m#0"]));
        assert_eq!(snapshot["tag_index"], json!([[7, 0]]));
        assert_eq!(snapshot["raw_prefix_tokens"], json!([[13, 0]]));
        assert_eq!(snapshot["header"]["policy_revision"], 9);
        assert!(
            input.parts[0].queued,
            "the builder must not mutate its input"
        );
    }
    #[test]
    fn resident_retained_capacity_cap_refuses_instead_of_truncating() {
        let mut input = authority();
        input.parts.clear();
        let result = build(&input, &[], 1024);
        assert!(
            matches!(result, Err(reason) if reason == "resident retained capacity exceeds cap")
        );
        assert!(build(&authority(), &[], 1).is_err());
    }
    #[test]
    fn resident_fragment_keys_cover_source_and_render_inputs() {
        let base = StoredCompartment {
            sequence: 1,
            title: "A & <B>".into(),
            content: "first body".into(),
            p1: Some("P1 body".into()),
            p2: Some("P2 body".into()),
            start_date: Some("2026-01-01".into()),
            end_date: Some("2026-01-02".into()),
            importance: 50,
            legacy: 0,
            ..Default::default()
        };
        let first = build(&authority(), std::slice::from_ref(&base), CAP)
            .unwrap()
            .snapshot();
        for field in [
            "title",
            "content",
            "p1",
            "p2",
            "p3",
            "p4",
            "start_date",
            "end_date",
        ] {
            let mut value = serde_json::to_value(&base).unwrap();
            value[field] = json!("changed");
            let changed: StoredCompartment = serde_json::from_value(value).unwrap();
            let next = build(&authority(), &[changed], CAP).unwrap().snapshot();
            assert_ne!(
                first["fragments"][0]["key"], next["fragments"][0]["key"],
                "{field}"
            );
        }
        assert_ne!(
            first["fragments"][0]["key"], first["fragments"][1]["key"],
            "tier"
        );
        assert_ne!(
            first["fragments"][0]["key"], first["fragments"][5]["key"],
            "temporal dates"
        );
        for (renderer, tokenizer) in [
            ("renderer-v2", "tokenizer-v1"),
            ("renderer-v1", "tokenizer-v2"),
        ] {
            let next = ResidentState::build(
                &authority(),
                &json!({}),
                std::slice::from_ref(&base),
                &BTreeMap::new(),
                renderer,
                tokenizer,
                CAP,
            )
            .unwrap()
            .snapshot();
            assert_ne!(first["fragments"][0]["key"], next["fragments"][0]["key"]);
        }
        let next = ResidentState::build(
            &authority(),
            &json!({}),
            &[base],
            &BTreeMap::from([(1, 75)]),
            "renderer-v1",
            "tokenizer-v1",
            CAP,
        )
        .unwrap()
        .snapshot();
        assert_ne!(
            first["fragments"][0]["key"], next["fragments"][0]["key"],
            "selected score"
        );
    }
}

#[cfg(test)]
mod header_tests {
    use super::*;
    #[test]
    fn resident_header_binds_runtime_store_conversation_and_revision() {
        let make = |store_instance, conversation_key: &str, policy_revision| {
            let input = ProviderResidentAuthority {
                conversation_key: conversation_key.into(),
                store_instance,
                conversation: mc_store::provider_records::ProviderConversation::default(),
                policy_revision,
                ancestry: vec![],
                parts: vec![],
                tail: vec![],
                coverage: None,
                tail_blob_rows: 0,
                tail_blob_bytes: 0,
            };
            ResidentState::build(
                &input,
                &json!({}),
                &[],
                &BTreeMap::new(),
                "renderer",
                "tokenizer",
                128 * 1024 * 1024,
            )
            .unwrap()
            .snapshot()["header"]
                .clone()
        };
        let base = make(1, "conversation", 9);
        assert_ne!(base, make(2, "conversation", 9));
        assert_ne!(base, make(1, "other", 9));
        assert_ne!(base, make(1, "conversation", 10));
    }
}
