// Artifact Indicator Service
// Headless backend service that tracks artifacts for the current chat
// and handles actions from the webview (via ipc-message)
// UI is handled by ActiveCapabilities.svelte in the webview

class ArtifactIndicator {
  constructor() {
    this.currentChatId = null;
    this.artifacts = [];
    this.detachedWindows = [];
    this.artifactsByChatId = new Map();
    this.detachedWindowsByChatId = new Map();
    this.webviewChatIds = new WeakMap();
    this.actionBoundWebviews = new WeakSet();
    this.navigationBoundWebviews = new WeakSet();
    this.lastArtifactPerChat = {}; // Track last open artifact per chat for auto-restore
    this.runningArtifacts = new Map(); // artifact_id -> boolean (tracks running status)
    this.sessionPreferredVersions = new Map(); // artifact_id -> version (user-selected in this session)

    this.initEventListeners();
    this.setupActionListener();
    this.setupChatChangeDetection();
  }

  initEventListeners() {
    // Listen for artifact events from Electron main process
    if (window.electronAPI) {
      window.electronAPI.onArtifactOpen((data) => {
        console.log('[ArtifactIndicator] Artifact opened:', data);

        // Get chat_id from event data, or extract from the active tab's loaded OWUI URL.
        let chatId = data.chat_id;
        if (!chatId) {
          chatId = this.getLoadedChatIdForTabKey(window.appState?.activeTab || 'chat');
          console.log('[ArtifactIndicator] Extracted chat_id from webview URL:', chatId);
        }

        if (chatId) {
          // Immediately add this artifact to our local list (don't wait for list_artifacts API)
          const artifactInfo = {
            artifact_id: data.artifact_id,
            name: data.name || 'Artifact',
            current_version: data.version || 1,
            preview_url: data.preview_url
          };

          const artifacts = [...this.getArtifactsForChat(chatId)];
          // Check if artifact already exists in our list
          const existingIndex = artifacts.findIndex(a => a.artifact_id === data.artifact_id);
          if (existingIndex >= 0) {
            artifacts[existingIndex] = artifactInfo;
          } else {
            artifacts.push(artifactInfo);
          }
          this.setArtifactsForChat(chatId, artifacts);

          console.log('[ArtifactIndicator] Added artifact to local list, count:', artifacts.length);
          // Opening implies the artifact server is expected to be running.
          this.runningArtifacts.set(data.artifact_id, true);
          this.notifyWebviewOfArtifacts(chatId);
        } else {
          console.warn('[ArtifactIndicator] Ignoring artifact-open without a loaded target chat:', data);
          this.notifyWebviewOfArtifacts();
        }
      });

      window.electronAPI.onArtifactClose((data) => {
        console.log('[ArtifactIndicator] Artifact closed:', data);
        if (data?.artifact_id) {
          this.runningArtifacts.set(data.artifact_id, false);
        }
        this.refreshFromCurrentChat();
      });

      window.electronAPI.onArtifactWindowClosed((data) => {
        console.log('[ArtifactIndicator] Detached window closed:', data);
        if (data?.artifactId) {
          const panelArtifactId = window.artifactPanel?.currentArtifact?.artifact_id;
          if (panelArtifactId !== data.artifactId) {
            this.runningArtifacts.set(data.artifactId, false);
          }
          // Remove from detachedWindows
          this.detachedWindows = this.detachedWindows.filter(w => w.artifactId !== data.artifactId);
          for (const [chatId, windows] of this.detachedWindowsByChatId.entries()) {
            this.detachedWindowsByChatId.set(
              chatId,
              windows.filter(w => w.artifactId !== data.artifactId)
            );
          }
        }
        this.refreshFromCurrentChat();
      });

      // Listen for detached window opened
      console.log('[ArtifactIndicator] Registering onArtifactWindowOpened listener, function exists:', !!window.electronAPI.onArtifactWindowOpened);
      window.electronAPI.onArtifactWindowOpened?.((data) => {
        console.log('[ArtifactIndicator] >>> RECEIVED artifact-window-opened event:', JSON.stringify(data));
        if (data?.artifactId) {
          // Add to detachedWindows immediately (avoid duplicates)
          const chatId = data.chatId || this.getLoadedChatIdForTabKey(window.appState?.activeTab || 'chat');
          if (!chatId) {
            console.warn('[ArtifactIndicator] Ignoring detached artifact window without a loaded target chat:', data);
            this.notifyWebviewOfArtifacts();
            return;
          }
          const windowsForChat = [...this.getDetachedWindowsForChat(chatId)];
          if (!windowsForChat.some(w => w.artifactId === data.artifactId)) {
            windowsForChat.push({
              artifactId: data.artifactId,
              chatId,
              name: data.name,
              previewUrl: data.previewUrl,
              windowId: data.windowId
            });
            this.setDetachedWindowsForChat(chatId, windowsForChat);
          }
          this.runningArtifacts.set(data.artifactId, true);
          this.notifyWebviewOfArtifacts(chatId);
        }
      });

      // Listen for version changes
      window.electronAPI.onArtifactVersionChanged((data) => {
        console.log('[ArtifactIndicator] Version changed:', data);

        let updatedChatId = null;
        for (const [chatId, artifacts] of this.artifactsByChatId.entries()) {
          const artifact = artifacts.find(a => a.artifact_id === data.artifact_id);
          if (artifact) {
            artifact.current_version = data.version;
            if (data.host_port) {
              artifact.host_port = data.host_port;
              artifact.preview_url = `http://localhost:${data.host_port}`;
            } else if (data.preview_url) {
              artifact.preview_url = data.preview_url;
            }
            updatedChatId = chatId;
          }
        }
        const currentArtifact = this.artifacts.find(a => a.artifact_id === data.artifact_id);
        if (currentArtifact) {
          currentArtifact.current_version = data.version;
        }
        if (updatedChatId || currentArtifact) {
          console.log('[ArtifactIndicator] Updated artifact version to:', data.version);
          this.notifyWebviewOfArtifacts(updatedChatId || this.currentChatId);
        }
      });

      window.electronAPI.onArtifactSessionVersionSelected?.((data) => {
        if (data?.artifact_id && Number.isInteger(data.version)) {
          this.setSessionPreferredVersion(data.artifact_id, data.version);
        }
      });
    }
  }

  getArtifactsForChat(chatId = this.currentChatId) {
    if (!chatId) {
      return this.artifacts;
    }
    return this.artifactsByChatId.get(chatId) || [];
  }

  setArtifactsForChat(chatId, artifacts) {
    const nextArtifacts = Array.isArray(artifacts) ? artifacts : [];
    if (chatId) {
      this.artifactsByChatId.set(chatId, nextArtifacts);
      if (chatId === this.currentChatId) {
        this.artifacts = nextArtifacts;
      }
    } else {
      this.artifacts = nextArtifacts;
    }
  }

  getDetachedWindowsForChat(chatId = this.currentChatId) {
    if (!chatId) {
      return this.detachedWindows;
    }
    return this.detachedWindowsByChatId.get(chatId) || [];
  }

  setDetachedWindowsForChat(chatId, windows = []) {
    const nextWindows = Array.isArray(windows) ? windows : [];
    if (chatId) {
      this.detachedWindowsByChatId.set(chatId, nextWindows);
      if (chatId === this.currentChatId) {
        this.detachedWindows = nextWindows;
      }
    } else {
      this.detachedWindows = nextWindows;
    }
  }

  getTabKeyForWebview(webview) {
    const id = webview?.id || '';
    const match = id.match(/^conversation-webview-(.+)$/);
    return match ? `conversation-${match[1]}` : 'chat';
  }

  setupActionListener() {
    // Listen for action requests from webview via ipc-message (sendToHost)
    const setupListener = () => {
      const webviews = Array.from(document.querySelectorAll('.chat-webview'));
      if (webviews.length > 0) {
        for (const webview of webviews) {
          if (this.actionBoundWebviews.has(webview)) {
            continue;
          }
          this.actionBoundWebviews.add(webview);
          webview.addEventListener('ipc-message', (event) => {
            if (event.channel !== 'artifact-action') {
              return;
            }

            const payload = event.args?.[0];
            if (!payload || typeof payload !== 'object') {
              console.error('[ArtifactIndicator] Invalid artifact action payload:', payload);
              return;
            }

            const { action, artifact_id } = payload;
            if (!action || !artifact_id) {
              console.error('[ArtifactIndicator] Missing action or artifact_id:', payload);
              return;
            }

            console.log('[ArtifactIndicator] Received action from webview:', action, artifact_id);
            const loadedChatId = this.getLoadedChatIdForWebview(webview);
            const payloadChatId = payload.chat_id || payload.chatId || null;
            if (!loadedChatId || (payloadChatId && payloadChatId !== loadedChatId)) {
              console.warn('[ArtifactIndicator] Ignoring artifact action from webview without matching loaded chat:', {
                action,
                artifact_id,
                payloadChatId,
                loadedChatId,
              });
              this.notifyWebviewOfArtifacts();
              return;
            }
            const sourceChatId = payloadChatId || loadedChatId;
            this.executeAction(action, artifact_id, sourceChatId);
          });
          console.log('[ArtifactIndicator] IPC action listener set up for', webview.id || webview.dataset?.owuiViewKey || 'chat-webview');
        }
      }
      setTimeout(setupListener, 1000);
    };

    setupListener();
  }

  executeAction(action, artifactId, chatId = this.currentChatId) {
    const artifact = this.getArtifactsForChat(chatId).find(a => a.artifact_id === artifactId) ||
      this.artifacts.find(a => a.artifact_id === artifactId);

    // Multi-chat tiling: windowed-only applies only when the tab OWNING this
    // chat is tiled — 'open'/'attach' become open-window there. Other tabs
    // keep inline attach even while a different tab runs a tiled workflow.
    if (
      window.artifactPanel?.isMultiChatActiveForChatId?.(chatId) &&
      (action === 'open' || action === 'attach')
    ) {
      if (artifact) {
        this.handleOpenInWindow(artifact, chatId);
      } else {
        console.error('[ArtifactIndicator] Artifact not found for windowed open:', artifactId);
      }
      return;
    }

    switch (action) {
      case 'open':
        if (artifact) {
          this.handleOpen(artifact, chatId);
        } else {
          console.error('[ArtifactIndicator] Artifact not found for open:', artifactId);
        }
        break;
      case 'open-window':
        // Open artifact in a new detached window (when panel is occupied by another artifact)
        if (artifact) {
          this.handleOpenInWindow(artifact, chatId);
        } else {
          console.error('[ArtifactIndicator] Artifact not found for open-window:', artifactId);
        }
        break;
      case 'detach':
        if (artifact) {
          this.handleDetach(artifact, chatId);
        } else {
          console.error('[ArtifactIndicator] Artifact not found for detach:', artifactId);
        }
        break;
      case 'attach':
        this.handleAttach(artifactId, chatId);
        break;
      default:
        console.error('[ArtifactIndicator] Unknown action:', action);
    }
  }

  async setChatId(chatId) {
    this.currentChatId = chatId;
    await this.refresh();
  }

  async refresh() {
    if (!this.currentChatId || !window.electronAPI) {
      this.notifyWebviewOfArtifacts();
      return;
    }

    try {
      // Fetch artifacts for this chat
      console.log('[ArtifactIndicator] Fetching artifacts for chat:', this.currentChatId);
      const [artifactResult, detachedResult] = await Promise.all([
        window.electronAPI.artifacts.getList(this.currentChatId),
        window.electronAPI.artifacts.getDetachedWindows()
      ]);

      console.log('[ArtifactIndicator] getList result:', JSON.stringify(artifactResult));
      const apiArtifacts = artifactResult.success ? artifactResult.artifacts : [];
      const allDetachedWindows = detachedResult.success ? detachedResult.windows : [];

      // Filter detached windows to only show those for this chat
      this.setDetachedWindowsForChat(
        this.currentChatId,
        allDetachedWindows.filter(w => w.chatId === this.currentChatId)
      );

      if (artifactResult.success) {
        this.setArtifactsForChat(this.currentChatId, apiArtifacts);
        console.log('[ArtifactIndicator] Using', apiArtifacts.length, 'artifacts from API');
      }

      // Fetch running status for all artifacts
      await this.fetchAllRunningStatus();

      this.notifyWebviewOfArtifacts(this.currentChatId);
    } catch (error) {
      console.error('[ArtifactIndicator] Failed to refresh:', error);
    }
  }

  async refreshFromCurrentChat() {
    setTimeout(() => this.refresh(), 100);
  }

  // Fetch running status for all artifacts
  async fetchAllRunningStatus() {
    if (!window.electronAPI?.artifacts?.getRunningVersions) {
      return;
    }

    for (const artifact of this.artifacts) {
      try {
        const result = await window.electronAPI.artifacts.getRunningVersions(artifact.artifact_id);
        const hasRunning = result.success && result.running_versions?.length > 0;
        this.runningArtifacts.set(artifact.artifact_id, hasRunning);
      } catch (e) {
        console.error('[ArtifactIndicator] Failed to get running status for', artifact.artifact_id, e);
        this.runningArtifacts.set(artifact.artifact_id, false);
      }
    }
  }

  async fetchAllRunningStatusForChat(chatId) {
    if (!window.electronAPI?.artifacts?.getRunningVersions) {
      return;
    }

    for (const artifact of this.getArtifactsForChat(chatId)) {
      try {
        const result = await window.electronAPI.artifacts.getRunningVersions(artifact.artifact_id);
        const hasRunning = result.success && result.running_versions?.length > 0;
        this.runningArtifacts.set(artifact.artifact_id, hasRunning);
      } catch (e) {
        console.error('[ArtifactIndicator] Failed to get running status for', artifact.artifact_id, e);
        this.runningArtifacts.set(artifact.artifact_id, false);
      }
    }
  }

  setSessionPreferredVersion(artifactId, version) {
    if (!artifactId || !Number.isInteger(version)) return;
    this.sessionPreferredVersions.set(artifactId, version);
    console.log('[ArtifactIndicator] Session version preference set:', artifactId, version);
    this.notifyWebviewOfArtifacts();
  }

  getSessionPreferredVersion(artifactId) {
    return this.sessionPreferredVersions.get(artifactId);
  }

  getLatestVersion(artifact) {
    let latest = null;
    if (artifact?.versions?.length) {
      const versions = artifact.versions
        .map(v => Number.parseInt(v.version, 10))
        .filter(Number.isFinite);
      if (versions.length > 0) {
        latest = Math.max(...versions);
      }
    }
    const current = Number.parseInt(artifact?.current_version, 10);
    if (Number.isFinite(current)) {
      latest = Number.isFinite(latest) ? Math.max(latest, current) : current;
    }
    return latest || 1;
  }

  getPreferredVersionInfo(artifact) {
    const preferred = this.getSessionPreferredVersion(artifact.artifact_id);
    if (Number.isInteger(preferred)) {
      return { version: preferred, isPreferred: true };
    }
    return { version: this.getLatestVersion(artifact), isPreferred: false };
  }

  async handleAttach(artifactId, chatId = this.currentChatId) {
    if (window.artifactPanel?.isMultiChatActiveForChatId?.(chatId)) {
      console.log('[ArtifactIndicator] Chat tab is tiled; attach is disabled (windowed-only)');
      return;
    }
    console.log('[ArtifactIndicator] Attaching artifact:', artifactId);
    try {
      const artifact = this.getArtifactsForChat(chatId).find(a => a.artifact_id === artifactId) ||
        this.artifacts.find(a => a.artifact_id === artifactId);
      if (!artifact) {
        console.error('[ArtifactIndicator] Artifact not found for attach:', artifactId);
        return;
      }

      const canAttach = window.artifactPanel?.canAttachArtifactToChat?.(chatId, artifactId) ?? true;
      if (!canAttach) {
        console.log('[ArtifactIndicator] Target tab already has a different attached artifact; leaving detached');
        return;
      }

      const isDetached = this.getDetachedWindowsForChat(chatId).some(w => w.artifactId === artifactId);
      if (isDetached) {
        await window.electronAPI.artifacts.attach(artifactId, chatId);
      } else {
        await this.openArtifact(artifact, { detached: false, chatId });
      }

      // Refresh to update state
      setTimeout(() => this.refreshFromCurrentChat(), 200);
    } catch (error) {
      console.error('[ArtifactIndicator] Failed to attach:', error);
    }
  }

  async handleDetach(artifact, chatId = this.currentChatId) {
    console.log('[ArtifactIndicator] Detaching artifact:', artifact.artifact_id);
    if (window.artifactPanel) {
      // Wait for detach to complete (creates the detached window)
      const result = await window.artifactPanel.detach();

      if (result?.success) {
        // Now refresh to get updated detached windows list
        // The refresh() will fetch the new detachedWindows from main process
        // and call notifyWebviewOfArtifacts() with correct isDetached flags
        await this.refresh();
      }
    }
  }

  async openArtifact(artifact, { detached, chatId = this.currentChatId } = {}) {
    console.log('[ArtifactIndicator] Opening artifact:', artifact.artifact_id, 'detached:', detached);
    console.log('[ArtifactIndicator] Artifact data:', JSON.stringify(artifact));

    // For DETACHED windows: create window IMMEDIATELY for instant user feedback
    // The window will show its own loading spinner while the server starts
    if (detached) {
      // Create window immediately if we have a preview_url
      if (artifact.preview_url && window.electronAPI?.artifacts?.detach) {
        const preferredVersion = this.getSessionPreferredVersion(artifact.artifact_id);
        console.log('[ArtifactIndicator] Creating detached window immediately for:', artifact.name);
        // Don't await - let window creation happen in parallel with API call
        window.electronAPI.artifacts.detach(
          artifact.artifact_id,
          artifact.preview_url,
          artifact.name,
          chatId,
          artifact.current_version,
          Number.isInteger(preferredVersion) ? preferredVersion : null
        );
      }
      // Don't show any loading in main panel for detached windows
    } else {
      // For PANEL opens: show loading in panel if server needs to start
      // Note: running_vm_id is internal - just check status
      const needsRestore = artifact.status !== 'running';
      if (needsRestore && window.artifactPanel) {
        window.artifactPanel.showPreparing(artifact.name, false);
      }
    }

    try {
      const response = await fetch('http://localhost:8766/artifacts/artifacts_open_artifact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          artifact_id: artifact.artifact_id,
          detached
        })
      });

      const responseText = await response.text();
      console.log('[ArtifactIndicator] Open artifact API response:', response.status, responseText);

      if (!response.ok) {
        throw new Error(`Failed to open artifact: ${response.status} - ${responseText}`);
      }

      // Check for success: false in JSON response (backend error handled gracefully)
      try {
        const responseJson = JSON.parse(responseText);
        if (responseJson.success === false) {
          throw new Error(`Backend error: ${responseJson.error || 'Unknown error'}`);
        }
      } catch (parseError) {
        if (parseError.message.startsWith('Backend error:')) {
          throw parseError;
        }
        // Not JSON or parse error - continue (some tools return non-JSON)
      }

      // The artifact-open event will trigger state update
    } catch (error) {
      console.error('[ArtifactIndicator] Failed to open:', error);

      // Cancel preparing state on error (only for panel opens - detached doesn't show preparing)
      if (!detached && window.artifactPanel) {
        window.artifactPanel.cancelPreparing();
      }

      // Fallback: if we have preview_url in artifact data, try to open directly
      console.log('[ArtifactIndicator] Fallback check - preview_url:', artifact.preview_url, 'artifactPanel:', !!window.artifactPanel, 'detached:', detached);
      if (artifact.preview_url && window.artifactPanel && !detached) {
        console.log('[ArtifactIndicator] Using fallback to open directly');
        const { version } = this.getPreferredVersionInfo(artifact);
        window.artifactPanel.open(artifact.artifact_id, artifact.preview_url, artifact.name, version, chatId);
      } else {
        console.log('[ArtifactIndicator] No fallback available');
      }
    }
  }

  async handleOpen(artifact, chatId = this.currentChatId) {
    await this.openArtifact(artifact, { detached: false, chatId });
  }

  async handleOpenInWindow(artifact, chatId = this.currentChatId) {
    // Open artifact in a new detached window, starting the server if needed
    await this.openArtifact(artifact, { detached: true, chatId });
  }

  setupChatChangeDetection() {
    const setupWebviewListeners = () => {
      const webviews = Array.from(document.querySelectorAll('.chat-webview'));
      if (webviews.length > 0) {
        for (const webview of webviews) {
          if (this.navigationBoundWebviews.has(webview)) {
            continue;
          }
          this.navigationBoundWebviews.add(webview);
          // Listen for in-page navigation (SPA route changes)
          webview.addEventListener('did-navigate-in-page', (event) => {
            const chatId = this.extractChatIdFromUrl(event.url);
            const previousChatId = this.webviewChatIds.get(webview);
            if (chatId && chatId !== previousChatId) {
              console.log('[ArtifactIndicator] Chat changed via in-page navigation:', chatId);
              this.onChatChanged(chatId, webview);
            } else if (!chatId && previousChatId) {
              this.handleWebviewLeftChat(webview, previousChatId, 'in-page navigation');
            } else if (!chatId) {
              this.notifyWebviewOfArtifactsForWebview(webview);
            }
          });

          // Also listen for full navigation
          webview.addEventListener('did-navigate', (event) => {
            const chatId = this.extractChatIdFromUrl(event.url);
            const previousChatId = this.webviewChatIds.get(webview);
            if (chatId && chatId !== previousChatId) {
              console.log('[ArtifactIndicator] Chat changed via navigation:', chatId);
              this.onChatChanged(chatId, webview);
            } else if (!chatId && previousChatId) {
              this.handleWebviewLeftChat(webview, previousChatId, 'navigation');
            } else if (!chatId) {
              this.notifyWebviewOfArtifactsForWebview(webview);
            }
          });

          // Check initial URL when webview is ready
          const checkInitialUrl = () => {
            try {
              const currentUrl = webview.getURL();
              const chatId = this.extractChatIdFromUrl(currentUrl);
              if (chatId && chatId !== this.webviewChatIds.get(webview)) {
                console.log('[ArtifactIndicator] Initial chat detected:', chatId);
                this.onChatChanged(chatId, webview);
                // Schedule retry notifications after initial load to handle Svelte mount timing
                scheduleNotificationRetries();
              } else if (!chatId) {
                const previousChatId = this.webviewChatIds.get(webview);
                if (previousChatId) {
                  this.handleWebviewLeftChat(webview, previousChatId, 'initial URL check');
                } else {
                  this.notifyWebviewOfArtifactsForWebview(webview);
                }
              }
            } catch (e) {
              console.log('[ArtifactIndicator] Could not get initial URL:', e.message);
            }
          };

          // Check immediately if webview has URL (guarded for early attach timing)
          if (webview.getURL) {
            checkInitialUrl();
          }

          // Also check with small delay to handle page reload timing
          setTimeout(() => {
            checkInitialUrl();
          }, 100);

          // And check on dom-ready as backup
          webview.addEventListener('dom-ready', () => {
            checkInitialUrl();
          });

          console.log('[ArtifactIndicator] Chat change detection set up for', webview.id || webview.dataset?.owuiViewKey || 'chat-webview');
        }
      }
      setTimeout(setupWebviewListeners, 1000);
    };

    setupWebviewListeners();
  }

  extractChatIdFromUrl(url) {
    if (!url) return null;
    const match = url.match(/\/c(?:hat)?\/([a-f0-9-]+)/i);
    return match ? match[1] : null;
  }

  getChatIdFromWebview(webview = document.getElementById('chat-webview')) {
    return this.getLoadedChatIdForWebview(webview);
  }

  getLoadedChatIdForWebview(webview) {
    if (!webview) {
      return null;
    }
    try {
      const url = (typeof webview.getURL === 'function' ? webview.getURL() : null) || webview.src;
      return this.extractChatIdFromUrl(url);
    } catch (e) {
      console.error('[ArtifactIndicator] Failed to get URL from webview:', e);
    }
    return null;
  }

  getLoadedChatIdForTabKey(tabKey = window.appState?.activeTab || 'chat') {
    const key = String(tabKey || 'chat');
    if (key.startsWith('conversation-')) {
      const conversationId = key.slice('conversation-'.length);
      return this.getLoadedChatIdForWebview(document.getElementById(`conversation-webview-${conversationId}`));
    }
    return this.getLoadedChatIdForWebview(document.getElementById('chat-webview'));
  }

  isTabLoadedForChat(tabKey, chatId) {
    const normalizedChatId = String(chatId || '').trim();
    return Boolean(normalizedChatId && this.getLoadedChatIdForTabKey(tabKey) === normalizedChatId);
  }

  handleWebviewLeftChat(webview, previousChatId, reason) {
    console.log(`[ArtifactIndicator] Navigated away from chat via ${reason}`);
    const tabKey = this.getTabKeyForWebview(webview);
    window.artifactPanel?.handleTabChatChanged?.(tabKey, previousChatId, null);
    this.webviewChatIds.delete(webview);
    if (tabKey === window.appState?.activeTab) {
      this.currentChatId = null;
      this.artifacts = [];
    }
    this.notifyWebviewOfArtifactsForWebview(webview);
  }

  async onChatChanged(chatId, webview = document.getElementById('chat-webview')) {
    console.log('[ArtifactIndicator] Processing chat change to:', chatId);

    const tabKey = this.getTabKeyForWebview(webview);
    const previousChatId = this.webviewChatIds.get(webview) || null;
    if (previousChatId && previousChatId !== chatId) {
      window.artifactPanel?.handleTabChatChanged?.(tabKey, previousChatId, chatId);
    }
    this.webviewChatIds.set(webview, chatId);
    void window.artifactPanel?.handleTabChatLoaded?.(tabKey, chatId);

    if (tabKey === window.appState?.activeTab || webview?.id === 'chat-webview') {
      await this.setChatId(chatId);
    } else {
      await this.refreshChat(chatId);
    }

    // Ensure notification fires after refresh (handles timing with Svelte mount)
    // The refresh() already calls notifyWebviewOfArtifacts() but the webview
    // might not have its event listeners ready yet on page reload
    this.notifyWebviewOfArtifacts(chatId);

    // Schedule retry notifications to handle Svelte component remount timing
    // The MessageInput component may be remounting during navigation, and the
    // __updateArtifacts callback might not be registered yet
    scheduleNotificationRetries();

    // Auto-restore last artifact for this chat if any artifacts exist
    const artifacts = this.getArtifactsForChat(chatId);
    if (artifacts.length > 0) {
      const lastArtifact = this.lastArtifactPerChat[chatId];
      if (lastArtifact) {
        console.log('[ArtifactIndicator] Auto-restoring last artifact:', lastArtifact.artifact_id);
        const artifact = artifacts.find(a => a.artifact_id === lastArtifact.artifact_id);
        if (artifact && tabKey === window.appState?.activeTab) {
          this.handleOpen(artifact, chatId);
        }
      }
    }
  }

  async refreshChat(chatId) {
    if (!chatId || !window.electronAPI) {
      return;
    }

    try {
      const [artifactResult, detachedResult] = await Promise.all([
        window.electronAPI.artifacts.getList(chatId),
        window.electronAPI.artifacts.getDetachedWindows()
      ]);
      const apiArtifacts = artifactResult.success ? artifactResult.artifacts : [];
      if (artifactResult.success) {
        this.setArtifactsForChat(chatId, apiArtifacts);
      }
      const detachedWindows = detachedResult.success ? detachedResult.windows : [];
      this.setDetachedWindowsForChat(
        chatId,
        detachedWindows.filter(w => w.chatId === chatId)
      );
      await this.fetchAllRunningStatusForChat(chatId);
      this.notifyWebviewOfArtifacts(chatId);
    } catch (error) {
      console.error('[ArtifactIndicator] Failed to refresh chat artifacts:', chatId, error);
    }
  }

  buildArtifactUpdateForChat(chatId) {
    if (!chatId) {
      return {
        chatId: null,
        count: 0,
        artifacts: [],
      };
    }

    const attachedState = window.artifactPanel?.getCurrentSlotForChat?.(chatId);
    const panelArtifactId = attachedState?.artifact?.artifact_id || null;
    const detachedIds = new Set(this.getDetachedWindowsForChat(chatId).map(w => w.artifactId));
    const artifacts = this.getArtifactsForChat(chatId);

    return {
      chatId,
      count: artifacts.length,
      artifacts: artifacts.map(a => {
        const isInPanel = panelArtifactId === a.artifact_id;
        const isDetached = detachedIds.has(a.artifact_id);
        const hasRunning = this.runningArtifacts.get(a.artifact_id) || false;

        return {
          artifact_id: a.artifact_id,
          name: a.name,
          current_version: a.current_version,
          display_version: this.getPreferredVersionInfo(a).version,
          isInPanel,
          isDetached,
          isRunning: (isInPanel || isDetached) && hasRunning
        };
      })
    };
  }

  sendArtifactsUpdateToWebview(webview, data) {
    const viewKey = webview.dataset?.owuiViewKey;
    if (viewKey && window.electronAPI?.owui?.sendArtifactsUpdate) {
      window.electronAPI.owui
        .sendArtifactsUpdate(viewKey, data)
        .catch((err) => console.error('[ArtifactIndicator] Failed to notify OWUI host:', err));
      return;
    }

    if (typeof webview.executeJavaScript === 'function') {
      // Use both: direct callback (more reliable) AND event (for compatibility)
      webview.executeJavaScript(`
        (function() {
          const data = ${JSON.stringify(data)};
          if (typeof window.__updateArtifacts === 'function') {
            window.__updateArtifacts(data);
          }
          window.dispatchEvent(new CustomEvent('artifacts-updated', { detail: data }));
        })();
      `).catch(err => console.error('[ArtifactIndicator] Failed to notify webview:', err));
    }
  }

  notifyWebviewOfArtifactsForWebview(webview) {
    if (!webview) {
      return;
    }
    const targetChatId = this.getLoadedChatIdForWebview(webview);
    const data = this.buildArtifactUpdateForChat(targetChatId);
    console.log('[ArtifactIndicator] Notifying webview of artifacts:', data.count, 'artifacts for chat:', targetChatId);
    this.sendArtifactsUpdateToWebview(webview, data);
  }

  notifyWebviewOfArtifacts(chatId = this.currentChatId) {
    const webviews = Array.from(document.querySelectorAll('.chat-webview'));
    if (webviews.length === 0) {
      console.log('[ArtifactIndicator] Webviews not ready for notification');
      return;
    }

    for (const webview of webviews) {
      const targetChatId = this.getLoadedChatIdForWebview(webview);
      if (chatId && targetChatId && targetChatId !== chatId) {
        continue;
      }
      const data = this.buildArtifactUpdateForChat(targetChatId);

      console.log('[ArtifactIndicator] Notifying webview of artifacts:', data.count, 'artifacts for chat:', targetChatId);
      this.sendArtifactsUpdateToWebview(webview, data);
    }
  }

  // Called by artifact panel when it closes to remember the last artifact
  rememberArtifactForChat(chatId, artifactInfo) {
    if (chatId && artifactInfo) {
      this.lastArtifactPerChat[chatId] = artifactInfo;
      console.log('[ArtifactIndicator] Remembered artifact for chat:', chatId, artifactInfo.artifact_id);
    }
  }
}

// Initialize when DOM is ready
let artifactIndicator = null;

function initArtifactIndicator() {
  if (!artifactIndicator) {
    artifactIndicator = new ArtifactIndicator();
    window.artifactIndicator = artifactIndicator;
    console.log('[ArtifactIndicator] Initialized (headless backend service)');

    // Retry notifications to handle webview initialization timing
    scheduleNotificationRetries();
  }
  return artifactIndicator;
}

function scheduleNotificationRetries() {
  const retryDelays = [500, 1500, 3000, 5000];
  retryDelays.forEach(delay => {
    setTimeout(() => {
      if (artifactIndicator && artifactIndicator.artifacts.length > 0) {
        console.log(`[ArtifactIndicator] Retry notification after ${delay}ms`);
        artifactIndicator.notifyWebviewOfArtifacts();
      }
    }, delay);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  setTimeout(initArtifactIndicator, 300);
});

window.initArtifactIndicator = initArtifactIndicator;
