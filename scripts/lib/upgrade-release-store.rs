//! Compiled inside the v0.49.0 source tree, never against the candidate's store crate.
use cortexkit_cache_core::{CoreState, DurabilityClass, FrozenUnit};
use cortexkit_store_types::{Isolation, StorageBackend, StorageDescriptor};
use mc_store::{McStore, ModuleMeta};
use std::{error::Error, path::PathBuf};

fn main() -> Result<(), Box<dyn Error>> {
    let args: Vec<String> = std::env::args().collect();
    let root = PathBuf::from(&args[2]).canonicalize()?;
    let allowed = std::env::temp_dir().join("magic-context").canonicalize()?;
    if !root.starts_with(allowed) {
        return Err("store root must be under $TMPDIR/magic-context".into());
    }
    let descriptor = StorageDescriptor {
        module_id: "magic-context".into(),
        storage_namespace: "mc_cache".into(),
        isolation: Isolation::Module,
        backend: StorageBackend::Sqlite {
            path: root.join("store.db").to_string_lossy().into_owned(),
        },
    };
    let store = McStore::open(&descriptor)?;
    if args[1] == "seed" {
        for index in 0..20 {
            let count = if index == 0 { 150_000 } else { 500 };
            let core = CoreState {
                boundary_id: format!("message-{index}-65"),
                frozen_units: (2..=count)
                    .step_by(2)
                    .map(|ordinal| FrozenUnit {
                        key: format!("strip:trailing_blank_keep:message-{index}-{ordinal}"),
                        kind: "strip_trailing_blank_keep".into(),
                        frozen_payload: String::new(),
                        durability_class: DurabilityClass::Lineage,
                        reset_rule: String::new(),
                    })
                    .collect(),
                ..Default::default()
            };
            let meta = ModuleMeta {
                initialized: true,
                coverage_ordinal: Some(if index == 0 { 150_000 } else { 500 }),
                last_todo_state: Some(
                    r#"[{"content":"Preserve 東京 🧠","status":"pending","priority":"high"}]"#
                        .into(),
                ),
                ..Default::default()
            };
            store.commit(&format!("session-{index:02}"), None, &core, &meta)?;
        }
    }
    println!(
        "release store schema {}",
        mc_store::LATEST_MIGRATION_VERSION
    );
    Ok(())
}
