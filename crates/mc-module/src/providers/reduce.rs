//! Queue requested reductions without changing an already rendered prefix.
use super::*;

impl McHandler {
    pub(crate) async fn handle_provider_reduce(
        &self,
        channel: u16,
        requested: &[u64],
    ) -> HandlerOutcome {
        let result: Result<HandlerOutcome, HandlerOutcome> = async {
            let binding = self
                .facade_binding(channel)
                .map_err(|_| session_unresolved_error())?;
            let key = self.provider_store.tool_key(&binding)?;
            self.provider_reduce(key, requested).await
        }
        .await;
        result.unwrap_or_else(|error| error)
    }
    async fn provider_reduce(
        &self,
        key: Key,
        requested: &[u64],
    ) -> Result<HandlerOutcome, HandlerOutcome> {
        let store = self
            .store_for_request()
            .await
            .map_err(StoreRefusal::into_outcome)?;
        let _serial = self.provider_serial.lock_for(&key).await;
        let conversation = store
            .load_provider_conversation(&key.store_key())
            .map_err(transient)?
            .ok_or_else(|| transient("provider conversation is missing"))?;
        let mut known = Vec::new();
        let mut unknown = Vec::new();
        let mut engine_blocks = BTreeMap::new();
        for number in requested {
            let Ok(n) = i64::try_from(*number) else {
                unknown.push(*number);
                continue;
            };
            if store
                .provider_answer_tag_known(&key.store_key(), n)
                .map_err(transient)?
            {
                known.push(*number);
            } else if let Some(block) = store
                .provider_engine_tag_block(&key.store_key(), n)
                .map_err(transient)?
            {
                known.push(*number);
                engine_blocks.insert(*number, block);
            } else {
                unknown.push(*number);
            }
        }
        let pending = store
            .load_provider_pending_drops(&key.store_key())
            .map_err(transient)?;
        let engine_pending = store
            .load_pending_agent_drops(&conversation.engine_namespace)
            .map_err(transient)?
            .into_iter()
            .map(|drop| drop.target_id)
            .collect::<BTreeSet<_>>();
        let already = known
            .iter()
            .copied()
            .filter(|n| {
                pending.contains(&(*n as i64))
                    || engine_blocks
                        .get(n)
                        .is_some_and(|block| engine_pending.contains(block))
            })
            .collect::<Vec<_>>();
        let queue = known
            .iter()
            .copied()
            .filter(|n| !already.contains(n))
            .collect::<Vec<_>>();
        let detail = ctx_reduce_ack_details(&unknown);
        if queue.is_empty() {
            if unknown.is_empty() && !already.is_empty() {
                return Ok(mcp_text_result(ctx_reduce_reply(already.len(), 0), false));
            }
            return Ok(tool_error_result(format!(
                "Refused: no valid tags to queue. {detail}"
            )));
        }
        let hook_queue = queue
            .iter()
            .filter(|n| !engine_blocks.contains_key(n))
            .map(|n| *n as i64)
            .collect::<Vec<_>>();
        if !hook_queue.is_empty() {
            store
                .queue_provider_drops(&key.store_key(), &hook_queue)
                .map_err(transient)?;
        }
        let engine_queue = queue
            .iter()
            .filter_map(|n| engine_blocks.get(n).cloned())
            .collect::<Vec<_>>();
        if !engine_queue.is_empty() {
            // Tags shown before provider hooks were enabled use ctx_reduce's
            // existing durable block-ID queue. Enqueueing must not change any
            // already-served bytes: the planner waits for the next independent
            // cache-rebuild opportunity before releasing the requested content.
            store
                .append_pending_agent_drops_with_command(
                    &conversation.engine_namespace,
                    None,
                    &engine_queue,
                    now_ms(),
                    false,
                )
                .map_err(transient)?;
        }
        let mut reply = ctx_reduce_reply(queue.len() + already.len(), 0);
        if !detail.is_empty() {
            reply.push(' ');
            reply.push_str(&detail);
            reply.push('.');
        }
        Ok(mcp_text_result(reply, false))
    }
}
