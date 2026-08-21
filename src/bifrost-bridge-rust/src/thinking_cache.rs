//! Turn-scoped cache of Claude thinking blocks, keyed by tool_use id.
//!
//! Anthropic's thinking contract requires clients to echo an assistant turn's
//! thinking blocks back, complete and unmodified, alongside the `tool_use`
//! blocks when returning tool results. OWUI-originated traffic reaches this
//! bridge in OpenAI chat format, which has no channel for signed thinking
//! blocks — so follow-up rounds arrive with the thinking stripped and the
//! model silently degrades (repeats searches, re-derives findings; see the
//! April 2026 Anthropic Claude Code postmortem for the same failure class).
//!
//! The bridge terminates both ends of the loop: it *produces* the thinking
//! blocks when translating Bedrock responses, and it *receives* the follow-up
//! in Anthropic form at /internal/anthropic. This cache stashes each turn's
//! thinking blocks keyed by the tool_use ids they preceded; the request path
//! splices them back in front of the matching `tool_use` blocks when a
//! follow-up arrives without thinking. Signatures never leave the bridge.
//!
//! Eviction is lazy (on insert/lookup) — no timers or background tasks
//! (CLAUDE.md hot-path rule). A bridge restart mid-loop degrades to today's
//! behavior (splice miss, never an error).

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;

pub const DEFAULT_CAPACITY: usize = 4096;
pub const DEFAULT_TTL_SECONDS: u64 = 7200;

#[derive(Debug, Clone)]
struct CacheEntry {
    model: String,
    blocks: Vec<Value>,
    inserted_at: Instant,
}

#[derive(Debug, Default)]
struct CacheInner {
    map: HashMap<String, CacheEntry>,
    order: VecDeque<String>,
}

#[derive(Debug)]
pub struct ThinkingCache {
    inner: Mutex<CacheInner>,
    capacity: usize,
    ttl: Duration,
}

impl ThinkingCache {
    pub fn new(capacity: usize, ttl: Duration) -> Self {
        Self {
            inner: Mutex::new(CacheInner::default()),
            capacity: capacity.max(1),
            ttl,
        }
    }

    pub fn from_env() -> Self {
        let capacity = std::env::var("BRIDGE_CLAUDE_THINKING_CACHE_CAPACITY")
            .ok()
            .and_then(|value| value.trim().parse::<usize>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(DEFAULT_CAPACITY);
        let ttl_seconds = std::env::var("BRIDGE_CLAUDE_THINKING_CACHE_TTL_SECONDS")
            .ok()
            .and_then(|value| value.trim().parse::<u64>().ok())
            .unwrap_or(DEFAULT_TTL_SECONDS);
        Self::new(capacity, Duration::from_secs(ttl_seconds))
    }

    /// Stash one completed assistant turn: for each tool_use id, the ordered
    /// thinking/redacted_thinking blocks that preceded it within the turn
    /// (possibly empty — adaptive thinking can skip a round). Ids sharing a
    /// turn are inserted independently so multi-round accumulation is
    /// emergent: every follow-up carries all prior rounds' tool_use ids and
    /// each id resolves on its own.
    pub fn insert_turn(&self, model: &str, groups: Vec<(String, Vec<Value>)>) {
        if model.is_empty() {
            return;
        }
        let mut inner = match self.inner.lock() {
            Ok(inner) => inner,
            Err(poisoned) => poisoned.into_inner(),
        };
        let now = Instant::now();
        for (tool_use_id, blocks) in groups {
            if tool_use_id.is_empty() {
                continue;
            }
            if inner.map.remove(&tool_use_id).is_some() {
                inner.order.retain(|key| key != &tool_use_id);
            }
            inner.map.insert(
                tool_use_id.clone(),
                CacheEntry {
                    model: model.to_string(),
                    blocks,
                    inserted_at: now,
                },
            );
            inner.order.push_back(tool_use_id);
        }
        Self::evict(&mut inner, self.capacity, self.ttl, now);
    }

    /// Fetch the thinking blocks stashed for a tool_use id, when the entry
    /// belongs to the same model. Refreshes LRU recency; entries are NOT
    /// consumed — every round of a loop replays all prior tool_use ids.
    pub fn lookup(&self, tool_use_id: &str, model: &str) -> Option<Vec<Value>> {
        let mut inner = match self.inner.lock() {
            Ok(inner) => inner,
            Err(poisoned) => poisoned.into_inner(),
        };
        let now = Instant::now();
        let expired = matches!(
            inner.map.get(tool_use_id),
            Some(entry) if now.duration_since(entry.inserted_at) > self.ttl
        );
        if expired {
            inner.map.remove(tool_use_id);
            inner.order.retain(|key| key != tool_use_id);
            return None;
        }
        let blocks = {
            let entry = inner.map.get(tool_use_id)?;
            if entry.model != model {
                return None;
            }
            entry.blocks.clone()
        };
        inner.order.retain(|key| key != tool_use_id);
        inner.order.push_back(tool_use_id.to_string());
        Some(blocks)
    }

    pub fn len(&self) -> usize {
        match self.inner.lock() {
            Ok(inner) => inner.map.len(),
            Err(poisoned) => poisoned.into_inner().map.len(),
        }
    }

    fn evict(inner: &mut CacheInner, capacity: usize, ttl: Duration, now: Instant) {
        let expired: Vec<String> = inner
            .map
            .iter()
            .filter(|(_, entry)| now.duration_since(entry.inserted_at) > ttl)
            .map(|(key, _)| key.clone())
            .collect();
        for key in expired {
            inner.map.remove(&key);
            inner.order.retain(|candidate| candidate != &key);
        }
        while inner.map.len() > capacity {
            let Some(oldest) = inner.order.pop_front() else {
                break;
            };
            inner.map.remove(&oldest);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn thinking_block(text: &str, signature: &str) -> Value {
        json!({"type":"thinking","thinking": text, "signature": signature})
    }

    #[test]
    fn lookup_returns_blocks_for_matching_model_only() {
        let cache = ThinkingCache::new(16, Duration::from_secs(60));
        cache.insert_turn(
            "us.anthropic.claude-opus-5",
            vec![("toolu_1".to_string(), vec![thinking_block("t", "sig")])],
        );
        assert_eq!(
            cache.lookup("toolu_1", "us.anthropic.claude-opus-5"),
            Some(vec![thinking_block("t", "sig")])
        );
        // A-R4: model mismatch never splices another model's thinking.
        assert_eq!(cache.lookup("toolu_1", "us.anthropic.claude-sonnet-5"), None);
        assert_eq!(cache.lookup("toolu_missing", "us.anthropic.claude-opus-5"), None);
    }

    #[test]
    fn empty_text_signed_blocks_round_trip_verbatim() {
        // A-R5: display "summarized"/"omitted" can yield signature-only blocks.
        let cache = ThinkingCache::new(16, Duration::from_secs(60));
        let block = thinking_block("", "sig-only");
        cache.insert_turn("m", vec![("toolu_1".to_string(), vec![block.clone()])]);
        assert_eq!(cache.lookup("toolu_1", "m"), Some(vec![block]));
    }

    #[test]
    fn entries_expire_after_ttl() {
        let cache = ThinkingCache::new(16, Duration::ZERO);
        cache.insert_turn("m", vec![("toolu_1".to_string(), vec![thinking_block("t", "s")])]);
        assert_eq!(cache.lookup("toolu_1", "m"), None);
        assert_eq!(cache.len(), 0);
    }

    #[test]
    fn capacity_evicts_least_recently_used() {
        // A-R7: lazy LRU eviction, no timers.
        let cache = ThinkingCache::new(2, Duration::from_secs(60));
        cache.insert_turn("m", vec![("toolu_a".to_string(), vec![])]);
        cache.insert_turn("m", vec![("toolu_b".to_string(), vec![])]);
        assert!(cache.lookup("toolu_a", "m").is_some()); // touch a
        cache.insert_turn("m", vec![("toolu_c".to_string(), vec![])]);
        assert_eq!(cache.len(), 2);
        assert!(cache.lookup("toolu_a", "m").is_some());
        assert!(cache.lookup("toolu_b", "m").is_none());
        assert!(cache.lookup("toolu_c", "m").is_some());
    }

    #[test]
    fn multi_round_groups_resolve_independently() {
        // A-R3: a miss on one round degrades only that round.
        let cache = ThinkingCache::new(16, Duration::from_secs(60));
        cache.insert_turn(
            "m",
            vec![
                ("toolu_r1".to_string(), vec![thinking_block("round1", "s1")]),
                ("toolu_r1b".to_string(), vec![]),
            ],
        );
        cache.insert_turn(
            "m",
            vec![("toolu_r2".to_string(), vec![thinking_block("round2", "s2")])],
        );
        assert_eq!(cache.lookup("toolu_r1", "m").unwrap().len(), 1);
        assert_eq!(cache.lookup("toolu_r1b", "m").unwrap().len(), 0);
        assert_eq!(cache.lookup("toolu_r2", "m").unwrap().len(), 1);
        assert!(cache.lookup("toolu_r3_evicted", "m").is_none());
    }
}
