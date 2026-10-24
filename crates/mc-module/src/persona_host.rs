//! ck-mc's `persona/v1` host. Operator tiers may configure routing and generation;
//! repository tiers may change wording only. Loading accepts caller-owned
//! approvals; freezing rendered bytes and storing approvals belong to the caller.

use std::path::Path;
use std::sync::{Arc, OnceLock};

use cortexkit_persona::{
    AgentContext, ApprovalSet, DefaultLadder, Demand, EmbeddedTier, EnvContext, Extension,
    FragmentSources, GrantMap, HarnessContext, LoadRequest, LoadedRole, MergeInput, MergeRule,
    ModelContext, OsName, PersonaEngine, PersonaError, ProjectKey, RenderContext, Rendered,
    SourceRef, Tier, TrustClass,
};
use serde::{de::DeserializeOwned, Deserialize, Serialize};

pub mod dream;

pub const MODULE: &str = "magic-context";
pub const SUMMARY_ROLE: &str = "mc_summary";
pub const SUMMARY_CONTRACT: &str = "mc.summary.xml/v1";

/// One live source for the legacy historian guidance and its combined XML contract.
/// The testdata copy remains an independent byte-compatibility oracle.
pub const HISTORIAN_SYSTEM_PROMPT: &str =
    include_str!("../personas/mc_summary/fragments/system.md");
const SUMMARY_PERSONA: &str = include_str!("../personas/mc_summary/PERSONA.md");
const LANGUAGE_FRAGMENT: &str = include_str!("../personas/fragments/language.md");
const LANGUAGE_PERSONA: &str = "---\nname: language\nversion: 1\ndisplay_name: Language directive\nfragments: [mc/language@1]\n---\n{% include \"mc/language@1\" %}";

/// An operator layer's routing mapping replaces the lower mapping. Omitted
/// fields use the summary defaults, rather than the machine's routing state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Routing {
    pub consumer: String,
    pub iq: u8,
    pub eq: Option<u8>,
}

impl Default for Routing {
    fn default() -> Self {
        Self {
            consumer: SUMMARY_ROLE.into(),
            iq: 50,
            eq: None,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Generation {
    #[serde(default)]
    pub temperature: Option<f64>,
}

// The cortexkit-persona crate's SPEC.md (§5) calls a custom merge once per
// applied layer in ladder order, and its report (§7) lists those same layers in
// ladder order. Keep declaration flags in memory so policy can join them to
// trust/path without re-reading approved files. Only the value is serialized
// into the manifest/source revision (SPEC.md §6).
#[derive(Clone, Serialize, Deserialize)]
#[serde(transparent)]
struct OperatorValue<T> {
    value: T,
    #[serde(skip)]
    declarations: Vec<bool>,
}

fn operator_extension<T>(key: &str) -> Extension<OperatorValue<T>>
where
    T: DeserializeOwned + Serialize + Clone + Send + Sync + 'static,
{
    Extension::new(key)
        .required()
        .merge(MergeRule::Custom(Arc::new(
            |input: MergeInput<'_, OperatorValue<T>>| {
                let declared = input.present.is_some();
                let mut declarations = input
                    .inherited
                    .as_ref()
                    .map(|v| v.declarations.clone())
                    .unwrap_or_default();
                declarations.push(declared);
                Ok(input.present.or(input.inherited).map(|mut v| {
                    v.declarations = declarations;
                    v
                }))
            },
        )))
}

fn check_operator_only<T: 'static>(role: &LoadedRole, key: &str) -> Result<(), PersonaError> {
    let value = role
        .manifest()
        .extension::<OperatorValue<T>>(key)
        .expect("required registered extension");
    let used: Vec<_> = role.tiers().iter().filter(|tier| tier.used).collect();
    assert_eq!(
        used.len(),
        value.declarations.len(),
        "persona/v1 merge/report order contract"
    );
    for (tier, declared) in used.into_iter().zip(&value.declarations) {
        if *declared && tier.trust == TrustClass::Repository {
            return Err(PersonaError::InvalidField {
                file: SourceRef::File {
                    tier: tier.name.clone(),
                    path: format!("{}/PERSONA.md", tier.relative_path),
                },
                field: key.into(),
                reason: format!("{key}.* may only be set by operator tiers"),
            });
        }
    }
    Ok(())
}

/// A loaded summary that has passed ck-mc's repository-tier safety policy.
#[derive(Debug)]
pub struct SummaryPersona {
    role: LoadedRole,
}

impl SummaryPersona {
    pub fn routing(&self) -> &Routing {
        &self
            .role
            .manifest()
            .extension::<OperatorValue<Routing>>("routing")
            .expect("required routing")
            .value
    }

    pub fn generation(&self) -> &Generation {
        &self
            .role
            .manifest()
            .extension::<OperatorValue<Generation>>("generation")
            .expect("required generation")
            .value
    }

    pub fn manifest(&self) -> &cortexkit_persona::Manifest {
        self.role.manifest()
    }
}

/// The language fragment's arguments; these are stable inputs to a frozen render.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct LanguageOptions {
    pub preserve_user_quotes: bool,
    pub retrospective: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct LanguageContext {
    pub code: Option<String>,
    pub name: Option<String>,
    pub preserve_user_quotes: bool,
    pub retrospective: bool,
}

impl LanguageContext {
    pub fn new(code: Option<&str>, options: LanguageOptions) -> Self {
        let name = crate::content_language::resolve_language_name(code).map(str::to_owned);
        Self {
            code: code.map(str::to_owned),
            name,
            preserve_user_quotes: options.preserve_user_quotes,
            retrospective: options.retrospective,
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct ProjectContext {
    /// A display name, never the checkout's absolute path.
    pub name: Option<String>,
}

/// The summary's system-only inputs. Session data, clocks, counters, extraction
/// toggles, references and memories deliberately have no fields here: they go in
/// the user turn, not the cacheable system prefix.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct SummaryContext {
    pub language: LanguageContext,
    pub project: ProjectContext,
}

#[derive(Serialize)]
struct OutputContext {
    id: &'static str,
    format: &'static str,
    // Keep the existing combined guidance/contract intact until its contract changes.
    schema_text: &'static str,
}

#[derive(Serialize)]
struct ModuleContext<'a> {
    routing: &'a Routing,
    language: &'a LanguageContext,
    project: &'a ProjectContext,
    output: OutputContext,
}

/// The compiled base works without any persona files on the host filesystem.
pub fn embedded_base() -> EmbeddedTier {
    dream::with_embedded(EmbeddedTier::new())
        .with_file(SUMMARY_ROLE, "PERSONA.md", SUMMARY_PERSONA)
        .expect("fixed summary persona path")
        .with_file(SUMMARY_ROLE, "fragments/system.md", HISTORIAN_SYSTEM_PROMPT)
        .expect("fixed summary system path")
}

/// Use persona/v1's platform config resolver, including APPDATA on Windows.
pub fn tier_ladder(
    workspace: Option<&str>,
    project_root: Option<&Path>,
) -> Result<Vec<Tier>, PersonaError> {
    finish_ladder(
        DefaultLadder::new(MODULE, embedded_base())?,
        workspace,
        project_root,
    )
}

/// An explicit config root supports an already-resolved host config directory
/// and hermetic tests without reading or changing the process environment.
pub fn tier_ladder_with_config_home(
    config_home: &Path,
    workspace: Option<&str>,
    project_root: Option<&Path>,
) -> Result<Vec<Tier>, PersonaError> {
    finish_ladder(
        DefaultLadder::with_config_home(MODULE, embedded_base(), config_home)?,
        workspace,
        project_root,
    )
}

fn finish_ladder(
    mut ladder: DefaultLadder,
    workspace: Option<&str>,
    project_root: Option<&Path>,
) -> Result<Vec<Tier>, PersonaError> {
    if let Some(workspace) = workspace {
        ladder = ladder.workspace(workspace)?;
    }
    if let Some(root) = project_root {
        ladder = ladder.project(root);
    }
    Ok(ladder.tiers())
}

/// Operator tiers may set routing/generation, but even an approved repository
/// tier cannot. Unapproved layers are skipped before parsing, exactly as
/// persona/v1 specifies. Tools and output schemas remain code-owned.
pub fn load_summary(
    tiers: &[Tier],
    approvals: &ApprovalSet,
    project_key: Option<&ProjectKey>,
) -> Result<SummaryPersona, PersonaError> {
    load_role(SUMMARY_ROLE, tiers, approvals, project_key)
}

fn load_role(
    id: &str,
    tiers: &[Tier],
    approvals: &ApprovalSet,
    project_key: Option<&ProjectKey>,
) -> Result<SummaryPersona, PersonaError> {
    let mut engine = PersonaEngine::new(MODULE)?;
    engine.register_extension(operator_extension::<Routing>("routing"))?;
    engine.register_extension(operator_extension::<Generation>("generation"))?;
    let mut request = LoadRequest::new(id, tiers, approvals);
    if let Some(key) = project_key {
        request = request.project_key(key);
    }
    let role = engine.load(request)?;
    check_operator_only::<Routing>(&role, "routing")?;
    check_operator_only::<Generation>(&role, "generation")?;
    let persona = SummaryPersona { role };
    let routing = persona.routing();
    if routing.consumer.trim().is_empty()
        || routing.iq > 100
        || routing.eq.is_some_and(|eq| eq > 100)
    {
        return Err(PersonaError::InvalidContext {
            field: "routing".into(),
            reason: "nonempty consumer and iq/eq in 0-100 required".into(),
        });
    }
    Ok(persona)
}

/// Return LF-normalized text/bytes, SHA-256 digest and deterministic resolution
/// report together. Strict failures propagate unchanged, including their source.
pub fn render_summary(
    persona: &SummaryPersona,
    context: &SummaryContext,
) -> Result<Rendered, PersonaError> {
    persona.role.render(
        &render_context(SUMMARY_ROLE, context, persona.routing()),
        &fragments()?,
    )
}

fn fragments() -> Result<FragmentSources, PersonaError> {
    FragmentSources::new()
        .with("mc/language@1", LANGUAGE_FRAGMENT)?
        // persona/v1 has no optional-slot syntax. Supply the absent profile as
        // an empty module-owned fragment, never as a repository-controlled file.
        .with("mc/memory-profile@1", "")
}

fn render_context<'a>(
    role: &str,
    context: &'a SummaryContext,
    routing: &'a Routing,
) -> RenderContext<ModuleContext<'a>> {
    context_for(
        role,
        routing,
        &context.project,
        ModuleContext {
            routing,
            language: &context.language,
            project: &context.project,
            output: OutputContext {
                id: SUMMARY_CONTRACT,
                format: "xml",
                schema_text: HISTORIAN_SYSTEM_PROMPT,
            },
        },
    )
}

fn context_for<T>(
    role: &str,
    routing: &Routing,
    project: &ProjectContext,
    module: T,
) -> RenderContext<T> {
    RenderContext {
        agent: AgentContext {
            name: None,
            agent_id: None,
            project: project.name.clone(),
            workspace: None,
            role: role.into(),
        },
        // Rendering happens before placement. Neutral, fixed values satisfy the
        // shared context without making the prompt depend on a selected model,
        // harness, machine, locale or clock.
        model: ModelContext {
            provider: "unselected".into(),
            id: "unselected".into(),
            family: None,
            variant: "default".into(),
        },
        harness: HarnessContext {
            id: "ck-mc".into(),
            capabilities: Default::default(),
        },
        tools: GrantMap::default(),
        mcp: GrantMap::default(),
        modules: GrantMap::default(),
        demand: Demand {
            iq: routing.iq,
            eq: routing.eq.unwrap_or(0),
        },
        env: EnvContext {
            os: OsName::Unknown,
            timezone: "UTC".into(),
            locale: "en".into(),
        },
        module,
    }
}

fn embedded_summary() -> &'static SummaryPersona {
    static BASE: OnceLock<SummaryPersona> = OnceLock::new();
    BASE.get_or_init(|| {
        let tiers = [Tier::embedded(
            "base",
            cortexkit_persona::TrustClass::Operator,
            embedded_base(),
        )
        .expect("fixed base tier")];
        load_summary(&tiers, &ApprovalSet::new(), None).expect("valid compiled summary persona")
    })
}

/// Legacy callers use the embedded persona until lineage freezing adopts the
/// caller's loaded ladder. No operator files are read on this compatibility path.
pub fn render_embedded_summary(context: &SummaryContext) -> Result<Rendered, PersonaError> {
    render_summary(embedded_summary(), context)
}

/// Render the same qualified fragment for non-summary hidden agents. The small
/// internal wrapper uses the shared engine too, so there is only one language
/// template and no second implementation of its conditional instructions.
pub fn render_language_directive(
    language: Option<&str>,
    options: LanguageOptions,
) -> Result<String, PersonaError> {
    static LANGUAGE: OnceLock<LoadedRole> = OnceLock::new();
    let persona = LANGUAGE.get_or_init(|| {
        let base = EmbeddedTier::new()
            .with_file("language", "PERSONA.md", LANGUAGE_PERSONA)
            .expect("fixed language wrapper path");
        let tiers = [
            Tier::embedded("base", cortexkit_persona::TrustClass::Operator, base)
                .expect("fixed base tier"),
        ];
        PersonaEngine::new(MODULE)
            .expect("fixed module id")
            .load(LoadRequest::new("language", &tiers, &ApprovalSet::new()))
            .expect("valid compiled language wrapper")
    });
    let context = SummaryContext {
        language: LanguageContext::new(language, options),
        ..Default::default()
    };
    Ok(persona
        .render(
            &render_context("language", &context, &Routing::default()),
            &fragments()?,
        )?
        .text)
}

#[cfg(test)]
mod tests;
