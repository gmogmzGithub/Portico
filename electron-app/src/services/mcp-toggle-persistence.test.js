const test = require('node:test');
const assert = require('node:assert/strict');

const {
  persistMcpToggleState,
} = require('./mcp-toggle-persistence');

test('persistMcpToggleState applies the requested toggle mutation', async () => {
  const calls = [];

  const result = await persistMcpToggleState('data-plat-mcp', true, {
    mutateToggles: async (mutator, metadata) => {
      calls.push(metadata);
      const draft = { existing: false };
      await mutator(draft);
      assert.deepEqual(draft, {
        existing: false,
        'data-plat-mcp': true,
      });
    },
    reasonPrefix: 'unit-test',
  });

  assert.deepEqual(result, {
    server_id: 'data-plat-mcp',
    enabled: true,
  });
  assert.deepEqual(calls, [
    { reason: 'unit-test:data-plat-mcp:enable' },
  ]);
});

test('persistMcpToggleState validates its inputs', async () => {
  await assert.rejects(
    () =>
      persistMcpToggleState('', true, {
        mutateToggles: async () => undefined,
      }),
    /server_id \(string\) is required/,
  );

  await assert.rejects(
    () =>
      persistMcpToggleState('data-plat-mcp', 'yes', {
        mutateToggles: async () => undefined,
      }),
    /enabled \(boolean\) is required/,
  );

  await assert.rejects(
    () => persistMcpToggleState('data-plat-mcp', true),
    /mutateToggles must be a function/,
  );
});
