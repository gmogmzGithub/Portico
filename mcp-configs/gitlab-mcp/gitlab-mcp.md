# <CYAN>GitLab MCP Server Configuration</CYAN>

## <GREEN>**Step 1: Create Your Personal Access Token**</GREEN>

Click <CYAN>**Open in Browser**</CYAN> below:
<browser-open url="https://example.invalid/-/user_settings/personal_access_tokens" />

### Follow these steps in your browser:
1. Click on <GREEN>**Add new token**</GREEN>
2. <CYAN>**Token name**</CYAN>: <copy><RED>**GitLab MCP**</RED></copy>
3. <CYAN>**Expiration date**</CYAN>: <RED>**~6 months from now**</RED>
4. <CYAN>**Select scopes:**</CYAN>
- **read_repository**
- **write_repository**
- **api**
5. Click <GREEN>**Create token**</GREEN>
6. Copy the token

<user-input 
  var="GITLAB_PERSONAL_ACCESS_TOKEN" 
  prompt="Please paste your GitLab personal access token and press Enter:"
  validate=".+"
  error="Token cannot be empty" />

<success message="GitLab personal access token configured successfully! 🎉" />
