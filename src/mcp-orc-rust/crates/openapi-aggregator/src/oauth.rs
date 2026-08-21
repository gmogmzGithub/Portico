use std::collections::HashSet;

use log::debug;
use serde_json::{json, Value};

use crate::config::{server_endpoint, SharedState};

pub async fn fetch_oauth_status(state: &SharedState, server_id: &str) -> Option<Value> {
    let (host, port) = server_endpoint(state.config(), server_id);
    let url = format!("http://{host}:{port}/oauth/status");

    match state
        .0
        .client
        .get(&url)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => response.json::<Value>().await.ok(),
        Ok(response) => {
            debug!(
                "OAuth status not ready for {server_id}: HTTP {}",
                response.status()
            );
            None
        }
        Err(error) => {
            debug!("OAuth status not ready for {server_id}: {error}");
            state
                .log_oauth(
                    "DEBUG",
                    &format!("OAuth status not ready for {server_id}: {error}"),
                    "Aggregator",
                )
                .await;
            None
        }
    }
}

pub fn merge_oauth_statuses(statuses: &[(String, Option<Value>)]) -> Value {
    let active_states: HashSet<&str> = ["active", "waiting_callback", "pending", "checking"]
        .into_iter()
        .collect();
    let mut active = Vec::new();
    let mut pending = Vec::new();
    let mut checking = Vec::new();
    let mut waiting_callback = Vec::new();
    let mut completed = Vec::new();
    let mut failed = Vec::new();
    let mut current: Option<Value> = None;
    let mut servers_responding = 0usize;

    for (server_id, status) in statuses {
        let Some(status) = status.as_ref() else {
            continue;
        };

        servers_responding += 1;

        if let Some(current_object) = status.get("current").and_then(Value::as_object) {
            let mut current_item = current_object.clone();
            current_item.insert(
                "_source_container".to_string(),
                Value::String(server_id.clone()),
            );
            let state = current_item
                .get("state")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_ascii_lowercase();
            if active_states.contains(state.as_str()) {
                let value = Value::Object(current_item.clone());
                if current.is_none() {
                    current = Some(value.clone());
                }
                active.push(value);
            }
        }

        for (key, target) in [
            ("pending", &mut pending),
            ("checking", &mut checking),
            ("waiting_callback", &mut waiting_callback),
            ("completed", &mut completed),
            ("failed", &mut failed),
        ] {
            if let Some(items) = status.get(key).and_then(Value::as_array) {
                for item in items {
                    if let Some(object) = item.as_object() {
                        let mut enriched = object.clone();
                        enriched.insert(
                            "_source_container".to_string(),
                            Value::String(server_id.clone()),
                        );
                        target.push(Value::Object(enriched));
                    }
                }
            }
        }
    }

    json!({
        "current": current.unwrap_or(Value::Null),
        "active": active,
        "pending": pending,
        "checking": checking,
        "waiting_callback": waiting_callback,
        "completed": completed,
        "failed": failed,
        "servers_queried": statuses.len(),
        "servers_responding": servers_responding,
    })
}

pub async fn fetch_oauth_current(state: &SharedState, server_id: &str) -> Option<Value> {
    let (host, port) = server_endpoint(state.config(), server_id);
    let url = format!("http://{host}:{port}/oauth/current");

    match state
        .0
        .client
        .get(&url)
        .timeout(std::time::Duration::from_secs(10))
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => {
            let payload = response.json::<Value>().await.ok()?;
            let mut current = payload.get("current")?.clone();
            if let Some(object) = current.as_object_mut() {
                object.insert(
                    "_source_container".to_string(),
                    Value::String(server_id.to_string()),
                );
            }
            Some(current)
        }
        Ok(response) => {
            debug!(
                "No OAuth current from {server_id}: HTTP {}",
                response.status()
            );
            None
        }
        Err(error) => {
            debug!("Error fetching OAuth current from {server_id}: {error}");
            None
        }
    }
}
