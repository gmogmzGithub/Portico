const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SKILL_DIR = path.join(REPO_ROOT, "skills/lm-studio-setup");
const SKILL_PATH = path.join(SKILL_DIR, "SKILL.md");

const EXPECTED_ASSETS = [
  "assets/01-download-lm-studio.png",
  "assets/02-install-lm-studio.png",
  "assets/03-open-downloaded-app.png",
  "assets/04-lm-studio-welcome.png",
  "assets/05-download-first-model.png",
  "assets/06-model-download-progress.png",
  "assets/07-model-download-complete.png",
  "assets/08-enable-local-service-login.png",
  "assets/09-open-developer-panel.png",
  "assets/10-start-local-server.png",
];

test("LM Studio setup skill declares frontmatter, tool flow, and Docker host guidance", () => {
  const source = fs.readFileSync(SKILL_PATH, "utf8");

  assert.match(source, /^---\nname: lm-studio-setup/m);
  assert.match(source, /^display_name: LM Studio Setup/m);
  assert.match(source, /skills_get_skill_assets/);
  assert.match(source, /subagents_get_lm_studio_status/);
  assert.match(source, /subagents_configure_lm_studio/);
  assert.match(source, /subagents_run_subagent/);
  assert.match(source, /subagents_get_system_information/);
  assert.match(source, /agent_vm_execute_skill_script/);
  assert.match(source, /skills_ask_user_question/);
  assert.match(source, /include_core_tools=false/);
  assert.match(source, /http:\/\/127\.0\.0\.1:1234/);
  assert.match(source, /http:\/\/host\.docker\.internal:1234/);
  assert.match(source, /GET \/api\/v1\/models/);
  assert.match(source, /POST \/api\/v1\/models\/load/);
  assert.match(source, /POST \/api\/v1\/models\/unload/);
  assert.match(source, /POST \/api\/v1\/models\/download/);
  assert.match(source, /GET \/api\/v1\/models\/download\/status\/:job_id/);
  assert.match(source, /context_length/);
  assert.match(source, /Call `subagents_get_system_information` before making context-window decisions/);
  assert.match(source, /Default to LM Studio's live `max_context_length`/);
  assert.match(source, /`loaded_context_length` is lower than `max_context_length`/);
  assert.match(source, /unloads the existing LM Studio instance/);
  assert.match(source, /using the `model` field/);
  assert.match(source, /Do not pass `skill_ids` or `tool_server_ids`/);
  assert.match(source, /text-only smoke test/);
  assert.match(source, /URL-based `markdown_image`/);
  assert.match(source, /Initial response contract/);
  assert.match(source, /Do not call `skills_ask_user_question` in the same response/);
  assert.match(source, /Only call `skills_ask_user_question` after a later user message/);
  assert.match(source, /do not open a question modal first/);
  assert.match(source, /with the `probe` command against `http:\/\/host\.docker\.internal:1234`/);
  assert.match(source, /If the default probe returns `reachable=true`, do not ask the user/);
  assert.match(source, /Only if the default probe returns `reachable=false`/);
  assert.match(source, /`probe --base-url http:\/\/host\.docker\.internal:<port>`/);
  assert.match(source, /Do not infer readiness just because the skill was activated/);
  assert.match(source, /Model Recommendation Policy/);
  assert.match(source, /Never recommend stale or hardcoded model examples from memory/);
  assert.match(source, /Do not mention specific model names such as Llama 3\.2, Gemma 2/);
  assert.match(source, /unless that model is already present in LM Studio's live `GET \/api\/v1\/models` output/);
  assert.match(source, /verified during the current setup turn using current sources/);
  assert.match(source, /skip model download for now; I can recommend a current model/);
  assert.match(source, /follow the Model Recommendation Policy/);
  assert.match(source, /Security Boundaries/);
  assert.match(source, /Keep LM Studio local/);
  assert.match(source, /Only use `http:\/\/127\.0\.0\.1:<port>`/);
  assert.match(source, /`http:\/\/host\.docker\.internal:<port>` from Docker or Agent VM/);
  assert.match(source, /Never suggest `ngrok`, Cloudflare Tunnel, localtunnel, Serveo/);
  assert.match(source, /public reverse proxies, port forwarding, public DNS/);
  assert.match(source, /asking an admin to add a user-created public tunnel URL/);
  assert.match(source, /Do not offer a public tunnel workaround/);
  assert.match(source, /expose prompts, responses, local APIs, and confidential work data/);
  assert.doesNotMatch(source, /ask them to download a small chat\/instruct model/);
  assert.doesNotMatch(source, /data:image/);
  assert.doesNotMatch(source, /base64/i);

  for (const asset of EXPECTED_ASSETS) {
    assert.match(source, new RegExp(asset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  let lastIndex = -1;
  for (const asset of EXPECTED_ASSETS) {
    const index = source.indexOf(asset);
    assert.ok(index > lastIndex, `${asset} should appear in order`);
    lastIndex = index;
  }
});

test("LM Studio setup skill has visual guide PNG assets", () => {
  const actualPngAssets = fs
    .readdirSync(path.join(SKILL_DIR, "assets"))
    .filter((name) => name.endsWith(".png"))
    .map((name) => `assets/${name}`)
    .sort();

  assert.deepEqual(actualPngAssets, [...EXPECTED_ASSETS].sort());

  for (const asset of EXPECTED_ASSETS) {
    const assetPath = path.join(SKILL_DIR, asset);
    const bytes = fs.readFileSync(assetPath);
    assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], asset);
  }
});
