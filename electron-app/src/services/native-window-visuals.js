const OPAQUE_WINDOWS_ENV = 'PORTICO_OPAQUE_WINDOWS';
const NATIVE_SIDEBAR_VIBRANCY_ARGUMENT = '--portico-native-sidebar-vibrancy';
const EXPLICIT_TRANSPARENCY_VALUES = new Set(['0', 'false', 'no', 'off']);

function isMacSidebarVibrancyEnabled({
  platform = process.platform,
  env = process.env,
  defaultEnabled = true,
  reduceTransparency = false,
} = {}) {
  if (platform !== 'darwin' || reduceTransparency) {
    return false;
  }

  const rawPreference = env?.[OPAQUE_WINDOWS_ENV];
  if (rawPreference === undefined || String(rawPreference).trim() === '') {
    return defaultEnabled;
  }

  // Preserve the legacy escape-hatch contract: explicit false-like values
  // mean "do not force opaque windows". Any other supplied value requests
  // the lower-compositor-cost opaque fallback.
  return EXPLICIT_TRANSPARENCY_VALUES.has(
    String(rawPreference).trim().toLowerCase(),
  );
}

function getMacWindowVisualOptions({
  nativeTheme,
  platform = process.platform,
  env = process.env,
  defaultEnabled = true,
  reduceTransparency = false,
} = {}) {
  if (
    isMacSidebarVibrancyEnabled({
      platform,
      env,
      defaultEnabled,
      reduceTransparency,
    })
  ) {
    return {
      // Keep the native material on the app window itself. A separate
      // translucent companion window reintroduces the unblurred desktop when
      // its opacity is lowered and visibly reorders when the app gains focus.
      //
      // No `transparent: true` and no explicit alpha backgroundColor:
      // setting a vibrancy type already marks the window translucent and
      // Electron propagates a transparent WebContents background on its own,
      // while the `transparent` flag suppressed CSS cursors window-wide
      // (pointer cursors died app-wide when it landed on 2026-07-15).
      vibrancy: 'under-window',
      visualEffectState: 'active',
    };
  }

  const fallbackBackground = nativeTheme?.shouldUseDarkColors
    ? '#1e2324'
    : '#f5f5f5';
  return { backgroundColor: fallbackBackground };
}

module.exports = {
  NATIVE_SIDEBAR_VIBRANCY_ARGUMENT,
  OPAQUE_WINDOWS_ENV,
  getMacWindowVisualOptions,
  isMacSidebarVibrancyEnabled,
};
