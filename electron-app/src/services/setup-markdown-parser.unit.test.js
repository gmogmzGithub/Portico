const test = require("node:test");
const assert = require("node:assert/strict");

function loadModule() {
  const modulePath = require.resolve("./guided-setup/setup-markdown-parser");
  delete require.cache[modulePath];
  return require("./guided-setup/setup-markdown-parser");
}

test("parseMarkdownContent preserves color spans around bold text from setup markdown", () => {
  const mod = loadModule();
  const html = mod.parseMarkdownContent(
    "# <CYAN>GitLab <RED>**Token**</RED></CYAN>",
    {},
    "server-config",
  );

  assert.match(
    html,
    /<h1><span class="gs-md-cyan">GitLab <span class="gs-md-red"><strong>Token<\/strong><\/span><\/span><\/h1>/,
  );
});

test("markdown parser uses compact list spacing for guided setup instructions", () => {
  const mod = loadModule();
  const html = mod.parseMarkdownContent(
    "1. First step\n    2. Nested step\n- Bullet item",
    {},
    "server-config",
  );

  assert.match(html, /margin-bottom: 6px; line-height: 1\.55/);
  assert.match(html, /margin-left: 26px; margin-bottom: 6px; line-height: 1\.6/);
  assert.match(html, /margin-left: 18px; margin-bottom: 6px; line-height: 1\.5/);
});

test("markdown parser renders guided setup confirmation cards with compact button markup", () => {
  const mod = loadModule();
  const html = mod.parseMarkdownContent(
    '<confirmation message="Is the app created?"/>',
    {},
    "server-config",
  );

  assert.match(
    html,
    /<div class="confirmation-card" id="confirmation-[^"]+" data-guidance-target="confirmation">/,
  );
  assert.match(
    html,
    /<button class="btn btn-confirm-yes" type="button" onclick="handleConfirmationYes\('[^']+', 'server-config'\)">[\s\S]*class="confirmation-button-icon"[\s\S]*<span>Yes<\/span>/,
  );
  assert.match(
    html,
    /<button class="btn btn-confirm-no" type="button" onclick="handleConfirmationNo\('[^']+', 'server-config'\)">[\s\S]*class="confirmation-button-icon"[\s\S]*<span>No<\/span>/,
  );
});

test("markdown parser substitutes variables and renders browser, copy, color, and user-input tags", () => {
  const mod = loadModule();
  const html = mod.parseMarkdownContent(
    [
      "Hello <USER_NAME/> (<USER_LDAP/>)",
      '<browser-open url="https://example.test"/>',
      "<copy>token</copy>",
      "<copy>- line one\n- line two</copy>",
      "<GREEN>Ready</GREEN>",
      '<user-input var="SLACK_TOKEN,SECONDARY" prompt="Slack Token:" validate="token" error="Bad token" placeholder="Paste token"/>',
    ].join("\n\n"),
    {
      PORTICO_USER_ID: "dsantiago",
      PORTICO_USER_NAME: "Dan Santiago",
    },
    "server-config",
  );

  assert.match(html, /Dan Santiago \(dsantiago\)/);
  assert.match(html, /onclick="openExternalUrl\('https:\/\/example\.test'\)"/);
  assert.match(html, /copy-inline-button/);
  assert.match(html, /copy-pane-button/);
  assert.match(html, /• line one/);
  assert.match(html, /class="gs-md-green">Ready<\/span>/);
  assert.match(html, /data-var="SLACK_TOKEN,SECONDARY"/);
  assert.match(html, /placeholder="Paste token"/);
});

test("first-run markdown keeps new-chat guidance text but omits the runtime control", () => {
  const mod = loadModule();
  const html = mod.parseMarkdownContent(
    [
      'Start a new chat and ask "Help me set up Snowflake".',
      '<new-chat prompt="Help me set up Snowflake" label="Set up Snowflake in chat" />',
    ].join("\n\n"),
    {},
    "server-config",
  );

  assert.match(html, /Help me set up Snowflake/);
  assert.doesNotMatch(html, /<new-chat|mcp-config-new-chat-btn/);
});

test("markdown parser exposes helper transforms for headings, formatting, paragraphs, and success cleanup", () => {
  const mod = loadModule();

  assert.equal(
    mod.substituteVariables("User: <USER_NAME/> / <USER_LDAP/>", {}),
    "User: [your-name] / [your-ldap]",
  );
  assert.equal(
    mod.processMarkdownHeadings("### C\n## B\n# A"),
    "<h3>C</h3>\n<h2>B</h2>\n<h1>A</h1>",
  );
  assert.equal(
    mod.processMarkdownFormatting("**Bold** and *italic*"),
    "<strong>Bold</strong> and <em>italic</em>",
  );
  assert.match(mod.processParagraphs("Plain text"), /^<p>Plain text<\/p>$/);
  assert.equal(mod.cleanSuccessMessages("<success/>ok"), "ok");
});

test("markdown parser wraps confirmation follow-on content and uses context-sensitive canned copy", () => {
  const mod = loadModule();
  const html = mod.processConfirmationBlocks(
    "<p>Before</p><confirmation message=\"Proceed?\"/><p>After</p>",
    "portico-api",
  );
  const serverConfigCard = mod.generateConfirmationCard(
    "Continue?",
    "confirmation-1",
    "server-config",
  );

  assert.match(html, /content-after-confirmation/);
  assert.match(html, /Proceed\?/);
  assert.match(
    serverConfigCard,
    /skip the rest of this server's configuration/,
  );
  assert.match(
    mod.generateConfirmationCard("Continue?", "confirmation-2", "portico-api"),
    /complete your configuration later/,
  );
});
