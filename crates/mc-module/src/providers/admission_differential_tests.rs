//! OpenCode/Broca fixture bytes recorded at fa1f68e4, before Claude Code admission tags.
use super::*;

pub(super) const BASELINE: &str = "fa1f68e428209cd1d52ccd7741d040d690bcd983";

pub(super) fn hook_snapshot(name: &str, outcome: HandlerOutcome) -> Value {
    let HandlerOutcome::Response(bytes) = outcome else {
        panic!("{outcome:?}")
    };
    snapshot(name, &bytes);
    serde_json::from_slice(&bytes).unwrap()
}

pub(super) fn snapshot(name: &str, actual: &[u8]) {
    let directory = Path::new(env!("CARGO_MANIFEST_DIR")).join("testdata/admission-differentials");
    if let Ok(output) = std::env::var("MC_G8_RECORD_DIRECTORY") {
        assert_eq!(
            std::env::var("MC_G8_BASELINE_REVISION").as_deref(),
            Ok(BASELINE)
        );
        std::fs::create_dir_all(&output).unwrap();
        std::fs::write(Path::new(&output).join(name), actual).unwrap();
        return;
    }
    let expected = std::fs::read(directory.join(name)).unwrap();
    assert_eq!(actual, expected, "{name}: bytes differ from {BASELINE}");
}
