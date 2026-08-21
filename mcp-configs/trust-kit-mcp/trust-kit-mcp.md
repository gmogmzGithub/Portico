# <CYAN>Trust Kit MCP Server Configuration</CYAN>

## <GREEN>**Step 1: Create Your Waldo API Key**</GREEN>

Click <CYAN>**Open in Browser**</CYAN> below:
<browser-open url="https://waldo-new.sandbox.example.invalid/usersettings" />

### Follow these steps in your browser:
1. Find the <GREEN>**API Keys**</GREEN> section.
2. Fill in the <CYAN>**Client application**</CYAN>: <copy><RED>**Trust Kit MCP**</RED></copy>
3. Fill in the <CYAN>**Description**</CYAN>: <copy><RED>**Created for Trust Kit MCP**</RED></copy>
4. Click <GREEN>**Create API key**</GREEN>.
5. Copy the API key and paste it below.

<user-input
  var="waldoapikey"
  prompt="Please paste your Waldo API key:"
  validate=".+"
  error="API key cannot be empty" />

<success message="Waldo API key configured successfully! 🎉" />
