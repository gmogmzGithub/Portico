import test from 'node:test';
import assert from 'node:assert/strict';

import {
	clampContextTokensToWindow,
	resolveSubagentDisplayTokenCount
} from '../../../src/patches/frontend/src/lib/utils/subagent-tokens.mjs';

test('clampContextTokensToWindow caps context usage to the model window', () => {
	assert.equal(clampContextTokensToWindow(3034894, 1_000_000), 1_000_000);
	assert.equal(clampContextTokensToWindow(879408, 1_000_000), 879408);
	assert.equal(clampContextTokensToWindow(-15, 1_000_000), 0);
});

test('resolveSubagentDisplayTokenCount prefers normalized context tokens over raw usage', () => {
	assert.equal(
		resolveSubagentDisplayTokenCount({
			contextTokens: 3034894,
			maxContextTokens: 1_000_000,
			usageTokens: 1548200,
			approximateTokens: 220000
		}),
		1_000_000
	);
});

test('resolveSubagentDisplayTokenCount falls back to usage or approximate tokens', () => {
	assert.equal(
		resolveSubagentDisplayTokenCount({
			contextTokens: 0,
			maxContextTokens: 1_000_000,
			usageTokens: 879408,
			approximateTokens: 420000
		}),
		879408
	);
	assert.equal(
		resolveSubagentDisplayTokenCount({
			contextTokens: 0,
			maxContextTokens: 1_000_000,
			usageTokens: 0,
			approximateTokens: 420000
		}),
		420000
	);
	assert.equal(resolveSubagentDisplayTokenCount({}), null);
});
