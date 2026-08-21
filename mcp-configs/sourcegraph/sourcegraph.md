# <CYAN>Sourcegraph MCP Server Configuration</CYAN>

## <GREEN>**Step 1: Create Your Sourcegraph Access Token**</GREEN>

Click <CYAN>**Open in Browser**</CYAN> below to access Portico Sourcegraph:

<browser-open url="https://portico.sourcegraph.com/search" />

### Follow these steps in your browser:

1. Log in to Sourcegraph (if not already logged in)
2. Click on your <GREEN>**profile icon**</GREEN> on the bottom left
3. Click <GREEN>**Settings**</GREEN>
4. Click <GREEN>**Access tokens**</GREEN> on the left hand side
5. Click <GREEN>**Generate new token**</GREEN>
6. <CYAN>**Token description**</CYAN>: <copy><RED>**PORTICO MCP**</RED></copy>
7. Leave all other settings as default
8. Click <GREEN>**Generate token**</GREEN> and copy the generated token

<user-input
  var="SOURCEGRAPH_TOKEN"
  prompt="Please paste your Sourcegraph access token and press Enter:"
  validate=".+"
  error="Access token cannot be empty" />

<success message="Sourcegraph MCP Server configured successfully! 🎉" />
