Generate a simple histogram of a normal distribution

--- 

For each continent, start a subagent in parallel. Each subagent should choose 5 countries from the continent it is responsible for and write a short poem about the country. After they’re all done, synthesize a complete cohesive poem about all the chosen countries.

---

Run through the following workflow:
1. List all available tools.
2. If dynamic-waldo-mcp-prod and taxonomy are installed MCP servers, remove them, then restart the MCP infra.
3. Install these MCP servers for me:
"taxonomy": {
    "command": "npx",
    "args": [
        "mcp-remote",
        "https://taxo-mcp.sandbox.example.invalid/mcp/",
        "--header",
        "X-Api-Key: taxo"
    ]
},
"dynamic-waldo-mcp-prod": {
    "url": "https://waldo-dynamic-mcp.sandbox.example.invalid/"
}
4. Restart the MCP infra after installing the MCP servers.
5. For each available non-core tool, start a subagent to test the tool.
    
    How to test mcp-atlassian: Get the JIRA ticket EJGROUP-1657 and provide a summary of it.
    How to test chrome devtools: Open https://example.com in the browser and summarize the rendered page contents.
    How to test waldo mcp: Fetch data for agg job 9894139306
    How to test gitlab: Call get_namespace with namespace_id dsantiago
    How to test glean: Use the search tool and look for Portico
    How to test gcp workspace mcp: Start the auth process by calling the auth tool, dont do anything with oauth
    How to test slack: Get the channel list with a limit of 5
    How to test taxonomy: Call search concepts with no args and summarize the top 5 results
   Have each subagent summarize its results.
   Start all of these subagents in parallel.
6. After all the subagents are done, summarize all the results in this main chat.

---

Set up these MCP servers for me please:
{
  "type": "streamable-http",
  "url": "https://incident-data-service-mcp.sandbox.example.invalid/mcp/"
}
{
  "type": "streamable-http",
  "url": "https://proctor-mcp.sandbox.example.invalid/mcp/"
}
{
  "headers": {
    "X-Api-Key": "taxo"
  },
  "type": "streamable-http",
  "url": "https://taxo-mcp.sandbox.example.invalid/mcp/"
}
{
  "headers": {
    "X-Api-Key": "8497b554011faec6044542c14f9c831773b2913da96d4081fd11d108d4167f3d"
  },
  "type": "streamable-http",
  "url": "https://waldo-dynamic-mcp.sandbox.example.invalid/"
}
{
  "headers": {
    "X-Api-Key": "e043475a420a4623b5257f0167c794047e52155b2ad01a3e875ab168af3f9b98"
  },
  "type": "streamable-http",
  "url": "https://waldo-dynamic-mcp.sandbox.qa.example.invalid/"
}

---
