//! Run-limit discovery shared by background prompt fitting and historian sends.

use crate::historian::HistorianModelLimits;
use crate::historian_producer::{HistorianProducerError, ProducerErrorBody};
use serde_json::Value;
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct RunnerLimits {
    pub max_steps: bool,
    pub max_output_tokens: bool,
    pub no_tools: bool,
}

impl RunnerLimits {
    pub(crate) fn from_describe(answer: &Value) -> Self {
        let answer = answer.get("result").unwrap_or(answer);
        let declares = |name| {
            answer["capabilities"]
                .as_array()
                .is_some_and(|groups| groups.iter().any(|group| group.as_str() == Some(name)))
        };
        Self {
            max_steps: declares("max_steps"),
            max_output_tokens: declares("max_output_tokens"),
            no_tools: declares("no_tools"),
        }
    }

    pub(crate) fn require_historian(self) -> Result<(), HistorianProducerError> {
        let missing: Vec<_> = [("no_tools", self.no_tools), ("max_steps", self.max_steps)]
            .into_iter()
            .filter_map(|(name, declared)| (!declared).then_some(name))
            .collect();
        if missing.is_empty() {
            Ok(())
        } else {
            Err(refusal(format!(
                "historian_runner_missing_groups: {}",
                missing.join(",")
            )))
        }
    }

    pub(crate) fn historian_chain(
        self,
        session: &str,
        chain: &mut Vec<String>,
    ) -> Result<(), HistorianProducerError> {
        self.require_historian()?;
        let skipped: Vec<_> = chain
            .iter()
            .filter(|model| is_zen_model(model))
            .cloned()
            .collect();
        chain.retain(|model| !is_zen_model(model));
        if !skipped.is_empty() {
            static WARNED: std::sync::OnceLock<
                std::sync::Mutex<std::collections::HashSet<String>>,
            > = std::sync::OnceLock::new();
            if WARNED
                .get_or_init(Default::default)
                .lock()
                .expect("Zen skip log")
                .insert(session.to_string())
            {
                tracing::warn!(session, models = ?skipped, "historian_zen_no_tools: skipping OpenCode Zen models because no tools can be offered");
            }
        }
        if chain.is_empty() {
            Err(refusal(
                "historian_zen_no_eligible_models: the entire model chain requires an offered tool"
                    .into(),
            ))
        } else {
            Ok(())
        }
    }

    /// Tighten the existing model-limit input path rather than changing the legacy
    /// capped estimator. Without a runner-enforced output cap, the model can use
    /// its entire catalog maximum, even when that exceeds a quarter of the window.
    pub(crate) fn fit_limits(
        self,
        chain: &[String],
        limits: &mut BTreeMap<String, HistorianModelLimits>,
        legacy_window: Option<usize>,
    ) -> Result<(), HistorianProducerError> {
        if self.max_output_tokens {
            return Ok(());
        }
        for model in chain {
            let entry = limits.entry(model.clone()).or_default();
            let output = entry
                .output
                .filter(|output| *output > 0)
                .ok_or_else(|| refusal(format!("historian_model_output_limit_unknown: {model}")))?;
            let window = entry.context.or(legacy_window).map(|window| {
                if entry.input.is_some() {
                    window
                } else {
                    legacy_window.map_or(window, |cap| window.min(cap))
                }
            });
            let input = window
                .map(|window| window.saturating_sub(output as usize))
                .ok_or_else(|| {
                    refusal(format!("historian_model_context_limit_unknown: {model}"))
                })?;
            let input = entry.input.map_or(input, |cap| cap.min(input));
            if input == 0 {
                return Err(refusal(format!(
                    "historian_model_output_fills_window: {model}"
                )));
            }
            entry.input = Some(input);
        }
        Ok(())
    }
}

pub(crate) fn refusal(reason: String) -> HistorianProducerError {
    HistorianProducerError::Subc(ProducerErrorBody::untagged("background_run_limits", reason))
}

/// Deliberately conservative: the TypeScript hidden-run executor offers a `read`
/// tool to every OpenCode Zen model, then refuses any call to it. Zen's free tier
/// rejects requests offering no tools. Paid Zen models are skipped too, matching
/// `shared/hidden-zen-read.ts::needsBlockedRead`, because a no-tools historian
/// cannot offer that compatibility tool.
pub(crate) fn is_zen_model(model: &str) -> bool {
    model
        .split_once('/')
        .is_some_and(|(provider, _)| provider == "opencode")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zen_skip_uses_the_standalone_provider_gate_and_refuses_an_all_zen_chain() {
        let fixture: Value =
            serde_json::from_str(include_str!("../testdata/historian-zen-models.json")).unwrap();
        let limits = RunnerLimits {
            max_steps: true,
            max_output_tokens: true,
            no_tools: true,
        };
        for case in fixture.as_array().unwrap() {
            let model = case["model"].as_str().unwrap();
            assert_eq!(
                is_zen_model(model),
                case["blockedRead"].as_bool().unwrap(),
                "{model}"
            );
            let mut chain = vec![model.into(), "other/model".into()];
            limits.historian_chain("zen-fixture", &mut chain).unwrap();
            assert_eq!(
                chain.contains(&model.to_string()),
                !case["blockedRead"].as_bool().unwrap()
            );
        }
        let error = limits
            .historian_chain(
                "all-zen",
                &mut vec!["opencode/free".into(), "opencode/paid".into()],
            )
            .unwrap_err();
        assert!(error
            .to_string()
            .contains("historian_zen_no_eligible_models"));
    }

    #[test]
    fn uncapped_fit_refuses_unknown_or_window_filling_output_instead_of_sending_raw() {
        let limits = RunnerLimits {
            max_steps: true,
            no_tools: true,
            max_output_tokens: false,
        };
        for (output, input, expected) in [
            (None, None, "output_limit_unknown"),
            (Some(200), None, "output_fills_window"),
            (Some(50), Some(0), "output_fills_window"),
        ] {
            let mut models = BTreeMap::from([(
                "p/m".into(),
                HistorianModelLimits {
                    context: Some(100),
                    input,
                    output,
                },
            )]);
            let error = limits
                .fit_limits(&["p/m".into()], &mut models, None)
                .unwrap_err();
            assert!(error.to_string().contains(expected), "{error}");
        }
    }
}
