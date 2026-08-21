# <CYAN>n8n MCP Server Configuration</CYAN>

## <GREEN>**Step 1: Create Your n8n API Key**</GREEN>

Click <CYAN>**Open in Browser**</CYAN> below to access your n8n settings:
<browser-open url="https://n8n.example.invalid/settings/api" />

### Follow these steps in your browser:
1. Click on <GREEN>**Create an API Key**</GREEN>
2. <CYAN>**Label**</CYAN>: <copy><RED>**<USER_LDAP/> Portico MCP**</RED></copy>
3. Select the scopes needed for your key.  We recommend avoiding delete operations
4. Click <GREEN>**Save**</GREEN> and copy the generated API key

<user-input 
  var="N8N_API_KEY" 
  prompt="Please paste your n8n API key and press Enter:"
  validate=".+"
  error="API key cannot be empty" />

<success message="n8n MCP Server configured successfully! 🎉" />

## What This Enables

Your AI assistant can now:
- 📚 Access documentation for 500+ n8n nodes
- 🔧 Go from a lucidchart screenshot to n8n workflow 
- ✅ Validate node configurations
- 🔄 Create, read and update workflows
- ⚡ Execute workflows and monitor results
- 🎯 Search workflow templates
- 🤖 Build AI agent workflows

