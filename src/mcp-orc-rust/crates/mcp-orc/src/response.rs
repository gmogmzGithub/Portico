use axum::http::StatusCode;
use axum::{response::IntoResponse, Json};
use rmcp::model::{CallToolResult, Content, RawContent};
use serde_json::{json, Map, Value};

pub fn call_tool_response(result: CallToolResult) -> Value {
    if result.is_error.unwrap_or(false) {
        return build_error_response(&result);
    }

    if let Some(structured) = result.structured_content {
        return structured;
    }

    flatten_content(&result.content)
}

fn flatten_content(content: &[Content]) -> Value {
    let mut values = Vec::new();
    for item in content {
        match &item.raw {
            RawContent::Text(text) => {
                let parsed = serde_json::from_str::<Value>(&text.text)
                    .unwrap_or_else(|_| Value::String(text.text.clone()));
                values.push(parsed);
            }
            RawContent::Image(image) => {
                values.push(Value::String(format!(
                    "data:{};base64,{}",
                    image.mime_type, image.data
                )));
            }
            RawContent::Resource(_) => {
                values.push(Value::String(
                    "Embedded resource not supported yet.".to_string(),
                ));
            }
            other => values.push(
                serde_json::to_value(other).expect("rmcp raw content variants are serializable"),
            ),
        }
    }

    match values.len() {
        0 => Value::Null,
        1 => values
            .into_iter()
            .next()
            .expect("single content item exists"),
        _ => Value::Array(values),
    }
}

fn extract_error_message(result: &CallToolResult) -> String {
    if let Some(structured) = result.structured_content.as_ref() {
        if let Some(message) = structured.get("message").and_then(Value::as_str) {
            return message.to_string();
        }
    }

    for item in &result.content {
        if let RawContent::Text(text) = &item.raw {
            return text.text.clone();
        }
    }

    "Unknown tool execution error".to_string()
}

pub(crate) fn extract_error_message_from_value(result: &Value) -> Option<String> {
    match result {
        Value::Object(object) => object
            .get("message")
            .or_else(|| object.get("error"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .or_else(|| extract_nested_error_message(object.get("result")))
            .or_else(|| extract_nested_error_message(object.get("content"))),
        Value::String(text) => Some(text.clone()),
        _ => None,
    }
}

fn extract_nested_error_message(value: Option<&Value>) -> Option<String> {
    let value = value?;
    match value {
        Value::Object(object) if value_has_error_marker(value) => object
            .get("message")
            .or_else(|| object.get("error"))
            .and_then(Value::as_str)
            .map(ToOwned::to_owned)
            .or_else(|| extract_nested_error_message(object.get("result")))
            .or_else(|| extract_nested_error_message(object.get("content"))),
        Value::String(text) => serde_json::from_str::<Value>(text)
            .ok()
            .filter(value_has_error_marker)
            .and_then(|parsed| extract_error_message_from_value(&parsed)),
        _ => None,
    }
}

fn value_has_error_marker(value: &Value) -> bool {
    match value {
        Value::Object(object) => {
            object
                .get("is_error")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                || object.get("success").and_then(Value::as_bool) == Some(false)
        }
        _ => false,
    }
}

fn build_error_response(result: &CallToolResult) -> Value {
    let message = extract_error_message(result);
    let flattened_content = flatten_content(&result.content);

    if let Some(structured) = result.structured_content.as_ref() {
        match structured {
            Value::Object(object) => {
                let mut response = object.clone();
                response.insert("is_error".to_string(), Value::Bool(true));
                response.insert("message".to_string(), Value::String(message));
                if !flattened_content.is_null() {
                    response
                        .entry("content".to_string())
                        .or_insert(flattened_content);
                }
                Value::Object(response)
            }
            other => {
                let mut response = Map::new();
                response.insert("is_error".to_string(), Value::Bool(true));
                response.insert("message".to_string(), Value::String(message));
                response.insert("structured_content".to_string(), other.clone());
                if !flattened_content.is_null() {
                    response.insert("content".to_string(), flattened_content);
                }
                Value::Object(response)
            }
        }
    } else {
        let mut response = Map::new();
        response.insert("is_error".to_string(), Value::Bool(true));
        response.insert("message".to_string(), Value::String(message));
        if !flattened_content.is_null() {
            response.insert("content".to_string(), flattened_content);
        }
        Value::Object(response)
    }
}

pub fn json_error(status: StatusCode, message: impl Into<String>) -> impl IntoResponse {
    (
        status,
        Json(json!({
            "message": message.into(),
        })),
    )
}

#[cfg(test)]
mod tests {
    use super::{call_tool_response, extract_error_message_from_value, json_error};
    use axum::http::StatusCode;
    use axum::response::IntoResponse;
    use rmcp::model::{CallToolResult, Content, RawContent, RawEmbeddedResource, ResourceContents};
    use serde_json::json;

    #[test]
    fn prefers_structured_content() {
        let mut result = CallToolResult::structured(json!({"ok": true}));
        result.content = vec![Content::text("ignored")];
        assert_eq!(call_tool_response(result), json!({"ok": true}));
    }

    #[test]
    fn maps_error_results_to_in_band_payload() {
        let result = CallToolResult::error(vec![Content::text("boom")]);
        assert_eq!(
            call_tool_response(result),
            json!({
                "is_error": true,
                "message": "boom",
                "content": "boom"
            })
        );
    }

    #[test]
    fn builds_json_error() {
        let response = json_error(StatusCode::BAD_REQUEST, "bad request").into_response();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[test]
    fn extracts_nested_tool_error_message_from_json_result_string() {
        let nested = json!({
            "result": serde_json::to_string(&json!({
                "success": false,
                "message": "Failed to fetch document: The credentials do not contain the necessary fields need to refresh the access token. You must specify refresh_token, token_uri, client_id, and client_secret.",
                "document_link": null
            }))
            .unwrap()
        });

        assert_eq!(
            extract_error_message_from_value(&nested).as_deref(),
            Some("Failed to fetch document: The credentials do not contain the necessary fields need to refresh the access token. You must specify refresh_token, token_uri, client_id, and client_secret.")
        );
    }

    #[test]
    fn flattens_text_json_and_multiple_items() {
        let result = CallToolResult::success(vec![
            Content::text(r#"{"ok":true}"#),
            Content::text("plain text"),
        ]);
        assert_eq!(
            call_tool_response(result),
            json!([{"ok": true}, "plain text"])
        );
    }

    #[test]
    fn flattens_image_and_resource_content() {
        let result = CallToolResult::success(vec![
            Content {
                annotations: None,
                raw: RawContent::Image(rmcp::model::RawImageContent {
                    data: "Zm9v".to_string(),
                    mime_type: "image/png".to_string(),
                    meta: None,
                }),
            },
            Content {
                annotations: None,
                raw: RawContent::Resource(RawEmbeddedResource::new(
                    ResourceContents::TextResourceContents {
                        uri: "file:///tmp/demo".to_string(),
                        mime_type: Some("text/plain".to_string()),
                        text: "hello".to_string(),
                        meta: None,
                    },
                )),
            },
        ]);
        assert_eq!(
            call_tool_response(result),
            json!([
                "data:image/png;base64,Zm9v",
                "Embedded resource not supported yet."
            ])
        );
    }

    #[test]
    fn handles_empty_and_unknown_error_messages() {
        let empty = CallToolResult::success(Vec::new());
        assert_eq!(call_tool_response(empty), serde_json::Value::Null);

        let unknown = CallToolResult::error(vec![Content {
            annotations: None,
            raw: RawContent::Audio(rmcp::model::RawAudioContent {
                data: "aaaa".to_string(),
                mime_type: "audio/wav".to_string(),
            }),
        }]);
        assert_eq!(
            call_tool_response(unknown),
            json!({
                "is_error": true,
                "message": "Unknown tool execution error",
                "content": {
                    "type": "audio",
                    "data": "aaaa",
                    "mimeType": "audio/wav"
                }
            })
        );
    }

    #[test]
    fn serializes_other_content_and_prefers_structured_error_message() {
        let audio = CallToolResult::success(vec![Content {
            annotations: None,
            raw: RawContent::Audio(rmcp::model::RawAudioContent {
                data: "aaaa".to_string(),
                mime_type: "audio/wav".to_string(),
            }),
        }]);
        assert_eq!(
            call_tool_response(audio),
            json!({
                "type": "audio",
                "data": "aaaa",
                "mimeType": "audio/wav"
            })
        );

        let mut structured_error = CallToolResult::structured(json!({
            "message": "structured boom"
        }));
        structured_error.is_error = Some(true);
        structured_error.content = vec![Content::text("ignored")];
        assert_eq!(
            call_tool_response(structured_error),
            json!({
                "is_error": true,
                "message": "structured boom",
                "content": "ignored"
            })
        );

        let mut fallback_to_text = CallToolResult::structured(json!({
            "detail": "missing explicit message"
        }));
        fallback_to_text.is_error = Some(true);
        fallback_to_text.content = vec![Content::text("fallback text")];
        assert_eq!(
            call_tool_response(fallback_to_text),
            json!({
                "is_error": true,
                "message": "fallback text",
                "detail": "missing explicit message",
                "content": "fallback text"
            })
        );
    }

    #[test]
    fn preserves_structured_error_fields_and_non_object_payloads() {
        let mut object_error = CallToolResult::structured(json!({
            "detail": "still warming",
            "retry_after_seconds": 180
        }));
        object_error.is_error = Some(true);
        object_error.content = vec![Content::text("please retry later")];
        assert_eq!(
            call_tool_response(object_error),
            json!({
                "is_error": true,
                "message": "please retry later",
                "detail": "still warming",
                "retry_after_seconds": 180,
                "content": "please retry later"
            })
        );

        let mut non_object_error = CallToolResult::structured(json!(["warming", "retry"]));
        non_object_error.is_error = Some(true);
        non_object_error.content = vec![Content::text("temporary issue")];
        assert_eq!(
            call_tool_response(non_object_error),
            json!({
                "is_error": true,
                "message": "temporary issue",
                "structured_content": ["warming", "retry"],
                "content": "temporary issue"
            })
        );
    }
}
