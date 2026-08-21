#!/usr/bin/env python3
"""Test script to verify OpenAI Responses API web_search works through Portico proxy."""

import os
from openai import OpenAI

# Portico LLM Proxy configuration
PORTICO_PROXY_URL = "https://api.openai.com/v1"
API_KEY = "0b77e3dd-f3fb-4f36-a26e-7d739f2f9771"

# Portico required headers
PORTICO_HEADERS = {
    "x-portico-userid": "dsantiago",
    "x-portico-redact-allow": "*",
    "x-portico-appid": "portico",
    "x-portico-track": "sandbox",
    "x-portico-log-request": "false",
    "x-portico-log-response": "false",
}

# Models to test
MODELS_TO_TEST = [
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-5.4",
    "gpt-5.4-pro",
]

def test_web_search(model: str):
    """Test web search with a specific model."""
    print(f"\n{'='*60}")
    print(f"Testing model: {model}")
    print('='*60)

    try:
        client = OpenAI(
            base_url=PORTICO_PROXY_URL,
            api_key=API_KEY,
            default_headers=PORTICO_HEADERS,
            timeout=60.0,
        )

        response = client.responses.create(
            model=model,
            tools=[{"type": "web_search"}],
            input="What is the current date today?",
        )

        print(f"SUCCESS with model: {model}")
        print(f"Response ID: {response.id}")

        # Extract response text
        for output_item in response.output:
            if output_item.type == "message":
                for content in output_item.content:
                    if hasattr(content, 'text'):
                        print(f"Response text: {content.text[:200]}...")
                        break

        return True

    except Exception as e:
        print(f"FAILED with model: {model}")
        print(f"Error: {e}")
        return False

def main():
    print("Testing OpenAI Responses API with web_search through Portico Proxy")
    print(f"Proxy URL: {PORTICO_PROXY_URL}")

    working_models = []

    for model in MODELS_TO_TEST:
        if test_web_search(model):
            working_models.append(model)

    print(f"\n{'='*60}")
    print("SUMMARY")
    print('='*60)
    if working_models:
        print(f"Working models: {working_models}")
    else:
        print("No models worked!")

if __name__ == "__main__":
    main()
