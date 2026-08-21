/**
 * PORTICO PATCH: In-page Custom Highlight API local-find controller.
 *
 * This file is loaded as a string by `owui-local-find-controller.js` and
 * injected into the OWUI WebContentsView via executeJavaScript(). It must be
 * a self-contained IIFE that depends only on browser globals (CSS, Highlight,
 * MutationObserver, document, window).
 *
 * NEVER `require` anything here, NEVER use Node-only APIs.
 *
 * Concerns it addresses:
 *   - Match scoping: TreeWalker rooted at [data-portico-chat-root="true"] only
 *     (fixes E-10 sidebar/nav leakage).
 *   - Edit-in-place / composer: NodeFilter rejects textarea/input/contenteditable
 *     and any [data-portico-find-exclude] subtree (fixes E-13).
 *   - KaTeX double counts: NodeFilter rejects .katex-mathml and .sr-only
 *     (fixes E-14 KaTeX MathML mirror double-count).
 *   - Streaming: MutationObserver with rAF debounce; preserves the active match
 *     by textual identity across rebuilds (fixes E-11 active-match reset).
 *   - Theme parity: ::highlight() rules pull --portico-accent-* tokens, so theme
 *     toggles update colors automatically (fixes E-15).
 *   - Hidden history: this file does NOT itself trigger expansion; the existing
 *     find-bar.js _requestHiddenHistoryExpansion() flow remains the source of
 *     truth (fixes E-12 path). After the host expands hidden history, our
 *     MutationObserver picks up the new nodes and rebuilds.
 *   - Perf: per-call regex build, single TreeWalker pass, two reusable
 *     Highlight() instances, getBoundingClientRect only on navigate.
 *   - Detached windows: this controller installs once per WebContentsView; the
 *     existing _findInPageSessions per-window keying in owui-views handles
 *     isolation (fixes E-16).
 */
(() => {
  const NS = '__porticoAicLocalFind';
  const PASSIVE_KEY = 'portico-find';
  const ACTIVE_KEY = 'portico-find-active';
  const UPDATE_EVENT = 'portico-portico-local-find-update';
  const STYLE_ID = 'portico-portico-local-find-style';
  const ROOT_SELECTOR = '[data-portico-chat-root="true"]';
  const EXCLUDE_SELECTOR = [
    'textarea',
    'input',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[data-portico-find-exclude]',
    '.katex-mathml',
    '.sr-only',
    'script',
    'style',
    'noscript',
  ].join(',');

  const featureSupported =
    typeof CSS !== 'undefined' &&
    !!CSS.highlights &&
    typeof Highlight === 'function';

  if (window[NS] && window[NS].__version === 1) {
    return { supported: featureSupported, alreadyInstalled: true };
  }

  if (!featureSupported) {
    window[NS] = {
      __version: 1,
      supported: false,
      search: () => ({ supported: false, totalMatches: 0, activeOrdinal: 0 }),
      next: () => ({ supported: false, totalMatches: 0, activeOrdinal: 0 }),
      prev: () => ({ supported: false, totalMatches: 0, activeOrdinal: 0 }),
      stop: () => ({ supported: false, totalMatches: 0, activeOrdinal: 0 }),
    };
    return { supported: false, alreadyInstalled: false };
  }

  const META_PATTERN = /[.*+?^${}()|[\]\\]/g;

  function escapeRegex(s) {
    return String(s).replace(META_PATTERN, '\\$&');
  }

  function buildQueryRegex(query, options) {
    if (!query) return { regex: null, error: null };
    const flags = options && options.matchCase ? 'g' : 'gi';
    try {
      if (options && options.regex) {
        return { regex: new RegExp(query, flags), error: null };
      }
      return { regex: new RegExp(escapeRegex(query), flags), error: null };
    } catch (err) {
      return { regex: null, error: String((err && err.message) || err) };
    }
  }

  function ensureStyleEl() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    // PORTICO PATCH: match Chromium's native findInPage palette. The original
    // var(--portico-accent-fill / --portico-accent-text) tokens resolve to dark blue
    // in both light AND dark themes (#003a9b / #4f94ff with low-alpha fill),
    // which combined with the inherited dark text was unreadable. Yellow +
    // orange is what Chromium uses for findInPage and what users expect from
    // Cmd+G in this app.
    style.textContent = [
      '::highlight(' + PASSIVE_KEY + ') {',
      '  background-color: #fff062;',
      '  color: #000;',
      '}',
      '::highlight(' + ACTIVE_KEY + ') {',
      '  background-color: #ff9632;',
      '  color: #000;',
      '}',
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
  }

  function getRoots() {
    return Array.from(document.querySelectorAll(ROOT_SELECTOR));
  }

  function collectTextNodes(root) {
    const out = [];
    if (!root) return out;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.length) {
          return NodeFilter.FILTER_REJECT;
        }
        const parent = node.parentNode;
        if (!parent || parent.nodeType !== Node.ELEMENT_NODE) {
          return NodeFilter.FILTER_REJECT;
        }
        if (parent.closest(EXCLUDE_SELECTOR)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n = walker.nextNode();
    while (n) {
      out.push(n);
      n = walker.nextNode();
    }
    return out;
  }

  function findRanges(regex) {
    const ranges = [];
    if (!regex) return ranges;
    const roots = getRoots();
    for (const root of roots) {
      const nodes = collectTextNodes(root);
      for (const node of nodes) {
        const text = node.nodeValue;
        regex.lastIndex = 0;
        let match;
        while ((match = regex.exec(text)) !== null) {
          if (match[0].length === 0) {
            // Zero-width match guard: advance lastIndex to prevent infinite loop.
            regex.lastIndex += 1;
            continue;
          }
          const range = document.createRange();
          range.setStart(node, match.index);
          range.setEnd(node, match.index + match[0].length);
          ranges.push(range);
        }
      }
    }
    return ranges;
  }

  function publishUpdate(state, finalUpdate) {
    try {
      window.dispatchEvent(
        new CustomEvent(UPDATE_EVENT, {
          detail: {
            totalMatches: state.totalMatches,
            activeOrdinal: state.activeOrdinal,
            finalUpdate: finalUpdate !== false,
            error: state.error || null,
          },
        }),
      );
    } catch (_e) {
      /* swallow */
    }
  }

  function applyHighlights(state) {
    if (!CSS.highlights) return;
    const passive = state.passiveHighlight;
    const active = state.activeHighlight;
    passive.clear();
    active.clear();
    const ordinal = state.activeOrdinal;
    for (let i = 0; i < state.ranges.length; i += 1) {
      if (i + 1 === ordinal) {
        active.add(state.ranges[i]);
      } else {
        passive.add(state.ranges[i]);
      }
    }
    CSS.highlights.set(PASSIVE_KEY, passive);
    CSS.highlights.set(ACTIVE_KEY, active);
  }

  function clearHighlights(state) {
    if (state.passiveHighlight) state.passiveHighlight.clear();
    if (state.activeHighlight) state.activeHighlight.clear();
    if (CSS.highlights) {
      CSS.highlights.delete(PASSIVE_KEY);
      CSS.highlights.delete(ACTIVE_KEY);
    }
  }

  function scrollIntoViewActive(state) {
    const ord = state.activeOrdinal;
    if (!ord || !state.ranges[ord - 1]) return;
    try {
      const range = state.ranges[ord - 1];
      const rect = range.getBoundingClientRect();
      const elem = range.startContainer.parentElement;
      if (!elem) return;
      // PORTICO PATCH: measure visibility against the scrollable chat root
      // (i.e. [data-portico-chat-root]) — NOT against window.innerHeight. The
      // composer/input lives BELOW the chat root in the layout, so a match
      // whose bottom is above window.innerHeight but below the chat root's
      // bottom edge is visually hidden behind the composer. Using the chat
      // root rect ensures Cmd+G next/prev always scrolls hidden matches into
      // a genuinely visible region of the transcript.
      const scrollRoot = elem.closest(ROOT_SELECTOR);
      let topBound;
      let bottomBound;
      if (scrollRoot) {
        const rootRect = scrollRoot.getBoundingClientRect();
        topBound = rootRect.top;
        bottomBound = rootRect.bottom;
      } else {
        topBound = 0;
        bottomBound = window.innerHeight || document.documentElement.clientHeight;
      }
      if (rect.top < topBound || rect.bottom > bottomBound) {
        elem.scrollIntoView({ block: 'center', behavior: 'auto' });
      }
    } catch (_e) {
      /* swallow */
    }
  }

  function rebuild(state, options) {
    const opts = options || {};
    const { regex, error } = buildQueryRegex(state.query, {
      matchCase: state.matchCase,
      regex: state.regex,
    });
    if (error) {
      state.ranges = [];
      state.totalMatches = 0;
      state.activeOrdinal = 0;
      state.error = error;
      clearHighlights(state);
      return;
    }
    state.error = null;

    const previousActiveText =
      state.activeOrdinal > 0 && state.ranges[state.activeOrdinal - 1]
        ? state.ranges[state.activeOrdinal - 1].toString()
        : null;

    state.ranges = findRanges(regex);
    state.totalMatches = state.ranges.length;

    if (state.totalMatches === 0) {
      state.activeOrdinal = 0;
    } else if (opts.preserveActive && previousActiveText) {
      // Best-effort: pick first range whose textual content matches the
      // previous active text. Approximate because Range identity is unstable
      // across Svelte rebuilds during streaming.
      let nextOrdinal = 0;
      for (let i = 0; i < state.ranges.length; i += 1) {
        if (state.ranges[i].toString() === previousActiveText) {
          nextOrdinal = i + 1;
          break;
        }
      }
      state.activeOrdinal = nextOrdinal || 1;
    } else if (opts.findNext || state.activeOrdinal === 0) {
      state.activeOrdinal = 1;
    } else if (state.activeOrdinal > state.totalMatches) {
      state.activeOrdinal = state.totalMatches;
    }

    applyHighlights(state);
  }

  function startObserver(state) {
    // PORTICO PATCH (B2 fix): callers MUST stopObserver() before startObserver()
    // when they want to rebind (e.g. fresh search() after a conversation/route
    // change remounted [data-portico-chat-root]). The previous early-return on an
    // existing observer left it bound to a detached root, so streaming
    // MutationObserver updates silently stopped firing for E-11 / E-19 once
    // the user navigated to a different conversation in the same WebContentsView.
    if (state.observer) return;
    const roots = getRoots();
    if (!roots.length) return;
    const debounced = (() => {
      let frame = null;
      return () => {
        if (frame) cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          frame = null;
          if (!state.query) return;
          rebuild(state, { preserveActive: true });
          publishUpdate(state, false);
        });
      };
    })();
    const observer = new MutationObserver(debounced);
    for (const root of roots) {
      observer.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    }
    state.observer = observer;
  }

  function stopObserver(state) {
    if (state.observer) {
      state.observer.disconnect();
      state.observer = null;
    }
  }

  ensureStyleEl();

  const state = {
    query: '',
    matchCase: false,
    regex: false,
    ranges: [],
    totalMatches: 0,
    activeOrdinal: 0,
    error: null,
    passiveHighlight: new Highlight(),
    activeHighlight: new Highlight(),
    observer: null,
  };

  function snapshot() {
    return {
      supported: true,
      totalMatches: state.totalMatches,
      activeOrdinal: state.activeOrdinal,
      error: state.error,
    };
  }

  function search(query, options) {
    const opts = options || {};
    const text = typeof query === 'string' ? query : '';
    state.query = text;
    state.matchCase = opts.matchCase === true;
    state.regex = opts.regex === true;
    if (!text) {
      state.ranges = [];
      state.totalMatches = 0;
      state.activeOrdinal = 0;
      state.error = null;
      clearHighlights(state);
      stopObserver(state);
      publishUpdate(state, true);
      return snapshot();
    }
    rebuild(state, { findNext: opts.findNext === true });
    // PORTICO PATCH (B2 fix): rebind observer on every search call so a
    // remounted chat root (conversation switch within the same
    // WebContentsView) gets a live observer instead of a detached one.
    stopObserver(state);
    startObserver(state);
    scrollIntoViewActive(state);
    publishUpdate(state, true);
    return snapshot();
  }

  function navigate(forward) {
    if (state.totalMatches === 0) {
      publishUpdate(state, true);
      return snapshot();
    }
    const cur = state.activeOrdinal || 0;
    let next;
    if (cur === 0) {
      next = forward ? 1 : state.totalMatches;
    } else if (forward) {
      next = cur >= state.totalMatches ? 1 : cur + 1;
    } else {
      next = cur <= 1 ? state.totalMatches : cur - 1;
    }
    state.activeOrdinal = next;
    applyHighlights(state);
    scrollIntoViewActive(state);
    publishUpdate(state, true);
    return snapshot();
  }

  function stop() {
    stopObserver(state);
    state.query = '';
    state.matchCase = false;
    state.regex = false;
    state.ranges = [];
    state.totalMatches = 0;
    state.activeOrdinal = 0;
    state.error = null;
    clearHighlights(state);
    publishUpdate(state, true);
    return snapshot();
  }

  window[NS] = {
    __version: 1,
    supported: true,
    search,
    next: () => navigate(true),
    prev: () => navigate(false),
    stop,
  };

  return { supported: true, alreadyInstalled: false };
})();
