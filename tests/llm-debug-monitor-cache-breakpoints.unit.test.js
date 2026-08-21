const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { build } = require('../electron-app/node_modules/esbuild');

const REPO_ROOT = path.resolve(__dirname, '..');

let tempDir;
let cacheBreakpointUtils;

async function bundleModule(entryPath, outFile, tsconfig) {
	await build({
		entryPoints: [path.join(REPO_ROOT, entryPath)],
		bundle: true,
		format: 'cjs',
		platform: 'node',
		target: ['node20'],
		logLevel: 'silent',
		tsconfig,
		outfile: outFile
	});
	return require(outFile);
}

before(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'llm-debug-monitor-cache-breakpoints-'));
	cacheBreakpointUtils = await bundleModule(
		'llm-debug-monitor/src/utils/cacheBreakpoints.ts',
		path.join(tempDir, 'cacheBreakpoints.cjs'),
		path.join(REPO_ROOT, 'llm-debug-monitor/tsconfig.json')
	);
});

after(async () => {
	if (tempDir) {
		await fs.rm(tempDir, { recursive: true, force: true });
	}
});

test('cache breakpoint utility extracts explicit bridge-stage tool and system breakpoints plus request-level caching', () => {
	const breakpoints = cacheBreakpointUtils.extractStageCacheBreakpoints({
		api_path: 'chat-completions',
		payload: {
			cache_control: { type: 'ephemeral' },
			messages: [
				{
					role: 'system',
					content: [
						{
							type: 'text',
							text: '<static_context>stable</static_context>',
							cache_control: { type: 'ephemeral' }
						}
					]
				},
				{
					role: 'system',
					content: [
						{
							type: 'text',
							text: 'model prompt',
							cache_control: { type: 'ephemeral' }
						}
					]
				},
				{
					role: 'system',
					content: '<dynamic_context>dynamic</dynamic_context>'
				},
				{ role: 'user', content: 'hello' }
			],
			tools: [
				{ name: 'alpha' },
				{ name: 'zebra', cache_control: { type: 'ephemeral' } }
			]
		}
	});

	assert.deepEqual(
		breakpoints.map((breakpoint) => ({
			scope: breakpoint.scope,
			origin: breakpoint.origin,
			jsonPath: breakpoint.jsonPath
		})),
		[
			{
				scope: 'system',
				origin: 'explicit',
				jsonPath: 'messages[0].content[0].cache_control'
			},
			{
				scope: 'system',
				origin: 'explicit',
				jsonPath: 'messages[1].content[0].cache_control'
			},
			{
				scope: 'tool',
				origin: 'explicit',
				jsonPath: 'tools[1].cache_control'
			},
			{
				scope: 'request',
				origin: 'request-level',
				jsonPath: 'cache_control'
			}
		]
	);
	assert.equal(breakpoints[3].displayPath, 'Request-level cache_control');
	assert.match(breakpoints[3].summary, /Top-level Anthropic request cache_control/);
});

test('cache breakpoint utility classifies provider cachePoint blocks using the companion bridge stage', () => {
	const bridgeStage = {
		api_path: 'chat-completions',
		payload: {
			cache_control: { type: 'ephemeral' },
			messages: [
				{
					role: 'system',
					content: [
						{
							type: 'text',
							text: '<static_context>stable</static_context>',
							cache_control: { type: 'ephemeral' }
						}
					]
				},
				{
					role: 'system',
					content: [
						{
							type: 'text',
							text: 'model prompt',
							cache_control: { type: 'ephemeral' }
						}
					]
				},
				{
					role: 'system',
					content: '<dynamic_context>dynamic</dynamic_context>'
				},
				{ role: 'user', content: 'hello' }
			],
			tools: [
				{ name: 'alpha' },
				{ name: 'zebra', cache_control: { type: 'ephemeral' } }
			]
		}
	};

	const breakpoints = cacheBreakpointUtils.extractStageCacheBreakpoints(
		{
			api_path: 'bedrock-converse',
			payload: {
				system: [
					{ text: '<static_context>stable</static_context>' },
					{ cachePoint: { type: 'default' } },
					{ text: 'model prompt' },
					{ cachePoint: { type: 'default' } },
					{ text: '<dynamic_context>dynamic</dynamic_context>' }
				],
				messages: [
					{
						role: 'user',
						content: [{ text: 'hello' }, { cachePoint: { type: 'default' } }]
					}
				],
				toolConfig: {
					tools: [
						{ toolSpec: { name: 'alpha', inputSchema: { json: { type: 'object' } } } },
						{ toolSpec: { name: 'zebra', inputSchema: { json: { type: 'object' } } } },
						{ cachePoint: { type: 'default' } }
					]
				}
			}
		},
		{ bridgeStage }
	);

	assert.deepEqual(
		breakpoints.map((breakpoint) => ({
			scope: breakpoint.scope,
			origin: breakpoint.origin,
			jsonPath: breakpoint.jsonPath
		})),
		[
			{
				scope: 'tool',
				origin: 'explicit',
				jsonPath: 'toolConfig.tools[2]'
			},
			{
				scope: 'system',
				origin: 'explicit',
				jsonPath: 'system[1]'
			},
			{
				scope: 'system',
				origin: 'explicit',
				jsonPath: 'system[3]'
			},
			{
				scope: 'message',
				origin: 'request-level',
				jsonPath: 'messages[0].content[1]'
			}
		]
	);
	assert.match(
		breakpoints[3].summary,
		/Provider cachePoint derived from request-level cache_control in user message 1/
	);
});

test('cache breakpoint utility builds request-inspector maps with request-level conversation breakpoints on the correct message slot', () => {
	const data = cacheBreakpointUtils.buildRequestInspectorBreakpointData({
		messages: [{ role: 'user', content: 'fallback raw message' }],
		tools: [{ name: 'fallback tool' }],
		transformed_payloads: [
			{
				event_id: 'bridge-1',
				api_path: 'chat-completions',
				payload: {
					cache_control: { type: 'ephemeral' },
					messages: [
						{
							role: 'system',
							content: [
								{
									type: 'text',
									text: '<static_context>stable</static_context>',
									cache_control: { type: 'ephemeral' }
								}
							]
						},
						{
							role: 'system',
							content: [
								{
									type: 'text',
									text: 'model prompt',
									cache_control: { type: 'ephemeral' }
								}
							]
						},
						{
							role: 'system',
							content: '<dynamic_context>dynamic</dynamic_context>'
						},
						{ role: 'user', content: 'hello' }
					],
					tools: [
						{ name: 'alpha' },
						{ name: 'zebra', cache_control: { type: 'ephemeral' } }
					]
				}
			},
			{
				event_id: 'provider-1',
				api_path: 'bedrock-converse',
				payload: {
					system: [
						{ text: '<static_context>stable</static_context>' },
						{ cachePoint: { type: 'default' } },
						{ text: 'model prompt' },
						{ cachePoint: { type: 'default' } },
						{ text: '<dynamic_context>dynamic</dynamic_context>' }
					],
					messages: [
						{
							role: 'user',
							content: [{ text: 'hello' }, { cachePoint: { type: 'default' } }]
						}
					],
					toolConfig: {
						tools: [
							{ toolSpec: { name: 'alpha', inputSchema: { json: { type: 'object' } } } },
							{ toolSpec: { name: 'zebra', inputSchema: { json: { type: 'object' } } } },
							{ cachePoint: { type: 'default' } }
						]
					}
				}
			}
		]
	});

	assert.equal(data.displayMessages.length, 4);
	assert.equal(data.displayTools.length, 2);
	assert.equal(data.systemByMessageIndex[0][0].jsonPath, 'messages[0].content[0].cache_control');
	assert.equal(data.systemByMessageIndex[1][0].jsonPath, 'messages[1].content[0].cache_control');
	assert.equal(data.toolsByIndex[1][0].jsonPath, 'tools[1].cache_control');
	assert.equal(data.conversationByMessageIndex[0][0].origin, 'request-level');
	assert.equal(data.conversationByMessageIndex[0][0].jsonPath, 'messages[0].content[1]');
	assert.match(
		data.conversationByMessageIndex[0][0].summary,
		/request-level cache_control/
	);
});
