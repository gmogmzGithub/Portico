Study this screen: [Image #1]
Study how the OAuth flow works behind the scenes. Study docs/OAuth.md

I think there's an opportunity to improve the way this all works.

At a very high level, the current workflow is expected to do the following when starting a single server stack to run oauth for a server that requires oauth:
1) Stop the regular containers that would cause a conflict. This is usually the mcpo container but could also be the mcpo-core container depending on the type of MCP server, and also the MCP server container for whatever MCP server we're trying to
auth, in case its running
2) Start the single server stack
3) Run the OAuth token exchange workflow
4) Eventually once completed, restart the regular containers

This process is super slow and error prone.

This is done because the mcpo container listens on port 3834 and 8765 and mcpo-core listens on 8766, and we need to start an isolated version of mcpo / mcpo-core (depending on the type of MCP server we're trying to oauth) for the single server stack.

Instead, I propose we find any two free ports on the host system and make it so the mcpo / mcpo-core container in the single server stack sets up the OAuth callback on one of those free ports instead of 3834 and sets up whatever normally listens on
8765 to listen on some other port, we just need to make sure the MCP server we're bringing up in the single server stack (the MCP server we're trying to OAuth) generates an OAuth callback URL that matches whatever port the single server stack mcpo /
mcpo-core container is actually expecting since it will be dynamic.

This means we can completely skip Step 1 above, and Step 4 (restarting the regular containers, because we never stopped them).
