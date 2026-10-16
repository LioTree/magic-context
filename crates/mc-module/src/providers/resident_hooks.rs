//! Each hook temporarily owns its session's cached policy while the store writes
//! the new message and answer. A failed write discards that cache, so a later
//! hook cannot use totals containing a message the database never committed.
use super::{policy_summary::ResidentPolicy, records::Key};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};

pub(crate) const SESSION_CAP: usize = 64 * 1024 * 1024;
// Bounds charged resident structures, not RSS. SQLite caches, transient rebuild
// working sets and allocator high-water can put fleet RSS well above this cap.
pub(crate) const PROCESS_CAP: usize = 1024 * 1024 * 1024;
const SESSION_SLOTS: usize = 1024;

pub(crate) struct ResidentHooks {
    enabled: bool,
    process_cap: usize,
    entries: Mutex<HashMap<(u64, String), Entry>>,
    clock: AtomicU64,
    #[cfg(test)]
    evictions: AtomicU64,
    #[cfg(test)]
    oversize_discards: AtomicU64,
    #[cfg(test)]
    peak_building: AtomicU64,
}

impl Default for ResidentHooks {
    fn default() -> Self {
        Self {
            enabled: false,
            process_cap: PROCESS_CAP,
            entries: Mutex::new(HashMap::new()),
            clock: AtomicU64::new(0),
            #[cfg(test)]
            evictions: AtomicU64::new(0),
            #[cfg(test)]
            oversize_discards: AtomicU64::new(0),
            #[cfg(test)]
            peak_building: AtomicU64::new(0),
        }
    }
}

enum Entry {
    Building(usize),
    Ready(Box<ResidentPolicy>, usize, u64),
}

fn oldest_ready(
    entries: &HashMap<(u64, String), Entry>,
    except: Option<&(u64, String)>,
) -> Option<(u64, String)> {
    entries
        .iter()
        .filter_map(|(key, entry)| match entry {
            Entry::Ready(_, _, stamp) if except != Some(key) => Some((key, stamp)),
            _ => None,
        })
        .min_by_key(|(_, stamp)| *stamp)
        .map(|(key, _)| key.clone())
}

pub(crate) struct Lease<'a> {
    owner: &'a ResidentHooks,
    key: (u64, String),
    pub cold: bool,
    pub state: ResidentPolicy,
}

impl ResidentHooks {
    pub(crate) fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub(crate) fn is_building(&self, instance: u64, key: &Key) -> bool {
        self.enabled
            && matches!(
                self.entries
                    .lock()
                    .expect("resident lock")
                    .get(&(instance, key.store_key().conversation_key())),
                Some(Entry::Building(_))
            )
    }
    pub(crate) fn enabled(enabled: bool) -> Self {
        Self {
            enabled,
            ..Self::default()
        }
    }
    pub(crate) fn with_process_cap(mut self, bytes: usize) -> Self {
        self.process_cap = bytes.min(PROCESS_CAP);
        self
    }

    /// Copy a current decoded tail without taking a serving lease. A missing,
    /// leased or stale entry falls back to native range pages, never a rebuild.
    pub(crate) fn historian_tail(
        &self,
        store: &mc_store::McStore,
        key: &Key,
        lineage: &str,
        first: u64,
        through: u64,
    ) -> Option<Vec<crate::ck_wire::CkIngressMessage>> {
        if !self.enabled {
            return None;
        }
        let version = store.provider_external_data_version().ok()?;
        let entries = self.entries.lock().expect("resident lock");
        let Entry::Ready(state, _, _) = entries.get(&(
            store.tag_cache_namespace(),
            key.store_key().conversation_key(),
        ))?
        else {
            return None;
        };
        let working = state.fold_working.as_ref()?;
        if state.fold_lineage.as_deref() != Some(lineage)
            || state.fold_data_version != Some(version)
            || state.fold_source_raced
            || working.key.newest != Some(through)
            || first <= working.key.through
        {
            return None;
        }
        let messages: Vec<_> = working
            .messages
            .iter()
            .filter(|message| message.ordinal >= first && message.ordinal <= through)
            .cloned()
            .collect();
        // An incomplete tail cannot substitute for the admitted raw range.
        if messages.first().map(|m| m.ordinal) != Some(first)
            || messages.last().map(|m| m.ordinal) != Some(through)
            || messages
                .windows(2)
                .any(|w| w[1].ordinal != w[0].ordinal.saturating_add(1))
        {
            return None;
        }
        Some(messages)
    }

    pub(crate) fn begin(
        &self,
        instance: u64,
        key: &Key,
    ) -> Result<Option<Lease<'_>>, &'static str> {
        if !self.enabled {
            return Ok(None);
        }
        let key = (instance, key.store_key().conversation_key());
        if key.1.len() > SESSION_CAP / 4 || self.process_cap < SESSION_CAP {
            return Ok(None);
        }
        let mut entries = self.entries.lock().expect("resident lock");
        if matches!(entries.get(&key), Some(Entry::Building(_))) {
            return Err("resident_not_ready: session rebuild or admission in progress");
        }
        if entries.len() >= SESSION_SLOTS && !entries.contains_key(&key) {
            if let Some(old) = oldest_ready(&entries, None) {
                entries.remove(&old);
                #[cfg(test)]
                self.evictions.fetch_add(1, Ordering::Relaxed);
            } else {
                return Ok(None);
            }
        }
        let charge = |entry: &Entry| match entry {
            Entry::Ready(_, bytes, _) | Entry::Building(bytes) => *bytes,
        };
        let existing = entries.get(&key).map_or(0, charge);
        while entries.values().map(charge).sum::<usize>() - existing + SESSION_CAP
            > self.process_cap
        {
            if let Some(old) = oldest_ready(&entries, Some(&key)) {
                entries.remove(&old);
                #[cfg(test)]
                self.evictions.fetch_add(1, Ordering::Relaxed);
            } else {
                return Ok(None);
            }
        }
        let (cold, state) = match entries.insert(key.clone(), Entry::Building(SESSION_CAP)) {
            Some(Entry::Ready(state, _, _)) => (false, *state),
            _ => (true, ResidentPolicy::default()),
        };
        #[cfg(test)]
        self.peak_building.fetch_max(
            entries
                .values()
                .filter(|entry| matches!(entry, Entry::Building(_)))
                .count() as u64,
            Ordering::Relaxed,
        );
        Ok(Some(Lease {
            owner: self,
            key,
            cold,
            state,
        }))
    }

    #[cfg(test)]
    pub(crate) fn session_stats(&self, instance: u64, key: &Key) -> serde_json::Value {
        let entries = self.entries.lock().expect("resident lock");
        match entries.get(&(instance, key.store_key().conversation_key())) {
            Some(Entry::Ready(state, _, _)) => {
                serde_json::json!({"ready":true,"rebuilt_parts":state.rebuilt_parts})
            }
            _ => serde_json::json!({"ready":false}),
        }
    }

    #[cfg(test)]
    pub(crate) fn stats(&self) -> serde_json::Value {
        let entries = self.entries.lock().expect("resident lock");
        serde_json::json!({"sessions":entries.len(),"charged_bytes":entries.values().map(|entry| match entry { Entry::Ready(_,bytes,_)|Entry::Building(bytes)=>*bytes }).sum::<usize>(),"rebuilt_parts":entries.values().map(|entry| match entry { Entry::Ready(state,_,_)=>state.rebuilt_parts,_=>0 }).sum::<usize>(),"session_cap":SESSION_CAP,"process_cap":self.process_cap,"slot_cap":SESSION_SLOTS,
            "evictions":self.evictions.load(Ordering::Relaxed),"oversize_discards":self.oversize_discards.load(Ordering::Relaxed),
            "peak_building":self.peak_building.load(Ordering::Relaxed),
            "eviction_order":"least recently published ready lease",
            "containers":entries.iter().filter_map(|(key,entry)| match entry {
                Entry::Ready(state,bytes,stamp)=>Some(serde_json::json!({"conversation":key.1,"charged_bytes":bytes,"recency":stamp,
                    "store_instance":key.0,
                    "output_cache":state.fold_output.lock().expect("fold output cache").resident_retained_bytes(),
                    "hygiene":state.fold_hygiene.lock().expect("fold hygiene memo").retained_bytes(),
                    "working":state.fold_working.as_ref().map(|working|working.charges()),
                    "views":state.fold_view.as_ref().map_or(0,|view|view.retained_bytes()-std::mem::size_of::<super::resident_view::ResidentView>()),
                    "byte_arena":state.fold_arena.retained_bytes()-std::mem::size_of::<super::resident_bytes::ByteArena>(),
                    "tier_fragments":0,"memory_fragments":0,"decoded_recipe_originals":0,"tail_passes":state.fold_tail_passes})),
                _=>None,
            }).collect::<Vec<_>>()})
    }

    #[cfg(test)]
    pub(crate) fn load_for_test(
        &self,
        store: &mc_store::McStore,
        key: &mc_store::ProviderSessionKey,
    ) {
        let resident_key = Key {
            project: key.project_root.clone().into(),
            session: key.session.clone(),
            harness: key.harness.clone(),
            generation: key.generation.clone(),
        };
        let mut lease = self
            .begin(store.tag_cache_namespace(), &resident_key)
            .unwrap()
            .unwrap();
        lease.state = store
            .read_provider_resident_policy(key, |index, counters| {
                ResidentPolicy::rebuild(index, counters, 0, &Default::default())
            })
            .unwrap();
        lease.publish();
    }
}

impl Lease<'_> {
    pub(crate) fn publish(self) {
        let bytes =
            self.state.retained_bytes() + self.key.1.capacity() + std::mem::size_of::<Entry>();
        let mut entries = self.owner.entries.lock().expect("resident lock");
        if bytes <= SESSION_CAP {
            while entries
                .values()
                .map(|entry| match entry {
                    Entry::Ready(_, bytes, _) | Entry::Building(bytes) => *bytes,
                })
                .sum::<usize>()
                - SESSION_CAP
                + bytes
                > self.owner.process_cap
            {
                let old = oldest_ready(&entries, None);
                if let Some(old) = old {
                    entries.remove(&old);
                    #[cfg(test)]
                    self.owner.evictions.fetch_add(1, Ordering::Relaxed);
                } else {
                    break;
                }
            }
            // Replace the busy reservation with policy derived from committed
            // rows. Drop removes the reservation when a read or write fails.
            let mut lease = self;
            entries.insert(
                lease.key.clone(),
                Entry::Ready(
                    Box::new(std::mem::take(&mut lease.state)),
                    bytes,
                    lease.owner.clock.fetch_add(1, Ordering::Relaxed),
                ),
            );
            drop(entries);
        } else {
            #[cfg(test)]
            self.owner.oversize_discards.fetch_add(1, Ordering::Relaxed);
        }
    }
}

impl Drop for Lease<'_> {
    fn drop(&mut self) {
        let mut entries = self.owner.entries.lock().expect("resident lock");
        if matches!(entries.get(&self.key), Some(Entry::Building(_))) {
            entries.remove(&self.key);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn key(session: &str) -> Key {
        Key {
            project: "/fixture".into(),
            session: session.into(),
            harness: "opencode".into(),
            generation: None,
        }
    }

    #[test]
    fn rebuilding_session_refuses_retryably_and_failed_admission_discards_state() {
        let resident = ResidentHooks::enabled(true);
        let lease = resident.begin(1, &key("s")).unwrap().unwrap();
        assert!(lease.cold);
        assert!(resident
            .begin(1, &key("s"))
            .err()
            .unwrap()
            .starts_with("resident_not_ready:"));
        drop(lease);
        assert!(resident.begin(1, &key("s")).unwrap().unwrap().cold);
    }

    #[test]
    fn resident_reuses_committed_state_but_not_a_reopened_store_instance() {
        let resident = ResidentHooks::enabled(true);
        resident.begin(1, &key("s")).unwrap().unwrap().publish();
        let lease = resident.begin(1, &key("s")).unwrap().unwrap();
        assert!(!lease.cold);
        drop(lease);
        assert!(resident.begin(2, &key("s")).unwrap().unwrap().cold);
    }

    #[test]
    fn resident_caps_include_in_flight_leases_and_evict_idle_sessions() {
        let resident = ResidentHooks::enabled(true);
        let mut active = Vec::new();
        for n in 0..PROCESS_CAP / SESSION_CAP {
            active.push(resident.begin(1, &key(&n.to_string())).unwrap().unwrap());
        }
        assert_eq!(resident.stats()["charged_bytes"], PROCESS_CAP);
        assert!(
            resident.begin(1, &key("extra")).unwrap().is_none(),
            "unavailable capacity uses the non-resident path"
        );
        drop(active);
        for n in 0..SESSION_SLOTS + 1 {
            resident
                .begin(1, &key(&n.to_string()))
                .unwrap()
                .unwrap()
                .publish();
        }
        assert_eq!(resident.stats()["sessions"], SESSION_SLOTS);
        assert!(resident.stats()["charged_bytes"].as_u64().unwrap() <= PROCESS_CAP as u64);
    }

    #[test]
    fn lowered_64_mib_pool_keeps_the_same_ready_lease_eviction_control() {
        let resident = ResidentHooks::enabled(true).with_process_cap(64 * 1024 * 1024);
        resident.begin(1, &key("first")).unwrap().unwrap().publish();
        resident
            .begin(1, &key("second"))
            .unwrap()
            .unwrap()
            .publish();
        assert_eq!(resident.stats()["sessions"], 1);
        assert!(resident.begin(1, &key("first")).unwrap().unwrap().cold);
        let small = ResidentHooks::enabled(true).with_process_cap(1024 * 1024);
        assert!(small.begin(1, &key("normal-fallback")).unwrap().is_none());
    }
}
