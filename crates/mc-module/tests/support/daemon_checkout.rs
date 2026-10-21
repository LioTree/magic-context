use std::path::Path;

pub fn available(workspace: &Path) -> bool {
    if std::env::var_os("MC_TEST_LOCKED_SUBC_SOURCE").is_some()
        || std::env::var_os("MC_TEST_CK_SUBC_BIN").is_some()
    {
        return true;
    }
    checkout_available(workspace)
}

fn checkout_available(workspace: &Path) -> bool {
    let sibling = workspace
        .parent()
        .expect("workspace has a parent")
        .join("subconscious");
    if sibling.join("Cargo.toml").is_file() {
        true
    } else {
        eprintln!(
            "SKIP real-daemon test: sibling subconscious checkout is missing at {}",
            sibling.display()
        );
        false
    }
}

#[test]
fn missing_checkout_skips_but_a_present_checkout_runs() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("magic-context");
    std::fs::create_dir(&workspace).unwrap();
    assert!(!checkout_available(&workspace));
    let sibling = root.path().join("subconscious");
    std::fs::create_dir(&sibling).unwrap();
    std::fs::write(sibling.join("Cargo.toml"), "[workspace]\n").unwrap();
    assert!(checkout_available(&workspace));
}
