use serde_json::{Map, Value};

use crate::catalog::{ModelEntry, ProviderKind};

const PER_MILLION: f64 = 1_000_000.0;

#[derive(Clone, Copy)]
struct PriceSpec {
    prompt_cost: f64,
    completion_cost: f64,
    cache_read_cost: Option<f64>,
    cache_write_cost: Option<f64>,
    high_context: Option<HighContextPriceSpec>,
}

#[derive(Clone, Copy)]
struct HighContextPriceSpec {
    threshold_prompt_tokens: i64,
    prompt_cost: f64,
    completion_cost: f64,
    cache_read_cost: Option<f64>,
    cache_write_cost: Option<f64>,
}

fn round_cost(value: f64) -> f64 {
    (value * 100_000.0).round() / 100_000.0
}

fn usage_int(value: Option<&Value>) -> i64 {
    value.and_then(Value::as_i64).unwrap_or(0)
}

fn detail_int(details: Option<&Map<String, Value>>, keys: &[&str]) -> i64 {
    for key in keys {
        let value = usage_int(details.and_then(|map| map.get(*key)));
        if value > 0 {
            return value;
        }
    }
    0
}

fn cache_read_tokens(usage: &Map<String, Value>) -> i64 {
    let prompt_details = usage
        .get("prompt_tokens_details")
        .and_then(Value::as_object);
    let explicit_read = usage_int(usage.get("cachedContentTokenCount"))
        .max(usage_int(usage.get("cached_content_token_count")))
        .max(detail_int(
            prompt_details,
            &[
                "cachedContentTokenCount",
                "cached_content_token_count",
                "cached_read_tokens",
                "cache_read_input_tokens",
                "cache_read_tokens",
            ],
        ));
    if explicit_read > 0 {
        return explicit_read;
    }
    // The generic `cached_tokens` fields are ambiguous: Bifrost's converse
    // translation reports cache WRITE totals through them, and pricing those
    // tokens again at the read rate double-bills the written prefix. Only
    // trust the generic fields when no explicit write count is present.
    if cache_write_tokens(usage) > 0 {
        return 0;
    }
    usage_int(usage.get("cached_tokens")).max(detail_int(prompt_details, &["cached_tokens"]))
}

fn cache_write_tokens(usage: &Map<String, Value>) -> i64 {
    let prompt_details = usage
        .get("prompt_tokens_details")
        .and_then(Value::as_object);
    usage_int(usage.get("cache_creation_input_tokens"))
        .max(usage_int(usage.get("cache_write_input_tokens")))
        .max(detail_int(
            prompt_details,
            &[
                "cache_creation_input_tokens",
                "cached_write_tokens",
                "cache_write_tokens",
                "cache_write_input_tokens",
            ],
        ))
}

// GPT-5.6 values are OpenAI list rates per million tokens, live-validated on
// 2026-07-10 against uncached, cache-write, cache-read, and high-context
// Responses usage cost headers. These are literal observed rates; no discount
// multiplier is applied. Legacy entries retain their established list rates.
// Must match model-pricing.js exactly.
fn price_spec(entry: &ModelEntry) -> Option<PriceSpec> {
    match entry.provider_kind {
        ProviderKind::OpenAI => match entry.base_model.as_str() {
            "gpt-5.6-sol" | "gpt-5.6-sol-pro" => Some(PriceSpec {
                prompt_cost: 4.25,
                completion_cost: 25.50,
                cache_read_cost: Some(0.425),
                cache_write_cost: Some(5.3125),
                high_context: Some(HighContextPriceSpec {
                    threshold_prompt_tokens: 272_000,
                    prompt_cost: 8.50,
                    completion_cost: 38.25,
                    cache_read_cost: Some(0.85),
                    cache_write_cost: Some(10.625),
                }),
            }),
            "gpt-5.6-terra" => Some(PriceSpec {
                prompt_cost: 2.125,
                completion_cost: 12.75,
                cache_read_cost: Some(0.2125),
                cache_write_cost: Some(2.65625),
                high_context: Some(HighContextPriceSpec {
                    threshold_prompt_tokens: 272_000,
                    prompt_cost: 4.25,
                    completion_cost: 19.125,
                    cache_read_cost: Some(0.425),
                    cache_write_cost: Some(5.3125),
                }),
            }),
            "gpt-5.6-luna" => Some(PriceSpec {
                prompt_cost: 0.85,
                completion_cost: 5.10,
                cache_read_cost: Some(0.085),
                cache_write_cost: Some(1.0625),
                high_context: Some(HighContextPriceSpec {
                    threshold_prompt_tokens: 272_000,
                    prompt_cost: 1.70,
                    completion_cost: 7.65,
                    cache_read_cost: Some(0.17),
                    cache_write_cost: Some(2.125),
                }),
            }),
            "gpt-5.5" => Some(PriceSpec {
                prompt_cost: 5.0,
                completion_cost: 30.0,
                cache_read_cost: Some(0.5),
                cache_write_cost: None,
                high_context: None,
            }),
            "gpt-5.4" => Some(PriceSpec {
                prompt_cost: 2.5,
                completion_cost: 15.0,
                cache_read_cost: Some(0.25),
                cache_write_cost: None,
                high_context: None,
            }),
            "gpt-5.4-pro" => Some(PriceSpec {
                prompt_cost: 30.0,
                completion_cost: 180.0,
                cache_read_cost: None,
                cache_write_cost: None,
                high_context: None,
            }),
            "gpt-4.1" => Some(PriceSpec {
                prompt_cost: 2.0,
                completion_cost: 8.0,
                cache_read_cost: Some(0.5),
                cache_write_cost: None,
                high_context: None,
            }),
            "gpt-4.1-mini" => Some(PriceSpec {
                prompt_cost: 0.4,
                completion_cost: 1.6,
                cache_read_cost: Some(0.1),
                cache_write_cost: None,
                high_context: None,
            }),
            "gpt-4.1-nano" => Some(PriceSpec {
                prompt_cost: 0.1,
                completion_cost: 0.4,
                cache_read_cost: Some(0.025),
                cache_write_cost: None,
                high_context: None,
            }),
            _ => None,
        },
        ProviderKind::AnthropicConverse => match entry.base_model.as_str() {
            "us.anthropic.claude-haiku-4-5-20251001-v1:0" => Some(PriceSpec {
                prompt_cost: 1.0,
                completion_cost: 5.0,
                cache_read_cost: Some(0.1),
                cache_write_cost: Some(1.25),
                high_context: None,
            }),
            "us.anthropic.claude-sonnet-5"
            | "us.anthropic.claude-sonnet-5:0"
            | "us.anthropic.claude-sonnet-4-6"
            | "us.anthropic.claude-sonnet-4-6:0" => Some(PriceSpec {
                prompt_cost: 3.0,
                completion_cost: 15.0,
                cache_read_cost: Some(0.3),
                cache_write_cost: Some(3.75),
                high_context: None,
            }),
            // Opus 5 and Opus 4.8 run with claude_prompt_cache_ttl: "1h",
            // whose true write rate is 2x ($10/MTok); the 1.25x figure (6.25)
            // is kept deliberately so this table matches model-pricing.js
            // exactly (see the contract comment above price_spec).
            "us.anthropic.claude-opus-5"
            | "us.anthropic.claude-opus-5:0"
            | "us.anthropic.claude-opus-4-8"
            | "us.anthropic.claude-opus-4-8-v1"
            | "us.anthropic.claude-opus-4-8-v1:0"
            | "us.anthropic.claude-opus-4-7"
            | "us.anthropic.claude-opus-4-7-v1"
            | "us.anthropic.claude-opus-4-7-v1:0"
            | "us.anthropic.claude-opus-4-6-v1"
            | "us.anthropic.claude-opus-4-6-v1:0" => Some(PriceSpec {
                prompt_cost: 5.0,
                completion_cost: 25.0,
                cache_read_cost: Some(0.5),
                cache_write_cost: Some(6.25),
                high_context: None,
            }),
            _ => None,
        },
        ProviderKind::GeminiVertex => match entry.base_model.as_str() {
            "gemini-3.6-flash" => Some(PriceSpec {
                prompt_cost: 2.70,
                completion_cost: 13.50,
                cache_read_cost: Some(0.27),
                cache_write_cost: None,
                high_context: None,
            }),
            "gemini-3.5-flash" => Some(PriceSpec {
                prompt_cost: 2.70,
                completion_cost: 16.20,
                cache_read_cost: Some(0.27),
                cache_write_cost: None,
                high_context: None,
            }),
            "gemini-3.1-pro-preview" => Some(PriceSpec {
                prompt_cost: 3.60,
                completion_cost: 21.60,
                cache_read_cost: Some(0.36),
                cache_write_cost: None,
                high_context: Some(HighContextPriceSpec {
                    threshold_prompt_tokens: 200_000,
                    prompt_cost: 7.20,
                    completion_cost: 32.40,
                    cache_read_cost: Some(0.72),
                    cache_write_cost: None,
                }),
            }),
            "gemini-3.5-flash-lite" => Some(PriceSpec {
                prompt_cost: 0.54,
                completion_cost: 4.50,
                cache_read_cost: Some(0.054),
                cache_write_cost: None,
                high_context: None,
            }),
            "gemini-3.1-flash-lite" => Some(PriceSpec {
                prompt_cost: 0.45,
                completion_cost: 2.70,
                cache_read_cost: Some(0.045),
                cache_write_cost: None,
                high_context: None,
            }),
            _ => None,
        },
    }
}

pub fn compute_usage_cost(entry: &ModelEntry, usage: &Map<String, Value>) -> Option<f64> {
    let spec = price_spec(entry)?;
    let prompt_tokens = usage_int(usage.get("prompt_tokens")).max(0);
    let completion_tokens = usage_int(usage.get("completion_tokens")).max(0);
    let cache_read = cache_read_tokens(usage).max(0).min(prompt_tokens);
    let cache_write = cache_write_tokens(usage).max(0).min(prompt_tokens);
    let non_cached_prompt_tokens = (prompt_tokens - cache_read - cache_write).max(0);
    let active_prompt_cost = spec
        .high_context
        .filter(|high_context| prompt_tokens > high_context.threshold_prompt_tokens)
        .map(|high_context| high_context.prompt_cost)
        .unwrap_or(spec.prompt_cost);
    let active_completion_cost = spec
        .high_context
        .filter(|high_context| prompt_tokens > high_context.threshold_prompt_tokens)
        .map(|high_context| high_context.completion_cost)
        .unwrap_or(spec.completion_cost);
    let active_cache_read_cost = spec
        .high_context
        .filter(|high_context| prompt_tokens > high_context.threshold_prompt_tokens)
        .and_then(|high_context| high_context.cache_read_cost)
        .or(spec.cache_read_cost);
    let active_cache_write_cost = spec
        .high_context
        .filter(|high_context| prompt_tokens > high_context.threshold_prompt_tokens)
        .and_then(|high_context| high_context.cache_write_cost)
        .or(spec.cache_write_cost);

    let prompt_cost = (non_cached_prompt_tokens as f64 / PER_MILLION) * active_prompt_cost;
    let completion_cost = (completion_tokens as f64 / PER_MILLION) * active_completion_cost;
    let cache_read_cost = active_cache_read_cost
        .map(|rate| (cache_read as f64 / PER_MILLION) * rate)
        .unwrap_or(0.0);
    let cache_write_cost = active_cache_write_cost
        .map(|rate| (cache_write as f64 / PER_MILLION) * rate)
        .unwrap_or(0.0);

    Some(round_cost(
        prompt_cost + completion_cost + cache_read_cost + cache_write_cost,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn openai_entry(model: &str) -> ModelEntry {
        ModelEntry {
            alias: model.to_string(),
            base_model: model.to_string(),
            provider_model: model.to_string(),
            bifrost_model: format!("openai/{model}"),
            provider_kind: ProviderKind::OpenAI,
            uses_responses_api: false,
            max_output_tokens: None,
            prompt_cache_retention: Some("24h".to_string()),
            claude_prompt_cache_ttl: None,
            tool_slimming: false,
        }
    }

    fn anthropic_entry(model: &str) -> ModelEntry {
        ModelEntry {
            alias: model.to_string(),
            base_model: model.to_string(),
            provider_model: model.to_string(),
            bifrost_model: format!("anthropic/{model}"),
            provider_kind: ProviderKind::AnthropicConverse,
            uses_responses_api: false,
            max_output_tokens: None,
            prompt_cache_retention: None,
            claude_prompt_cache_ttl: None,
            tool_slimming: false,
        }
    }

    fn gemini_entry(model: &str) -> ModelEntry {
        ModelEntry {
            alias: model.to_string(),
            base_model: model.to_string(),
            provider_model: model.to_string(),
            bifrost_model: format!("gemini/{model}"),
            provider_kind: ProviderKind::GeminiVertex,
            uses_responses_api: false,
            max_output_tokens: None,
            prompt_cache_retention: None,
            claude_prompt_cache_ttl: None,
            tool_slimming: false,
        }
    }

    #[test]
    fn helper_functions_cover_edge_cases() {
        assert_eq!(round_cost(0.123456), 0.12346);
        assert_eq!(usage_int(Some(&json!(42))), 42);
        assert_eq!(usage_int(Some(&json!("oops"))), 0);
        assert_eq!(usage_int(None), 0);

        let details = json!({
            "cached_read_tokens": 0,
            "cache_write_tokens": 12,
        });
        assert_eq!(
            detail_int(
                details.as_object(),
                &["cached_read_tokens", "cache_write_tokens"]
            ),
            12
        );
        assert_eq!(detail_int(None, &["cached_tokens"]), 0);
    }

    #[test]
    fn cache_read_tokens_prefers_largest_available_source() {
        let usage = json!({
            "cached_tokens": 100,
            "prompt_tokens_details": {
                "cachedContentTokenCount": 240,
                "cache_creation_input_tokens": 128
            }
        });
        assert_eq!(cache_read_tokens(usage.as_object().unwrap()), 240);
    }

    #[test]
    fn cache_write_tokens_extracts_creation_tokens() {
        let usage = json!({
            "prompt_tokens_details": {
                "cached_read_tokens": 240,
                "cache_creation_input_tokens": 128
            }
        });
        assert_eq!(cache_write_tokens(usage.as_object().unwrap()), 128);
    }

    #[test]
    fn cache_write_tokens_reads_top_level_anthropic_keys() {
        let usage = json!({ "cache_creation_input_tokens": 128 });
        assert_eq!(cache_write_tokens(usage.as_object().unwrap()), 128);

        let usage = json!({ "cache_write_input_tokens": 64 });
        assert_eq!(cache_write_tokens(usage.as_object().unwrap()), 64);
    }

    #[test]
    fn converse_cache_write_is_not_double_charged_as_cache_read() {
        // Bifrost's converse translation mirrors the WRITE total into the
        // generic `cached_tokens` fields; those tokens must not also be
        // priced at the cache-read rate.
        let usage = json!({
            "prompt_tokens": 100_000,
            "completion_tokens": 693,
            "cached_tokens": 99_998,
            "prompt_tokens_details": {
                "cached_tokens": 99_998,
                "cached_write_tokens": 99_998
            }
        });
        let usage = usage.as_object().unwrap();
        assert_eq!(cache_read_tokens(usage), 0);
        assert_eq!(cache_write_tokens(usage), 99_998);

        // Opus 5: non_cached=2, cost = 2/M*5.0 + 693/M*25.0 + 99_998/M*6.25
        //       = 0.00001 + 0.017325 + 0.62498750 = 0.6423225
        assert_eq!(
            compute_usage_cost(&anthropic_entry("us.anthropic.claude-opus-5"), usage),
            Some(0.64232)
        );
    }

    #[test]
    fn generic_cached_tokens_still_priced_as_read_without_writes() {
        let usage = json!({
            "prompt_tokens": 1000,
            "prompt_tokens_details": { "cached_tokens": 400 }
        });
        let usage = usage.as_object().unwrap();
        assert_eq!(cache_read_tokens(usage), 400);
        assert_eq!(cache_write_tokens(usage), 0);
    }

    #[test]
    fn explicit_read_keys_win_even_when_writes_present() {
        let usage = json!({
            "prompt_tokens_details": {
                "cache_read_input_tokens": 300,
                "cached_write_tokens": 500
            }
        });
        let usage = usage.as_object().unwrap();
        assert_eq!(cache_read_tokens(usage), 300);
        assert_eq!(cache_write_tokens(usage), 500);
    }

    #[test]
    fn cache_write_tokens_returns_zero_when_absent() {
        let usage = json!({
            "prompt_tokens": 1000,
            "prompt_tokens_details": {
                "cached_read_tokens": 240
            }
        });
        assert_eq!(cache_write_tokens(usage.as_object().unwrap()), 0);
    }

    // GPT-5.5: 1000 prompt (800 cache read), 200 completion
    // non_cached = 1000 - 800 = 200
    // cost = 200/M * 5.0 + 200/M * 30.0 + 800/M * 0.5
    //      = 0.001 + 0.006 + 0.0004 = 0.0074
    #[test]
    fn openai_cached_cost_uses_list_prices() {
        let entry = openai_entry("gpt-5.5");
        let usage = json!({
            "prompt_tokens": 1000,
            "completion_tokens": 200,
            "prompt_tokens_details": {
                "cached_read_tokens": 800
            }
        });
        assert_eq!(
            compute_usage_cost(&entry, usage.as_object().unwrap()),
            Some(0.0074)
        );
    }

    // GPT-5.4 pro: no cache pricing, prompt clamped to 0
    // cost = 0/M * 30.0 + 10/M * 180.0 = 0.0018
    #[test]
    fn openai_pro_cost_ignores_cache_pricing_and_clamps_inputs() {
        let entry = openai_entry("gpt-5.4-pro");
        let usage = json!({
            "prompt_tokens": -100,
            "completion_tokens": 10,
            "prompt_tokens_details": {
                "cached_read_tokens": 999
            }
        });
        assert_eq!(
            compute_usage_cost(&entry, usage.as_object().unwrap()),
            Some(0.0018)
        );
    }

    // Claude Haiku: 4000 prompt (3900 cache write), 100 completion
    // non_cached = 4000 - 0 (read) - 3900 (write) = 100
    // cost = 100/M * 1.0 + 100/M * 5.0 + 0 (read) + 3900/M * 1.25 (write)
    //      = 0.0001 + 0.0005 + 0.004875 = 0.005475
    #[test]
    fn anthropic_costs_support_separate_cache_read_write() {
        let entry = anthropic_entry("us.anthropic.claude-haiku-4-5-20251001-v1:0");
        let usage = json!({
            "prompt_tokens": 4000,
            "completion_tokens": 100,
            "prompt_tokens_details": {
                "cache_creation_input_tokens": 3900
            }
        });
        assert_eq!(
            compute_usage_cost(&entry, usage.as_object().unwrap()),
            Some(0.00548)
        );
    }

    // Shared usage: 1000 prompt (400 cache read), 200 completion
    #[test]
    fn price_spec_and_cost_cover_remaining_supported_models() {
        let usage = json!({
            "prompt_tokens": 1000,
            "completion_tokens": 200,
            "prompt_tokens_details": {
                "cache_read_input_tokens": 400
            }
        });

        // GPT-5.4: non_cached=600, cost = 600/M*2.5 + 200/M*15.0 + 400/M*0.25
        //          = 0.0015 + 0.003 + 0.0001 = 0.0046
        assert_eq!(
            compute_usage_cost(&openai_entry("gpt-5.4"), usage.as_object().unwrap()),
            Some(0.0046)
        );

        // GPT-4.1 mini: non_cached=600, cost = 600/M*0.4 + 200/M*1.6 + 400/M*0.1
        //             = 0.00024 + 0.00032 + 0.00004 = 0.0006
        assert_eq!(
            compute_usage_cost(&openai_entry("gpt-4.1-mini"), usage.as_object().unwrap()),
            Some(0.0006)
        );

        // GPT-4.1 nano: non_cached=600, cost = 600/M*0.1 + 200/M*0.4 + 400/M*0.025
        //             = 0.00006 + 0.00008 + 0.00001 = 0.00015
        assert_eq!(
            compute_usage_cost(&openai_entry("gpt-4.1-nano"), usage.as_object().unwrap()),
            Some(0.00015)
        );

        // Claude Sonnet 4.6: non_cached=600, cost = 600/M*3.0 + 200/M*15.0 + 400/M*0.3
        //                   = 0.0018 + 0.003 + 0.00012 = 0.00492
        assert_eq!(
            compute_usage_cost(
                &anthropic_entry("us.anthropic.claude-sonnet-4-6"),
                usage.as_object().unwrap()
            ),
            Some(0.00492)
        );

        // Claude Sonnet 5: same list rates as Sonnet 4.6
        assert_eq!(
            compute_usage_cost(
                &anthropic_entry("us.anthropic.claude-sonnet-5"),
                usage.as_object().unwrap()
            ),
            Some(0.00492)
        );

        // Claude Opus 5: drop-in at Opus 4.8 rates (both alias forms)
        assert_eq!(
            compute_usage_cost(
                &anthropic_entry("us.anthropic.claude-opus-5"),
                usage.as_object().unwrap()
            ),
            Some(0.0082)
        );
        assert_eq!(
            compute_usage_cost(
                &anthropic_entry("us.anthropic.claude-opus-5:0"),
                usage.as_object().unwrap()
            ),
            Some(0.0082)
        );

        // Claude Opus 4.8: same rates as 4.7
        assert_eq!(
            compute_usage_cost(
                &anthropic_entry("us.anthropic.claude-opus-4-8"),
                usage.as_object().unwrap()
            ),
            Some(0.0082)
        );

        // Claude Opus 4.7: same rates as 4.6
        assert_eq!(
            compute_usage_cost(
                &anthropic_entry("us.anthropic.claude-opus-4-7"),
                usage.as_object().unwrap()
            ),
            Some(0.0082)
        );

        // Claude Opus 4.6: same rates as 4.5
        assert_eq!(
            compute_usage_cost(
                &anthropic_entry("us.anthropic.claude-opus-4-6-v1"),
                usage.as_object().unwrap()
            ),
            Some(0.0082)
        );

        // Gemini 3.6 Flash Priority PayGo: non_cached=600,
        // cost = 600/M*2.70 + 200/M*13.50 + 400/M*0.27
        //      = 0.00162 + 0.00270 + 0.000108 = 0.004428
        assert_eq!(
            compute_usage_cost(
                &gemini_entry("gemini-3.6-flash"),
                usage.as_object().unwrap()
            ),
            Some(0.00443)
        );

        // Gemini 3.5 Flash Priority PayGo: non_cached=600,
        // cost = 600/M*2.70 + 200/M*16.20 + 400/M*0.27
        //      = 0.00162 + 0.00324 + 0.000108 = 0.004968
        assert_eq!(
            compute_usage_cost(
                &gemini_entry("gemini-3.5-flash"),
                usage.as_object().unwrap()
            ),
            Some(0.00497)
        );

        // Gemini 3.5 Flash-Lite Priority PayGo: non_cached=600,
        // cost = 600/M*0.54 + 200/M*4.50 + 400/M*0.054
        //      = 0.000324 + 0.00090 + 0.0000216 = 0.0012456
        assert_eq!(
            compute_usage_cost(
                &gemini_entry("gemini-3.5-flash-lite"),
                usage.as_object().unwrap()
            ),
            Some(0.00125)
        );

        // Gemini 3.1 Flash-Lite Priority PayGo: non_cached=600,
        // cost = 600/M*0.45 + 200/M*2.70 + 400/M*0.045
        //      = 0.00027 + 0.00054 + 0.000018 = 0.000828
        assert_eq!(
            compute_usage_cost(
                &gemini_entry("gemini-3.1-flash-lite"),
                usage.as_object().unwrap()
            ),
            Some(0.00083)
        );
    }

    // Claude Opus 4.6 with both cache read AND write tokens
    // 10000 prompt (8000 read, 1500 write), 500 completion
    // non_cached = 10000 - 8000 - 1500 = 500
    // cost = 500/M*5.0 + 500/M*25.0 + 8000/M*0.5 + 1500/M*6.25
    //      = 0.0025 + 0.0125 + 0.004 + 0.009375 = 0.028375
    #[test]
    fn anthropic_with_both_cache_read_and_write() {
        let entry = anthropic_entry("us.anthropic.claude-opus-4-6-v1");
        let usage = json!({
            "prompt_tokens": 10000,
            "completion_tokens": 500,
            "prompt_tokens_details": {
                "cache_read_input_tokens": 8000,
                "cache_creation_input_tokens": 1500
            }
        });
        assert_eq!(
            compute_usage_cost(&entry, usage.as_object().unwrap()),
            Some(0.02838)
        );
    }

    // GPT-4.1: non_cached=600, cost = 600/M*2.0 + 200/M*8.0 + 400/M*0.5
    //        = 0.0012 + 0.0016 + 0.0002 = 0.003
    #[test]
    fn gpt_4_1_uses_list_prices() {
        let usage = json!({
            "prompt_tokens": 1000,
            "completion_tokens": 200,
            "prompt_tokens_details": {
                "cache_read_input_tokens": 400
            }
        });
        assert_eq!(
            compute_usage_cost(&openai_entry("gpt-4.1"), usage.as_object().unwrap()),
            Some(0.003)
        );
    }

    #[test]
    fn gemini_costs_support_cached_content_and_high_context_tier() {
        let usage = json!({
            "prompt_tokens": 250000,
            "completion_tokens": 1000,
            "prompt_tokens_details": {
                "cachedContentTokenCount": 50000
            }
        });

        // Gemini 3.1 Pro Preview above 200k prompt tokens uses the high-context
        // Priority PayGo tier. non_cached=200000
        // cost = 200000/M*7.20 + 1000/M*32.40 + 50000/M*0.72
        //      = 1.44 + 0.0324 + 0.036 = 1.5084
        assert_eq!(
            compute_usage_cost(
                &gemini_entry("gemini-3.1-pro-preview"),
                usage.as_object().unwrap()
            ),
            Some(1.5084)
        );
    }

    #[test]
    fn gpt_56_pricing_matches_shared_threshold_fixture_with_cache_read_and_write() {
        let fixture: Value =
            serde_json::from_str(include_str!("../../../tests/fixtures/gpt-56-pricing.json"))
                .unwrap();
        let threshold = fixture["thresholdPromptTokens"].as_i64().unwrap();
        let cache_read = fixture["cacheReadTokens"].as_i64().unwrap();
        let cache_write = fixture["cacheWriteTokens"].as_i64().unwrap();
        let completion_tokens = fixture["completionTokens"].as_i64().unwrap();
        let prompt_token_cases = fixture["promptTokenCases"].as_array().unwrap();

        for model in fixture["models"].as_array().unwrap() {
            let model_id = model["rustModel"].as_str().unwrap();
            let entry = openai_entry(model_id);
            let spec = price_spec(&entry).unwrap();
            let base = &model["base"];
            let high = &model["highContext"];
            let high_spec = spec.high_context.unwrap();

            assert_eq!(spec.prompt_cost, base["inputPerMillion"].as_f64().unwrap());
            assert_eq!(
                spec.completion_cost,
                base["outputPerMillion"].as_f64().unwrap()
            );
            assert_eq!(
                spec.cache_read_cost,
                Some(base["cacheReadPerMillion"].as_f64().unwrap())
            );
            assert_eq!(
                spec.cache_write_cost,
                Some(base["cacheWritePerMillion"].as_f64().unwrap())
            );
            assert_eq!(high_spec.threshold_prompt_tokens, threshold);
            assert_eq!(
                high_spec.prompt_cost,
                high["inputPerMillion"].as_f64().unwrap()
            );
            assert_eq!(
                high_spec.completion_cost,
                high["outputPerMillion"].as_f64().unwrap()
            );
            assert_eq!(
                high_spec.cache_read_cost,
                Some(high["cacheReadPerMillion"].as_f64().unwrap())
            );
            assert_eq!(
                high_spec.cache_write_cost,
                Some(high["cacheWritePerMillion"].as_f64().unwrap())
            );

            for prompt_tokens in prompt_token_cases {
                let prompt_tokens = prompt_tokens.as_i64().unwrap();
                let rates = if prompt_tokens > threshold {
                    high
                } else {
                    base
                };
                let non_cached_prompt_tokens = prompt_tokens - cache_read - cache_write;
                let expected = round_cost(
                    (non_cached_prompt_tokens as f64 / PER_MILLION)
                        * rates["inputPerMillion"].as_f64().unwrap()
                        + (completion_tokens as f64 / PER_MILLION)
                            * rates["outputPerMillion"].as_f64().unwrap()
                        + (cache_read as f64 / PER_MILLION)
                            * rates["cacheReadPerMillion"].as_f64().unwrap()
                        + (cache_write as f64 / PER_MILLION)
                            * rates["cacheWritePerMillion"].as_f64().unwrap(),
                );
                let usage = json!({
                    "prompt_tokens": prompt_tokens,
                    "completion_tokens": completion_tokens,
                    "prompt_tokens_details": {
                        "cache_read_tokens": cache_read,
                        "cache_write_tokens": cache_write
                    }
                });

                assert_eq!(
                    compute_usage_cost(&entry, usage.as_object().unwrap()),
                    Some(expected),
                    "{model_id} prompt_tokens={prompt_tokens}"
                );
            }
        }
    }

    #[test]
    fn unknown_models_return_none() {
        let entry = openai_entry("unknown-model");
        let usage = json!({
            "prompt_tokens": 100,
            "completion_tokens": 10
        });
        assert_eq!(compute_usage_cost(&entry, usage.as_object().unwrap()), None);
        assert!(price_spec(&entry).is_none());

        let anthropic = anthropic_entry("unknown-anthropic");
        assert_eq!(
            compute_usage_cost(&anthropic, usage.as_object().unwrap()),
            None
        );
        assert!(price_spec(&anthropic).is_none());
    }
}
