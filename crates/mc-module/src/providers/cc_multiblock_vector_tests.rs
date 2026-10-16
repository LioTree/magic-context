//! The capability builder hashes all of codec_claude_code.rs, including tests.
//! Keep this new reader separate so the profile generation and the independently
//! pinned original fourteen single-tag cases stay unchanged.
use super::super::codec_claude_code::splice_admission_tag;
use super::*;
use serde::Deserialize;

const VECTORS: &[u8] = include_bytes!("cc_admission_vectors/admission-tags-98e7252e.json");
const SOURCE: &[u8] = include_bytes!("cc_admission_vectors/admission-tags-98e7252e.SOURCE");

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Source {
    repository: String,
    path: String,
    commit: String,
    sha256: String,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(deny_unknown_fields)]
struct Edit {
    part_index: usize,
    number: u64,
}

#[derive(Deserialize)]
struct Vector {
    name: String,
    raw_message: String,
    #[serde(flatten)]
    addressing: BTreeMap<String, Value>,
    expected: String,
    // raw_input still contains Claude Code's cache_control transport markers.
    // The gateway strips those markers; MC splices only raw_message, so this
    // reader deliberately ignores raw_input.
    #[serde(default, rename = "raw_input")]
    _raw_input: Option<Value>,
}

impl Vector {
    fn ordered_edits(&self) -> Result<Vec<Edit>, String> {
        let invalid = || {
            format!(
                "{}: use exactly one of part_index/number or edits",
                self.name
            )
        };
        let edits: Vec<Edit> = if self.addressing.len() == 2
            && self.addressing.contains_key("part_index")
            && self.addressing.contains_key("number")
        {
            serde_json::from_value::<Edit>(serde_json::to_value(&self.addressing).unwrap())
                .map(|edit| vec![edit])
        } else if self.addressing.len() == 1 && self.addressing.contains_key("edits") {
            serde_json::from_value(self.addressing["edits"].clone())
        } else {
            return Err(invalid());
        }
        .map_err(|error| format!("{}: {error}", self.name))?;
        if edits.is_empty() {
            return Err(format!("{}: edits must not be empty", self.name));
        }
        let mut seen = BTreeSet::new();
        for edit in &edits {
            if !seen.insert(edit.part_index) {
                return Err(format!("{}: duplicate edit part_index", self.name));
            }
        }
        if edits
            .windows(2)
            .any(|pair| pair[0].part_index > pair[1].part_index)
        {
            return Err(format!("{}: out-of-order edit part_index", self.name));
        }
        Ok(edits)
    }

    fn splice(&self) -> String {
        let mut actual = self.raw_message.clone();
        for edit in self
            .ordered_edits()
            .unwrap_or_else(|reason| panic!("{reason}"))
        {
            actual = splice_admission_tag(&actual, edit.part_index, edit.number)
                .unwrap_or_else(|error| panic!("{}: {error:?}", self.name));
        }
        actual
    }
}

fn vectors() -> Vec<Vector> {
    serde_json::from_slice(VECTORS).expect("THALAMUS multi-block splice vectors")
}

#[test]
fn multiblock_admission_vectors_digest_matches_source() {
    use sha2::{Digest, Sha256};
    let pin: Source = serde_json::from_slice(SOURCE).unwrap();
    assert_eq!(pin.repository, "thalamus");
    assert_eq!(
        pin.path,
        "crates/thalamus-module/src/cc_step_codec/vectors/admission-tags.json"
    );
    assert_eq!(pin.commit, "98e7252e26b330e5487578c74808b6bdc0b9c9a4");
    assert_eq!(pin.sha256, format!("{:x}", Sha256::digest(VECTORS)));
}

#[test]
fn multiblock_admission_vectors_preserve_original_fourteen_cases() {
    let original: Vec<Value> =
        serde_json::from_slice(include_bytes!("cc_admission_vectors/admission-tags.json")).unwrap();
    let expanded: Vec<Value> = serde_json::from_slice(VECTORS).unwrap();
    assert_eq!(original.len(), 14);
    assert_eq!(&expanded[..14], original);
}

#[test]
fn multiblock_admission_vectors_replay_all_sixteen_byte_for_byte() {
    let vectors = vectors();
    assert_eq!(vectors.len(), 16);
    for vector in vectors {
        assert_eq!(
            vector.splice().as_bytes(),
            vector.expected.as_bytes(),
            "{}",
            vector.name
        );
    }
}

#[test]
fn multiblock_admission_vector_three_text_blocks_escaped_middle() {
    let vector = vectors()
        .into_iter()
        .find(|v| v.name == "three-text-blocks-escaped-middle")
        .unwrap();
    assert_eq!(
        vector.splice().as_bytes(),
        vector.expected.as_bytes(),
        "{}",
        vector.name
    );
}

#[test]
fn multiblock_admission_vector_reader_rejects_invalid_forms_by_name() {
    for (name, fields, reason) in [
        (
            "mixed",
            json!({"part_index":0,"number":1,"edits":[{"part_index":0,"number":1}]}),
            "exactly one",
        ),
        (
            "mixed-null-single",
            json!({"part_index":null,"number":null,"edits":[{"part_index":0,"number":1}]}),
            "exactly one",
        ),
        ("partial-single", json!({"part_index":0}), "exactly one"),
        ("missing", json!({}), "exactly one"),
        ("empty", json!({"edits":[]}), "must not be empty"),
        (
            "duplicate",
            json!({"edits":[{"part_index":0,"number":1},{"part_index":0,"number":2}]}),
            "duplicate",
        ),
        (
            "nonadjacent-duplicate",
            json!({"edits":[{"part_index":0,"number":1},{"part_index":1,"number":2},{"part_index":0,"number":3}]}),
            "duplicate",
        ),
        (
            "out-of-order",
            json!({"edits":[{"part_index":1,"number":1},{"part_index":0,"number":2}]}),
            "out-of-order",
        ),
    ] {
        let mut input = json!({"name":name,"raw_message":"{}","expected":"{}"});
        input
            .as_object_mut()
            .unwrap()
            .extend(fields.as_object().unwrap().clone());
        let vector: Vector = serde_json::from_value(input).unwrap();
        let error = vector
            .ordered_edits()
            .err()
            .expect("invalid edit form must fail");
        assert!(
            error.starts_with(&format!("{name}:")) && error.contains(reason),
            "{error}"
        );
    }
}

#[test]
fn multiblock_admission_vectors_ignore_raw_input() {
    let mut vector = vectors().remove(0);
    let original = vector.splice();
    vector._raw_input = Some(json!({"must":"not be spliced"}));
    assert_eq!(vector.splice(), original);
}
