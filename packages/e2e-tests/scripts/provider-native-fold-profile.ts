import assert from "node:assert/strict";
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Instrument only the generated driver, never the shipping allocator or codec. */
export function instrumentNativeFold(root: string, generated: string, lib: string): string {
    const mode = process.env.MC_NATIVE_FOLD_PROFILE;
    if (!mode) return lib;
    const providers = join(generated, "src/providers");
    if (lstatSync(providers).isSymbolicLink()) rmSync(providers);
    mkdirSync(providers, { recursive: true });
    for (const name of readdirSync(join(root, "crates/mc-module/src/providers"))) {
        const destination = join(providers, name);
        try { rmSync(destination); } catch { /* A fresh overlay has no link yet. */ }
        if (name !== "compaction.rs") symlinkSync(join(root, "crates/mc-module/src/providers", name), destination);
    }
    let source = readFileSync(join(root, "crates/mc-module/src/providers/compaction.rs"), "utf8");
    const start = source.indexOf("fn execute_host(");
    const end = source.indexOf("\nfn status(", start);
    assert.ok(start > 0 && end > start);
    let body = source.slice(start, end);
    const insert = (marker: string, phase: string) => {
        assert.equal(body.split(marker).length, 2, `unique profile seam: ${phase}`);
        body = body.replace(marker, `fold_profile.phase("${phase}");\n    ${marker}`);
    };
    body = body.replace("let started = Instant::now();", "let started = Instant::now();\n    let mut fold_profile = crate::native_fold_profile::Probe::new(work.resident_folds);");
    insert("let replay_ms =", "replay_and_prefix");
    insert("let prepare_ms =", "prepare");
    insert("let engine_ms =", "engine");
    insert("let render_context =", "refresh_prefix");
    insert("let encoding_key =", "jcs");
    insert("let (mut wire, mut coverage, raw_replacement, head_slots) =", "boundary_source");
    insert("if output.engine.response.coverage_ordinal.is_some() && coverage.is_none()", "codec_and_provenance");
    insert("let boundary = store", "endpoint_lookup");
    insert("coverage.endpoint =", "boundary_state_read");
    insert("wire.raw_view =", "endpoint_check");
    insert("let mut view = HostView", "freeze_raw_view");
    insert("let persisted =", "native_cut");
    insert("Ok(Some((view, persisted)))", "publish");
    if (mode === "full-load") {
        assert.ok(body.includes(".load_boundary_id(&conversation.engine_namespace)"));
        body = body.replace(".load_boundary_id(&conversation.engine_namespace)\n                .map_err(transient)?", ".load(&conversation.engine_namespace)\n                .map_err(transient)?.core.boundary_id");
    }
    source = source.slice(0, start) + body + source.slice(end);
    writeFileSync(join(providers, "compaction.rs"), source);
    return lib.replace("#![forbid(unsafe_code)]", "") +
        `\n#[path = ${JSON.stringify(join(root, "packages/e2e-tests/scripts/provider-native-fold-profile.rs"))}]\nmod native_fold_profile;\n`;
}
