//! Dream prompt rendering shares the summary host's ladder and approval policy.
//! The legacy `task` and `system` helpers use the embedded tier; `load` accepts
//! the caller's tiers and checksum approvals.

use super::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Curate,
    Classify,
    Map,
    Verify,
    ReviewUser,
}

pub const KINDS: [Kind; 5] = [
    Kind::Curate,
    Kind::Classify,
    Kind::Map,
    Kind::Verify,
    Kind::ReviewUser,
];

impl Kind {
    pub fn id(self) -> &'static str {
        match self {
            Self::Curate => "mc_dream_curate",
            Self::Classify => "mc_dream_classify",
            Self::Map => "mc_dream_map",
            Self::Verify => "mc_dream_verify",
            Self::ReviewUser => "mc_dream_review_user",
        }
    }

    fn files(self) -> [(&'static str, &'static str); 3] {
        macro_rules! files {
            ($id:literal) => {
                [
                    (
                        "PERSONA.md",
                        include_str!(concat!("../../personas/", $id, "/PERSONA.md")),
                    ),
                    (
                        "fragments/task.md",
                        include_str!(concat!("../../personas/", $id, "/fragments/task.md")),
                    ),
                    (
                        "fragments/system.md",
                        include_str!(concat!("../../personas/", $id, "/fragments/system.md")),
                    ),
                ]
            };
        }
        match self {
            Self::Curate => files!("mc_dream_curate"),
            Self::Classify => files!("mc_dream_classify"),
            Self::Map => files!("mc_dream_map"),
            Self::Verify => files!("mc_dream_verify"),
            Self::ReviewUser => files!("mc_dream_review_user"),
        }
    }

    fn contract(self) -> &'static str {
        match self {
            Self::Curate => "mc.dream.curate/v1",
            Self::Classify => "mc.dream.classify/v1",
            Self::Map => "mc.dream.map/v1",
            Self::Verify => "mc.dream.verify/v1",
            Self::ReviewUser => "mc.dream.review_user/v1",
        }
    }

    fn tools(self) -> &'static [&'static str] {
        use crate::dream_dispatch::routed::fetch_plan;
        use mc_store::dream_scheduler::schedules::TaskName;
        match self {
            Self::Curate => fetch_plan::plan(TaskName::Curate)[0].tools,
            Self::Map => fetch_plan::plan(TaskName::Map)[0].tools,
            Self::Verify => fetch_plan::plan(TaskName::Verify)[0].tools,
            Self::Classify | Self::ReviewUser => &[],
        }
    }
}

pub(super) fn with_embedded(mut base: EmbeddedTier) -> EmbeddedTier {
    for kind in KINDS {
        for (path, text) in kind.files() {
            base = base
                .with_file(kind.id(), path, text)
                .expect("fixed dream persona path");
        }
    }
    base
}

/// Preformatted memory/evidence blocks preserve the existing task wire format.
/// They are values, never parsed again as templates, even if they contain Jinja.
#[derive(Debug, Default, Serialize)]
pub struct Input<'a> {
    pub project: &'a str,
    pub category: &'a str,
    pub memories: &'a str,
    pub anchors: &'a str,
    pub candidates: &'a str,
    pub profiles: &'a str,
    pub threshold: usize,
    pub instruction: &'a str,
    pub evidence: &'a str,
}

#[derive(Debug)]
pub struct DreamPersona {
    kind: Kind,
    persona: SummaryPersona,
}

impl DreamPersona {
    pub fn routing(&self) -> &Routing {
        self.persona.routing()
    }
    pub fn generation(&self) -> &Generation {
        self.persona.generation()
    }
}

/// Repository wording requires persona/v1 checksum approval. Cost fields still
/// pass through the same host-side ceiling as the summary persona.
pub fn load(
    kind: Kind,
    tiers: &[Tier],
    approvals: &ApprovalSet,
    project_key: Option<&ProjectKey>,
) -> Result<DreamPersona, PersonaError> {
    Ok(DreamPersona {
        kind,
        persona: load_role(kind.id(), tiers, approvals, project_key)?,
    })
}

#[derive(Serialize)]
struct Tool {
    name: &'static str,
    description: &'static str,
}

#[derive(Serialize)]
struct Context<'a> {
    turn: &'static str,
    mode: &'a str,
    routing: &'a Routing,
    tools: Vec<Tool>,
    output: DreamOutput,
    input: &'a Input<'a>,
}

#[derive(Serialize)]
struct DreamOutput {
    id: &'static str,
    format: &'static str,
    schema_text: String,
}

/// Render one turn from a loaded, approved persona. `mode` is `full` or `broad`
/// for verification; the base wording deliberately remains identical for both.
pub fn render(
    persona: &DreamPersona,
    input: &Input<'_>,
    mode: &str,
    system: bool,
) -> Result<Rendered, PersonaError> {
    let kind = persona.kind;
    let module = Context {
        turn: if system { "system" } else { "task" },
        mode,
        routing: persona.routing(),
        tools: kind
            .tools()
            .iter()
            .map(|name| Tool {
                name,
                description: if *name == "ctx_memory" {
                    "Scoped project memory operations"
                } else {
                    "Read-only repository inspection"
                },
            })
            .collect(),
        output: DreamOutput {
            id: kind.contract(),
            format: if kind == Kind::ReviewUser {
                "json"
            } else {
                "xml"
            },
            schema_text: kind.files()[2]
                .1
                .replace("\r\n", "\n")
                .trim_end_matches('\n')
                .to_owned(),
        },
        input,
    };
    persona.persona.role.render(
        &context_for(
            kind.id(),
            persona.routing(),
            &ProjectContext::default(),
            module,
        ),
        &FragmentSources::new(),
    )
}

fn embedded(kind: Kind) -> &'static DreamPersona {
    static BASE: OnceLock<Vec<DreamPersona>> = OnceLock::new();
    &BASE.get_or_init(|| {
        let tiers = [
            Tier::embedded("base", TrustClass::Operator, embedded_base()).expect("fixed base tier"),
        ];
        KINDS
            .iter()
            .map(|kind| {
                load(*kind, &tiers, &ApprovalSet::new(), None)
                    .expect("valid compiled dream persona")
            })
            .collect()
    })[KINDS.iter().position(|k| *k == kind).expect("known kind")]
}

pub fn task(kind: Kind, input: &Input<'_>) -> String {
    task_with_mode(kind, input, "full")
}

pub fn task_with_mode(kind: Kind, input: &Input<'_>, mode: &str) -> String {
    render(embedded(kind), input, mode, false)
        .expect("valid embedded dream task")
        .text
}

/// One immutable system prefix per role; batches never re-render it.
pub fn system(kind: Kind) -> &'static str {
    static SYSTEMS: OnceLock<Vec<String>> = OnceLock::new();
    &SYSTEMS.get_or_init(|| {
        KINDS
            .iter()
            .map(|kind| {
                render(embedded(*kind), &Input::default(), "full", true)
                    .expect("valid embedded dream system")
                    .text
            })
            .collect()
    })[KINDS.iter().position(|k| *k == kind).expect("known kind")]
}

#[cfg(test)]
mod tests;
