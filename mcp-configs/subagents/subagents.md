# <CYAN>🤖 Run Sub-Agent MCP Server Configuration</CYAN>

The Run Sub-Agent MCP Server allows you to invoke Open WebUI models as sub-agents. <GREEN>**No manual configuration is required!**</GREEN>

## How It Works

1. **Automatic Token Management**: The health check script automatically stores the Open WebUI API token in Redis
2. **Dynamic Model Discovery**: Available models are discovered from Open WebUI on startup
3. **Zero Configuration**: Just enable the server and you're ready to go!

## Available Features

<BLUE>🔹 **Sub-Agent Invocation:**</BLUE>
- Call any Open WebUI model programmatically
- System prompts configured in Open WebUI (per-model settings)
- Token limits enforced by the model catalog

<BLUE>🔹 **Hierarchical Workflows:**</BLUE>
- Delegate specialized tasks to expert models
- Chain reasoning across multiple models
- Parallel execution with different models

<BLUE>🔹 **Supported Models:**</BLUE>
Use these **exact** model names when invoking sub-agents:

| Family | Models (use exact names) |
|--------|-------------------------|
| **Claude** | `Claude Sonnet 5`, `Claude Sonnet 4.6`, `Claude Opus 5`, `Claude Opus 4.8`, `Claude Haiku 4.5` |
| **GPT-5** | `GPT-5.6 Sol`, `GPT-5.6 Sol Pro`, `GPT-5.6 Terra`, `GPT-5.6 Luna`, `GPT-5.5` |

**Note:** Model names like "Claude Sonnet 4" or "GPT-5" do NOT exist - always use the exact names above.

## Example Usage

```json
{
  "model": "Claude Sonnet 5",
  "prompt": "Analyze this code for security vulnerabilities: [code here]"
}
```

## Tool Parameters

<YELLOW>**model**</YELLOW> (required)
- Type: String (enum)
- Description: Name of the Open WebUI model to invoke
- Auto-populated with available models

<YELLOW>**prompt**</YELLOW> (required)
- Type: String
- Description: The task or question to send to the sub-agent

## Requirements

- <GREEN>✅ Redis running</GREEN> (automatically started with docker-compose)
- <GREEN>✅ Health check completed successfully</GREEN> (provides API token)
- <GREEN>✅ Open WebUI accessible</GREEN> (http://open-webui:8080)

## Notes

- System prompts are <CYAN>configured in Open WebUI</CYAN>, not passed per-request
- Max tokens are <CYAN>configured in model_catalog.yaml</CYAN>, enforced by the Bifrost bridge
- The server automatically retries failed requests (3 attempts with exponential backoff)
- Response includes model name, token usage, and finish reason

<success message="Run Sub-Agent server is ready to use! 🎉" />
