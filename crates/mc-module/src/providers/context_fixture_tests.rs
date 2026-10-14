use super::*;
use crate::host_store::{HostStore, DOMAIN_TABLES};
use mc_store::context_schema::{BOOTSTRAP, BOOTSTRAP_VERSION};
use mc_store::parity_schema_manifest::{
    CapabilityResult, ContextSchemaRequest, ContextSchemaStore, Generation,
};
use sha2::{Digest, Sha256};

#[tokio::test]
async fn cc_context_v100_fixture_passes_live_fingerprint_on_every_setup() {
    let dir = tempfile::tempdir().unwrap();
    let context = dir.path().join("context.db");
    let fixture = std::env::var_os("MC_CC_FIXTURE_DB").map(PathBuf::from);
    let original = fixture.as_ref().map(|path| std::fs::read(path).unwrap());
    if let Some(path) = &fixture {
        std::fs::copy(path, &context).unwrap();
    } else {
        assert_eq!(BOOTSTRAP_VERSION, 100);
        let request = ContextSchemaRequest {
            database_path: context.to_str().unwrap().into(),
            expected_schema_version: BOOTSTRAP_VERSION,
            writer_generation: Generation(1),
        };
        assert!(matches!(
            BOOTSTRAP.bootstrap(&request),
            CapabilityResult::Available { .. }
        ));
    }
    let h = handler(dir.path(), thalamus());
    let domain = Arc::new(crate::single_store_reads::ModuleContextDomain::open(&context).unwrap());
    h.store.get().unwrap().install_context_domain(domain);
    let mut host = HostStore::open(&context).unwrap();
    for setup_number in 1..=10 {
        // Setup does not necessarily write memories. Explicitly exercise the live
        // table fence on the replay copy, rather than trusting cached health data.
        host.with_domain_transaction(DOMAIN_TABLES, &mut |_| Ok(()))
            .unwrap();
        let ready = setup(&h).await;
        assert_eq!(ready["answer"], "ready", "setup {setup_number}: {ready}");
        host.with_domain_transaction(DOMAIN_TABLES, &mut |_| Ok(()))
            .unwrap();
        println!(
            "setup {setup_number}: ready; live domain-table fingerprints passed before and after"
        );
    }
    let conn = rusqlite::Connection::open(&context).unwrap();
    println!(
        "memory_mutation_log fingerprint: {}",
        crate::host_store::read_table_fingerprint(&conn, "memory_mutation_log")
            .unwrap()
            .unwrap()
    );
    conn.execute_batch("ALTER TABLE memory_mutation_log ADD COLUMN fingerprint_probe TEXT")
        .unwrap();
    let error = host
        .with_domain_transaction(&["memory_mutation_log"], &mut |_| Ok(()))
        .unwrap_err();
    assert_eq!(error.code(), "single_store_fingerprint_mismatch");
    println!(
        "live fence negative control after schema drift: {}",
        error.code()
    );
    if let (Some(path), Some(original)) = (&fixture, original) {
        assert_eq!(std::fs::read(path).unwrap(), original);
        println!("pristine fixture sha256: {:x}", Sha256::digest(&original));
    }
}
