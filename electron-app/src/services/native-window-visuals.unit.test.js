const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getMacWindowVisualOptions,
  isMacSidebarVibrancyEnabled,
} = require('./native-window-visuals');

test('macOS native sidebar vibrancy is the default and keeps legacy false-like opt-ins', () => {
  for (const env of [
    {},
    { PORTICO_OPAQUE_WINDOWS: '0' },
    { PORTICO_OPAQUE_WINDOWS: 'false' },
    { PORTICO_OPAQUE_WINDOWS: 'no' },
    { PORTICO_OPAQUE_WINDOWS: 'off' },
  ]) {
    assert.equal(
      isMacSidebarVibrancyEnabled({ platform: 'darwin', env }),
      true,
    );
  }
});

test('opaque preference, non-mac platforms, and Reduce Transparency disable vibrancy', () => {
  for (const env of [
    { PORTICO_OPAQUE_WINDOWS: '1' },
    { PORTICO_OPAQUE_WINDOWS: 'true' },
    { PORTICO_OPAQUE_WINDOWS: 'yes' },
  ]) {
    assert.equal(
      isMacSidebarVibrancyEnabled({ platform: 'darwin', env }),
      false,
    );
  }

  assert.equal(
    isMacSidebarVibrancyEnabled({ platform: 'linux', env: {} }),
    false,
  );
  assert.equal(
    isMacSidebarVibrancyEnabled({
      platform: 'darwin',
      env: {},
      reduceTransparency: true,
    }),
    false,
  );
});

test('guided setup can retain its legacy opaque default independently', () => {
  assert.equal(
    isMacSidebarVibrancyEnabled({
      platform: 'darwin',
      env: {},
      defaultEnabled: false,
    }),
    false,
  );
  assert.equal(
    isMacSidebarVibrancyEnabled({
      platform: 'darwin',
      env: { PORTICO_OPAQUE_WINDOWS: '0' },
      defaultEnabled: false,
    }),
    true,
  );
});

test('native visual options use the AppKit sidebar material WITHOUT the transparent flag', () => {
  const options = getMacWindowVisualOptions({
    platform: 'darwin',
    env: {},
    nativeTheme: { shouldUseDarkColors: false },
  });

  // Vibrancy alone marks the window translucent (Electron propagates the
  // transparent WebContents background itself); `transparent: true` must
  // stay out — it suppressed CSS cursors across the entire window.
  assert.deepEqual(options, {
    vibrancy: 'under-window',
    visualEffectState: 'active',
  });
});

test('opaque native visual fallback follows the current native appearance', () => {
  assert.deepEqual(
    getMacWindowVisualOptions({
      platform: 'darwin',
      env: { PORTICO_OPAQUE_WINDOWS: '1' },
      nativeTheme: { shouldUseDarkColors: true },
    }),
    { backgroundColor: '#1e2324' },
  );
  assert.deepEqual(
    getMacWindowVisualOptions({
      platform: 'darwin',
      env: { PORTICO_OPAQUE_WINDOWS: '1' },
      nativeTheme: { shouldUseDarkColors: false },
    }),
    { backgroundColor: '#f5f5f5' },
  );
});
