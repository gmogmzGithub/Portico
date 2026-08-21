/**
 * Theme initialization and toggle functionality
 * Defaults to dark mode until the user explicitly chooses otherwise
 * Also syncs theme to Open WebUI webview
 */
(function() {
  // Apply a theme locally: update DOM attribute, localStorage, and webviews
  function applyTheme(themeName) {
    document.documentElement.setAttribute('data-theme', themeName);
    localStorage.setItem('theme', themeName);
    syncThemeToAllWebviews(themeName);
  }

  // Fast synchronous path: apply from localStorage or the dark default
  const savedTheme = localStorage.getItem('theme');
  const theme = savedTheme || 'dark';
  document.documentElement.setAttribute('data-theme', theme);

  // Sync with main process so all windows share the same theme
  if (window.electronAPI) {
    window.electronAPI.getTheme().then(mainTheme => {
      if (savedTheme) {
        if (savedTheme !== mainTheme) {
          window.electronAPI.setTheme(savedTheme);
        }
        if (savedTheme !== document.documentElement.getAttribute('data-theme')) {
          applyTheme(savedTheme);
        }
      } else if (mainTheme && mainTheme !== theme) {
        applyTheme(mainTheme);
      } else if (!mainTheme) {
        window.electronAPI.setTheme(theme);
      }
    }).catch(() => {});

    // Listen for theme changes broadcast from other windows
    window.electronAPI.onThemeChanged((newTheme) => {
      if (newTheme && newTheme !== document.documentElement.getAttribute('data-theme')) {
        applyTheme(newTheme);
      }
    });
  }

  const contextUtilizationCss = `
    html.dark .min-w-\\[240px\\].max-w-\\[320px\\].dark\\:bg-gray-800,
    html.dark .min-w-\\[160px\\].max-w-\\[280px\\].dark\\:bg-gray-800,
    html.dark .absolute.bottom-full.left-1\\/2.-translate-x-1\\/2.dark\\:bg-gray-800 {
      background-color: #000000 !important;
    }

    html.dark .min-w-\\[240px\\].max-w-\\[320px\\] .dark\\:border-t-gray-800,
    html.dark .min-w-\\[160px\\].max-w-\\[280px\\] .dark\\:border-t-gray-800,
    html.dark .absolute.bottom-full.left-1\\/2.-translate-x-1\\/2 .dark\\:border-t-gray-800 {
      border-top-color: #000000 !important;
    }

    html.dark .group.relative.flex.items-center.gap-1.ml-3.cursor-pointer svg.-rotate-90 circle[stroke-linecap="round"] {
      stroke: #ffffff !important;
    }
  `;

  function buildWebviewThemeScript(themeName, options = {}) {
    const openWebuiTheme = themeName;
    const metaThemeColor = openWebuiTheme === 'dark' ? '#171717' : '#ffffff';
    const serializedContextCss = JSON.stringify(contextUtilizationCss);
    const shouldLog = options.log === true;
    const logScript = shouldLog
      ? "console.log('[Theme Sync] Open WebUI theme set to: " + openWebuiTheme + "');"
      : "";

    return `
      (function() {
        // Update localStorage
        localStorage.setItem('theme', '${openWebuiTheme}');
        
        // Remove all theme classes and add the new one
        document.documentElement.classList.remove('dark', 'light', 'her');
        document.documentElement.classList.add('${openWebuiTheme}');
        
        // Update meta theme-color tag
        const meta = document.querySelector('meta[name="theme-color"]');
        if (meta) {
          meta.setAttribute('content', '${metaThemeColor}');
        }
        
        // Reset OLED-specific CSS custom properties if switching away from OLED
        if ('${openWebuiTheme}' === 'dark') {
          document.documentElement.style.setProperty('--color-gray-800', '#333');
          document.documentElement.style.setProperty('--color-gray-850', '#262626');
          document.documentElement.style.setProperty('--color-gray-900', '#171717');
          document.documentElement.style.setProperty('--color-gray-950', '#0d0d0d');
        }

        const styleId = 'owui-context-utilization-theme';
        let styleEl = document.getElementById(styleId);
        if (!styleEl) {
          styleEl = document.createElement('style');
          styleEl.id = styleId;
          document.head.appendChild(styleEl);
        }
        styleEl.textContent = ${serializedContextCss};

        ${logScript}
      })();
    `;
  }

  /**
   * Sync theme to the Open WebUI webview
   * This ensures Open WebUI's theme matches the Electron app theme
   * @param {string} themeName - 'dark' or 'light'
   */
  function syncThemeToWebview(themeName) {
    const webview = document.getElementById('chat-webview');
    if (!webview) {
      return;
    }

    const viewKey = webview.dataset?.owuiViewKey;
    if (viewKey && window.electronAPI?.owui?.setTheme) {
      window.electronAPI.owui.setTheme(viewKey, themeName).catch(err => {
        console.log('[Theme Sync] Failed to sync theme to OWUI host:', err.message);
      });
      return;
    }

    if (typeof webview.executeJavaScript !== 'function') {
      return;
    }

    const syncScript = buildWebviewThemeScript(themeName, { log: true });
    webview.executeJavaScript(syncScript).catch(err => {
      console.log('[Theme Sync] Failed to sync theme to webview:', err.message);
    });
  }

  // Also sync to conversation webviews (subagent tabs)
  function syncThemeToAllWebviews(themeName) {
    // Sync to main chat webview
    syncThemeToWebview(themeName);

    // Sync to any open conversation webviews
    const conversationWebviews = document.querySelectorAll('[id^="conversation-webview-"]');
    conversationWebviews.forEach(webview => {
      const viewKey = webview?.dataset?.owuiViewKey;
      if (viewKey && window.electronAPI?.owui?.setTheme) {
        window.electronAPI.owui.setTheme(viewKey, themeName).catch(err => {
          console.log('[Theme Sync] Failed to sync theme to conversation OWUI host:', err.message);
        });
        return;
      }

      if (webview && typeof webview.executeJavaScript === 'function') {
        const syncScript = buildWebviewThemeScript(themeName);

        webview.executeJavaScript(syncScript).catch(err => {
          console.log('[Theme Sync] Failed to sync theme to conversation webview:', err.message);
        });
      }
    });
  }

  // Export syncThemeToWebview globally for use by other components
  window.syncThemeToWebview = syncThemeToWebview;
  window.syncThemeToAllWebviews = syncThemeToAllWebviews;

  const KONAMI_REQUIRED_RAPID_CLICKS = 10;
  const KONAMI_MAX_GAP_MS = 400;
  let konamiPressTimestamps = [];
  let konamiPressSequence = 0;
  let konamiUnlocked = false;
  let konamiUnlockPending = false;
  let konamiModalBound = false;

  function logKonami(level, message, meta = {}) {
    const payload = {
      level,
      message: `[Konami:Renderer] ${message}`,
      meta: {
        konami: true,
        konamiLayer: 'Renderer',
        ...meta,
      },
    };

    if (window.electronAPI?.logToMain) {
      window.electronAPI.logToMain(payload);
      return;
    }

    if (level === 'error') {
      console.error(payload.message, payload.meta);
    } else if (level === 'warn') {
      console.warn(payload.message, payload.meta);
    } else {
      console.info(payload.message, payload.meta);
    }
  }

  function getKonamiViewKey() {
    const mainWebview = document.getElementById('chat-webview');
    const viewKey = mainWebview?.dataset?.owuiViewKey;
    return typeof viewKey === 'string' && viewKey.trim() ? viewKey : 'main';
  }

  function setKonamiModalSuppressed(visible) {
    if (window.setNativeOverlayInteractionSuppressed) {
      window.setNativeOverlayInteractionSuppressed('konami-modal', visible);
      return;
    }
    window.setOwuiInteractionSuppressed?.('konami-modal', visible);
  }

  function setKonamiModalVisible(visible) {
    const modal = document.getElementById('konami-modal');
    if (!modal) {
      logKonami('warn', 'Konami modal element is missing', {
        phase: 'modal-visibility',
        visible: Boolean(visible),
      });
      return;
    }

    if (visible) {
      modal.classList.add('visible');
      modal.setAttribute('aria-hidden', 'false');
    } else {
      modal.classList.remove('visible');
      modal.setAttribute('aria-hidden', 'true');
    }

    setKonamiModalSuppressed(Boolean(visible));
    logKonami('info', visible ? 'Showing Konami modal' : 'Hiding Konami modal', {
      phase: 'modal-visibility',
      visible: Boolean(visible),
    });
  }

  function hideKonamiModal() {
    setKonamiModalVisible(false);
  }

  function showKonamiModal() {
    setKonamiModalVisible(true);
  }

  function bindKonamiModal() {
    if (konamiModalBound) {
      return;
    }

    const modal = document.getElementById('konami-modal');
    const dismissButton = document.getElementById('konami-dismiss-btn');
    const closeButton = document.getElementById('konami-close-btn');

    if (!modal || !dismissButton || !closeButton) {
      logKonami('warn', 'Konami modal controls were not all found during binding', {
        phase: 'modal-bind',
        hasModal: Boolean(modal),
        hasDismissButton: Boolean(dismissButton),
        hasCloseButton: Boolean(closeButton),
      });
      return;
    }

    dismissButton.addEventListener('click', hideKonamiModal);
    closeButton.addEventListener('click', hideKonamiModal);
    modal.addEventListener('click', (event) => {
      if (event.target === modal) {
        hideKonamiModal();
      }
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && modal.classList.contains('visible')) {
        hideKonamiModal();
      }
    });

    konamiModalBound = true;
    logKonami('info', 'Bound Konami modal controls', {
      phase: 'modal-bind',
    });
  }

  function normalizeKonamiPressTimestamp(event) {
    const eventTimestamp = Number(event?.timeStamp);
    if (Number.isFinite(eventTimestamp) && eventTimestamp >= 0) {
      return eventTimestamp;
    }
    return Date.now();
  }

  function recordKonamiRapidPress(event) {
    if (typeof event?.button === 'number' && event.button !== 0) {
      logKonami('debug', 'Ignored Konami rapid press because it was not a primary-button press', {
        phase: 'rapid-press',
        reason: 'non-primary-button',
        button: event.button,
      });
      return {
        accepted: false,
        qualifies: false,
        reason: 'non-primary-button',
      };
    }

    const timestamp = normalizeKonamiPressTimestamp(event);
    const previousTimestamp =
      konamiPressTimestamps.length > 0
        ? konamiPressTimestamps[konamiPressTimestamps.length - 1]
        : null;
    const gapMs =
      previousTimestamp === null ? null : timestamp - previousTimestamp;

    konamiPressSequence += 1;
    konamiPressTimestamps.push(timestamp);
    if (konamiPressTimestamps.length > KONAMI_REQUIRED_RAPID_CLICKS) {
      konamiPressTimestamps = konamiPressTimestamps.slice(-KONAMI_REQUIRED_RAPID_CLICKS);
    }

    let failureGapMs = null;
    for (let index = 1; index < konamiPressTimestamps.length; index += 1) {
      const candidateGap = konamiPressTimestamps[index] - konamiPressTimestamps[index - 1];
      if (candidateGap > KONAMI_MAX_GAP_MS) {
        failureGapMs = candidateGap;
        break;
      }
    }

    const qualifies =
      konamiPressTimestamps.length >= KONAMI_REQUIRED_RAPID_CLICKS &&
      failureGapMs === null;

    const details = {
      accepted: true,
      sequence: konamiPressSequence,
      timestamp,
      gapMs,
      windowSize: konamiPressTimestamps.length,
      qualifies,
      failureGapMs,
      unlocked: konamiUnlocked,
      pending: konamiUnlockPending,
    };

    logKonami('info', 'Recorded Konami rapid press', {
      phase: 'rapid-press',
      ...details,
    });

    return details;
  }

  function applyKonamiUnlockChanged(payload = {}) {
    const previousUnlocked = konamiUnlocked;
    konamiUnlocked = Boolean(payload.unlocked);
    if (!konamiUnlocked) {
      konamiPressTimestamps = [];
    }
    logKonami('info', 'Applied Konami unlock state change', {
      phase: 'unlock-change',
      previousUnlocked,
      nextUnlocked: konamiUnlocked,
      payload,
    });
  }

  async function initializeKonamiUnlock() {
    bindKonamiModal();

    logKonami('info', 'Initializing Konami unlock state', {
      phase: 'initialize',
      hasKonamiBridge: Boolean(window.electronAPI?.konami),
      hasLogBridge: Boolean(window.electronAPI?.logToMain),
      viewKey: getKonamiViewKey(),
    });

    if (!window.electronAPI?.konami) {
      logKonami('warn', 'Konami bridge is unavailable during initialization', {
        phase: 'initialize',
      });
      return;
    }

    window.electronAPI.konami.onChanged?.((payload) => {
      logKonami('info', 'Received Konami unlock broadcast from main process', {
        phase: 'unlock-change',
        payload,
      });
      applyKonamiUnlockChanged(payload);
    });

    try {
      logKonami('info', 'Requesting Konami persisted state from main process', {
        phase: 'initialize',
        viewKey: getKonamiViewKey(),
      });
      const state = await window.electronAPI.konami.getState({
        viewKey: getKonamiViewKey(),
      });
      if (state?.unlocked || !konamiUnlocked) {
        applyKonamiUnlockChanged(state || {});
      }

      logKonami('info', 'Konami persisted state request completed', {
        phase: 'initialize',
        viewKey: getKonamiViewKey(),
        state,
      });

      if (!state?.success && state?.error) {
        logKonami('warn', 'Konami persisted state request returned a non-success result', {
          phase: 'initialize',
          error: state.error,
          state,
        });
        console.warn('[Konami] Failed to initialize unlock state:', state.error);
      }
    } catch (error) {
      logKonami('error', 'Konami persisted state request threw an exception', {
        phase: 'initialize',
        error: error?.message || String(error),
      });
      console.warn('[Konami] Failed to initialize unlock state:', error?.message || error);
    }
  }

  async function maybeTriggerKonamiUnlock(event) {
    if (konamiUnlocked || konamiUnlockPending || !window.electronAPI?.konami?.unlock) {
      logKonami('debug', 'Skipped Konami unlock trigger before evaluation', {
        phase: 'unlock-trigger-skip',
        konamiUnlocked,
        konamiUnlockPending,
        hasUnlockBridge: Boolean(window.electronAPI?.konami?.unlock),
      });
      return;
    }

    const press = recordKonamiRapidPress(event);
    if (!press?.qualifies) {
      return;
    }

    logKonami('info', 'Konami rapid press threshold met; starting unlock request', {
      phase: 'unlock-request',
      viewKey: getKonamiViewKey(),
      press,
    });

    konamiUnlockPending = true;

    try {
      const result = await window.electronAPI.konami.unlock({
        viewKey: getKonamiViewKey(),
      });

      logKonami('info', 'Konami unlock IPC request completed', {
        phase: 'unlock-result',
        viewKey: getKonamiViewKey(),
        result,
      });

      if (result?.success && result?.unlocked) {
        konamiUnlocked = true;
        if (result?.alreadyUnlocked !== true) {
          showKonamiModal();
        }
        return;
      }

      if (!result?.success && result?.error) {
        logKonami('warn', 'Konami unlock IPC request returned a non-success result', {
          phase: 'unlock-result',
          viewKey: getKonamiViewKey(),
          result,
        });
        console.warn('[Konami] Failed to unlock GPT-5.6 Sol Pro immediately:', result.error);
      }
    } catch (error) {
      logKonami('error', 'Konami unlock IPC request threw an exception', {
        phase: 'unlock-result',
        viewKey: getKonamiViewKey(),
        error: error?.message || String(error),
      });
      console.warn('[Konami] Failed to unlock GPT-5.6 Sol Pro immediately:', error?.message || error);
    } finally {
      konamiUnlockPending = false;
      logKonami('info', 'Konami unlock request settled', {
        phase: 'unlock-result',
        pending: konamiUnlockPending,
        unlocked: konamiUnlocked,
      });
    }
  }

  // Theme toggle handler - set up after DOM is ready
  document.addEventListener('DOMContentLoaded', () => {
    const toggle = document.getElementById('theme-toggle');
    logKonami('info', 'Konami detector bootstrap on DOMContentLoaded', {
      phase: 'bootstrap',
      toggleFound: Boolean(toggle),
      hasKonamiBridge: Boolean(window.electronAPI?.konami),
      hasLogBridge: Boolean(window.electronAPI?.logToMain),
      viewKey: getKonamiViewKey(),
    });

    if (toggle) {
      toggle.addEventListener('pointerdown', (event) => {
        void maybeTriggerKonamiUnlock(event);
      });
      toggle.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme');
        const next = current === 'dark' ? 'light' : 'dark';
        applyTheme(next);

        // Broadcast to all other windows via main process
        if (window.electronAPI) {
          window.electronAPI.setTheme(next);
        }
      });
    } else {
      logKonami('warn', 'Theme toggle was not found during Konami bootstrap', {
        phase: 'bootstrap',
      });
    }

    void initializeKonamiUnlock();
  });
})();
