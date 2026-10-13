//! Each hook temporarily owns its session's cached policy while the store writes
//! the new message and answer. A failed write discards that cache, so a later
//! hook cannot use totals containing a message the database never committed.
use super::{policy_summary::ResidentPolicy, records::Key};
use std::{collections::HashMap, sync::Mutex};

pub(crate) const SESSION_CAP: usize = 2 * 1024 * 1024;
pub(crate) const PROCESS_CAP: usize = 64 * 1024 * 1024;
const SESSION_SLOTS: usize = 1024;

#[derive(Default)]
pub(crate) struct ResidentHooks {
    enabled: bool,
    entries: Mutex<HashMap<(u64, String), Entry>>,
}

enum Entry {
    Building(usize),
    Ready(Box<ResidentPolicy>, usize),
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

    pub(crate) fn begin(
        &self,
        instance: u64,
        key: &Key,
    ) -> Result<Option<Lease<'_>>, &'static str> {
        if !self.enabled {
            return Ok(None);
        }
        let key = (instance, key.store_key().conversation_key());
        if key.1.len() > SESSION_CAP / 4 {
            return Err("resident_not_ready: session key exceeds resident cap");
        }
        let mut entries = self.entries.lock().expect("resident lock");
        if matches!(entries.get(&key), Some(Entry::Building(_))) {
            return Err("resident_not_ready: session rebuild or admission in progress");
        }
        if entries.len() >= SESSION_SLOTS && !entries.contains_key(&key) {
            if let Some(old) = entries
                .iter()
                .find_map(|(key, entry)| matches!(entry, Entry::Ready(..)).then_some(key.clone()))
            {
                entries.remove(&old);
            } else {
                return Err("resident_not_ready: resident session slots exhausted");
            }
        }
        let charge = |entry: &Entry| match entry {
            Entry::Ready(_, bytes) | Entry::Building(bytes) => *bytes,
        };
        let existing = entries.get(&key).map_or(0, charge);
        while entries.values().map(charge).sum::<usize>() - existing + SESSION_CAP > PROCESS_CAP {
            if let Some(old) = entries.iter().find_map(|(old, entry)| {
                (old != &key && matches!(entry, Entry::Ready(..))).then_some(old.clone())
            }) {
                entries.remove(&old);
            } else {
                return Err("resident_not_ready: process resident cap exhausted");
            }
        }
        let (cold, state) = match entries.insert(key.clone(), Entry::Building(SESSION_CAP)) {
            Some(Entry::Ready(state, _)) => (false, *state),
            _ => (true, ResidentPolicy::default()),
        };
        Ok(Some(Lease {
            owner: self,
            key,
            cold,
            state,
        }))
    }

    #[cfg(test)]
    pub(crate) fn stats(&self) -> serde_json::Value {
        let entries = self.entries.lock().expect("resident lock");
        serde_json::json!({"sessions":entries.len(),"charged_bytes":entries.values().map(|entry| match entry { Entry::Ready(_,bytes)|Entry::Building(bytes)=>*bytes }).sum::<usize>(),"rebuilt_parts":entries.values().map(|entry| match entry { Entry::Ready(state,_)=>state.rebuilt_parts,_=>0 }).sum::<usize>(),"session_cap":SESSION_CAP,"process_cap":PROCESS_CAP})
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
                    Entry::Ready(_, bytes) | Entry::Building(bytes) => *bytes,
                })
                .sum::<usize>()
                - SESSION_CAP
                + bytes
                > PROCESS_CAP
            {
                let old = entries.iter().find_map(|(key, entry)| {
                    matches!(entry, Entry::Ready(..)).then_some(key.clone())
                });
                if let Some(old) = old {
                    entries.remove(&old);
                } else {
                    break;
                }
            }
            // Replace the busy reservation with policy derived from committed
            // rows. Drop removes the reservation when a read or write fails.
            let mut lease = self;
            entries.insert(
                lease.key.clone(),
                Entry::Ready(Box::new(std::mem::take(&mut lease.state)), bytes),
            );
            drop(entries);
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
        assert!(resident.begin(1, &key("extra")).is_err());
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
}
