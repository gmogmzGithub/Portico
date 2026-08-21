# <CYAN>Snowflake MCP Configuration</CYAN>

Start a new chat and ask <GREEN>**"Help me set up Snowflake"**</GREEN>. Portico will guide token creation, securely collect your Snowflake programmatic access token, and create the required files for you.

<new-chat prompt="Help me set up Snowflake" label="Set up Snowflake in chat" />

The Snowflake MCP server uses these files on your Mac:

~/.snowflake/mcp_config.yaml

~/.snowflake/connections.toml

The connections file contains your Snowflake token. Portico imports it into the secure runtime-secret path, replaces the original file with a non-secret stub, and mounts the secure copy into Docker as a secret. To replace the credential later, start a new chat and ask <GREEN>**"My Snowflake token is broken. Help me replace it with a fresh token."**</GREEN>
