    // Using electronAPI from preload script

    const logContent = document.getElementById('log-content');
    const statusMessage = document.getElementById('status-message');
    const progressBar = document.getElementById('progress');
    const recoveryButtons = document.getElementById('recovery-buttons');
    const manualRecoveryPanel = document.getElementById('manual-recovery-panel');
    const manualRecoveryTitle = document.getElementById('manual-recovery-title');
    const manualRecoveryCommand = document.getElementById('manual-recovery-command');
    const copyRecoveryCommandBtn = document.getElementById('copy-recovery-command-btn');
    const currentStepCaption = document.getElementById('current-step-caption');
    const mainContainer = document.querySelector('.main-container');
    const toggleLogsBtn = document.getElementById('toggle-logs-btn');

    function collectCurrentTasks() {
      return {
        'auth': document.getElementById('task-auth'),
        'verify': document.getElementById('task-verify'),
        'stop': document.getElementById('task-stop'),
        'mcp-config': document.getElementById('task-mcp-config'),
        'host-mcpo': document.getElementById('task-host-mcpo'),
        'start': document.getElementById('task-start'),
        'health': document.getElementById('task-health'),
        'ready': document.getElementById('task-ready'),
        'validate': document.getElementById('task-validate'),
        'install': document.getElementById('task-install'),
        'download': document.getElementById('task-download'),
        'extract': document.getElementById('task-extract'),
        'build': document.getElementById('task-build'),
        'restart': document.getElementById('task-restart')
      };
    }

    let tasks = collectCurrentTasks();
    let logsDrawerOpen = false;
    let currentLoadingStepId = null;
    let launchTriggered = false;
    let loadingFinished = false;
    let updateModeActive = false;
    let logAutoscrollEnabled = true;
    let logScrollProgrammaticDepth = 0;
    let authGateInProgress = false;
    let authFailureActive = false;
    let authStatusPoll = null;
    let lastAuthStatusSignature = null;
    let currentRecoveryCommand = '';

    const STEP_LABELS = {
      'auth': 'Signing into Portico...',
      'verify': 'Verifying running services...',
      'stop': 'Stopping existing services...',
      'mcp-config': 'Configuring MCP servers...',
      'host-mcpo': 'Starting host MCP servers...',
      'start': 'Starting Docker services...',
      'health': 'Running health checks...',
      'ready': 'Finalizing launch...',
      'validate': 'Validating prepared update...',
      'install': 'Installing prepared files...',
      'download': 'Downloading update...',
      'extract': 'Extracting update files...',
      'build': 'Building application...',
      'restart': 'Restarting application...'
    };

    function setBodyMode(mode) {
      document.body.classList.toggle('update-mode', mode === 'update');
      updateModeActive = mode === 'update';
      tasks = collectCurrentTasks();
    }

    function updateCurrentStepCaption(stepId, fallback) {
      if (!currentStepCaption) return;
      if (!stepId && fallback) {
        currentStepCaption.textContent = fallback;
        return;
      }
      currentLoadingStepId = stepId || currentLoadingStepId;
      currentStepCaption.textContent = STEP_LABELS[currentLoadingStepId] || fallback || 'Preparing startup...';
    }

    function scrollLogContentToBottom() {
      if (!logContent) return;
      logScrollProgrammaticDepth += 1;
      logContent.scrollTop = logContent.scrollHeight;
      window.requestAnimationFrame(() => {
        logScrollProgrammaticDepth = Math.max(0, logScrollProgrammaticDepth - 1);
      });
    }

    async function setLogsDrawerOpen(open) {
      logsDrawerOpen = Boolean(open);
      document.body.classList.toggle('logs-drawer-open', logsDrawerOpen);
      if (mainContainer) {
        mainContainer.classList.toggle('logs-drawer-open', logsDrawerOpen);
      }
      if (toggleLogsBtn) {
        toggleLogsBtn.setAttribute('aria-expanded', logsDrawerOpen ? 'true' : 'false');
        toggleLogsBtn.setAttribute(
          'aria-label',
          logsDrawerOpen ? 'Hide initialization logs' : 'Open initialization logs',
        );
        toggleLogsBtn.title = logsDrawerOpen ? 'Hide initialization logs' : 'Open initialization logs';
        toggleLogsBtn.classList.toggle('active', logsDrawerOpen);
      }
      if (logsDrawerOpen && logAutoscrollEnabled) {
        scrollLogContentToBottom();
      }
      try {
        await window.electronAPI?.setLoadingWindowLogsDrawerOpen?.(logsDrawerOpen);
      } catch (error) {
        console.warn('[loading] Failed to resize loading window for logs drawer:', error.message);
      }
    }
    
    // Temporary ANSI to HTML converter (will be replaced by loading.js)
    function ansiToHtml(text) {
      // Basic HTML escape
      let html = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

      // Simple ANSI code removal for now
      const ansiRegex = /\x1b\[[0-9;]*m/g;
      html = html.replace(ansiRegex, '');

      return html;
    }

    let dbRepairInProgress = false;
    const dbRepairModalState = {
      initialized: false,
      running: false,
      resolver: null,
      elements: {},
    };

    function getCurrentUserApi() {
      return window.electronAPI?.currentUser || null;
    }

    function getCurrentUserAuthApi() {
      const currentUserApi = getCurrentUserApi();
      if (
        currentUserApi &&
        typeof currentUserApi.get === 'function' &&
        typeof currentUserApi.ensureAuthenticated === 'function' &&
        typeof currentUserApi.status === 'function'
      ) {
        return currentUserApi;
      }

      const setupAuthApi = window.electronAPI?.setupAuth;
      if (
        setupAuthApi &&
        typeof setupAuthApi.start === 'function' &&
        typeof setupAuthApi.status === 'function'
      ) {
        return {
          ensureAuthenticated: () => setupAuthApi.start(),
          status: () => setupAuthApi.status(),
          clearError: () => setupAuthApi.clearError?.(),
        };
      }

      return null;
    }

    function formatCurrentUserAuthError(result = {}) {
      const allowedCodes = new Set([
        'access_denied',
        'access_denied_user_cancelled',
        'auth_storage_unavailable',
        'auth_timeout',
        'browser_open_failed',
        'callback_listener_failed',
        'discovery_failed',
        'discovery_invalid',
        'identity_email_unavailable',
        'identity_sync_failed',
        'identity_sync_invalid',
        'identity_sync_project_root_missing',
        'missing_authorization_code',
        'missing_refresh_token',
        'oauth_provider_error',
        'oauth_request_failed',
        'redirect_uri_mismatch',
        'refresh_failed',
        'setup_auth_failed',
        'state_mismatch',
        'token_exchange_failed',
      ]);
      const candidate = result?.errorCode || result?.code;
      const errorCode = allowedCodes.has(candidate)
        ? candidate
        : 'setup_auth_failed';

      switch (errorCode) {
        case 'access_denied_user_cancelled':
          return 'Sign-in was canceled. Try again when you are ready.';
        case 'access_denied':
          return 'Okta denied access to this app. Try again or confirm that your account can use this Okta application.';
        case 'auth_timeout':
          return 'Okta took too long to finish. Try again.';
        case 'state_mismatch':
        case 'redirect_uri_mismatch':
          return 'The Okta callback did not match the request. Try again.';
        case 'auth_storage_unavailable':
          return 'Secure token storage is unavailable on this device, so login cannot continue.';
        case 'callback_listener_failed':
          return 'The app could not open the local Okta callback port. Try again.';
        case 'browser_open_failed':
          return 'The app could not open Okta in your browser. Try again.';
        case 'discovery_failed':
          return 'The app could not contact Okta to start sign-in. Try again.';
        case 'discovery_invalid':
          return 'Okta returned an invalid sign-in configuration. Contact support.';
        case 'missing_authorization_code':
          return 'Okta did not return the code needed to finish sign-in. Try again.';
        case 'oauth_provider_error':
        case 'oauth_request_failed':
          return 'Okta could not complete sign-in. Try again.';
        case 'missing_refresh_token':
        case 'refresh_failed':
          return 'The saved Okta login could not be refreshed. Sign in again.';
        case 'token_exchange_failed':
          return 'Okta rejected the final sign-in step. Try again once; if it keeps failing, contact support.';
        case 'identity_sync_invalid':
          return 'The signed-in account is missing required identity information.';
        case 'identity_email_unavailable':
          return 'Sign-in finished, but your account did not provide an email address, which this app requires. Retry login; if it keeps happening, contact support.';
        case 'identity_sync_failed':
        case 'identity_sync_project_root_missing':
          return 'The signed-in account could not be saved locally. Try again.';
        default:
          return 'Login failed. Please try again.';
      }
    }

    // Intentional duplication of setup-auth-shared's normalizePlausibleEmail
    // (this renderer bundle cannot require main-process modules): at least
    // one character on each side of an @.
    function hasPlausibleSessionEmail(result) {
      const email = result?.sessionSummary?.user?.email;
      if (typeof email !== 'string') return false;
      const trimmed = email.trim();
      const atIndex = trimmed.indexOf('@');
      return atIndex >= 1 && atIndex < trimmed.length - 1;
    }

    function setAuthRecoveryState(active, message = '') {
      authFailureActive = Boolean(active);
      const controlPlaneBtn = document.getElementById('control-plane-btn');
      const retryBtn = document.getElementById('retry-btn');

      if (controlPlaneBtn) {
        controlPlaneBtn.style.display = authFailureActive ? 'none' : '';
      }
      if (retryBtn) {
        retryBtn.textContent = authFailureActive
          ? 'Retry Login'
          : 'Retry Initialization';
      }
      if (authFailureActive) {
        recoveryButtons.classList.add('visible');
        if (message) {
          updateStatus(message);
        }
      }
    }

    function stopCurrentUserStatusPolling() {
      if (authStatusPoll) {
        clearInterval(authStatusPoll);
        authStatusPoll = null;
      }
    }

    async function syncCurrentUserStatusFromMain(options = {}) {
      const authApi = getCurrentUserAuthApi();
      if (!authApi || typeof authApi.status !== 'function') {
        return null;
      }

      try {
        const status = await authApi.status();
        if (!status || typeof status !== 'object') {
          return null;
        }

        const signature = JSON.stringify({
          phase: status.phase || null,
          message: status.message || null,
          error: status.error || null,
          errorCode: status.errorCode || null,
          authenticated: Boolean(status.authenticated),
        });
        const changed = signature !== lastAuthStatusSignature;
        if (changed) {
          lastAuthStatusSignature = signature;
        }

        if (changed && options.logChanges !== false) {
          if (status.message) {
            addLogWithPersist(`🔐 ${status.message}\n`, 'info');
          } else if (status.authenticated && status.sessionSummary) {
            addLogWithPersist('✅ Signed in\n', 'success');
          } else if (status.error) {
            addLogWithPersist(`❌ Login failed: ${formatCurrentUserAuthError(status)}\n`, 'error');
          }
        }

        if (status.message) {
          updateStatus(status.message);
        } else if (status.error) {
          updateStatus(formatCurrentUserAuthError(status));
        }

        return status;
      } catch (error) {
        console.warn('[loading] Failed to read current-user status (status_unavailable)');
        return null;
      }
    }

    async function stopServicesAfterAuthFailure() {
      addLogWithPersist('🛑 Stopping app services until login succeeds...\n', 'warning');

      const stopActions = [
        {
          label: 'host MCP bridge',
          run: () => window.electronAPI?.stopHostMcpBridge?.(),
        },
        {
          label: 'host MCP proxy',
          run: () => window.electronAPI?.stopHostMcpo?.(),
        },
        {
          label: 'Docker services',
          run: () => window.electronAPI?.dockerStop?.(),
        },
      ];

      for (const action of stopActions) {
        if (typeof action.run !== 'function') {
          continue;
        }
        try {
          const result = await action.run();
          if (result?.success === false) {
            addLogWithPersist(
              `⚠️ Failed to stop ${action.label}: ${result.error || 'unknown error'}\n`,
              'warning',
            );
          } else {
            addLogWithPersist(`✅ Stopped ${action.label}\n`, 'info');
          }
        } catch (error) {
          addLogWithPersist(
            `⚠️ Failed to stop ${action.label}: ${error.message}\n`,
            'warning',
          );
        }
      }
    }

    async function runCurrentUserAuthGate(options = {}) {
      if (authGateInProgress) {
        return false;
      }

      const authApi = getCurrentUserAuthApi();
      if (!authApi || typeof authApi.ensureAuthenticated !== 'function') {
        addLogWithPersist('❌ Login is unavailable in this build.\n', 'error');
        setTaskFailed('auth');
        setAuthRecoveryState(true, 'Login is unavailable right now.');
        return false;
      }

      authGateInProgress = true;
      setAuthRecoveryState(false);
      resetTaskState('auth');
      setTaskActive('auth');
      updateProgress(Math.max(updateModeActive ? 0 : 2, 2));
      updateStatus('Checking your login...');
      lastAuthStatusSignature = null;
      addLogWithPersist('🔐 Checking your Portico login...\n', 'info');

      try {
        await authApi.clearError?.();
        await syncCurrentUserStatusFromMain({ logChanges: false });
      } catch (error) {
        console.warn('[loading] Failed to clear current-user auth error (clear_error_failed)');
      }

      stopCurrentUserStatusPolling();
      authStatusPoll = window.setInterval(() => {
        void syncCurrentUserStatusFromMain();
      }, 800);

      try {
        const setupDecisionResult = await window.electronAPI?.getSetupLaunchDecision?.();
        const setupDecision = setupDecisionResult?.decision || null;
        if (setupDecision?.action === 'blocked') {
          const message =
            setupDecision.reasonMessage ||
            'Setup state is invalid and startup cannot continue.';
          stopCurrentUserStatusPolling();
          setTaskFailed('auth');
          updateStatus('Startup blocked');
          addLogWithPersist(
            `❌ Startup blocked by setup state (${setupDecision.reason || 'unknown'}): ${message}\n`,
            'error',
          );
          recoveryButtons.classList.add('visible');
          await setLogsDrawerOpen(true);
          return false;
        }
        let result = typeof authApi.get === 'function'
          ? await authApi.get()
          : null;

        if (
          result &&
          result.authenticated !== true &&
          typeof result.errorCode === 'string' &&
          result.errorCode.startsWith('identity_sync_')
        ) {
          throw result;
        }

        // PORTICO-414: an authenticated session with no email breaks restricted
        // publish/install and OWUI seeding. Heal it silently (userinfo
        // backfill) and only fall back to the identity-repair sign-in when
        // the backfill cannot produce an email. `terminal` means a FRESH
        // interactive sign-in already failed to yield one — re-prompting
        // would loop, so surface the fixed error instead.
        if (
          result?.authenticated === true &&
          result?.sessionSummary &&
          !hasPlausibleSessionEmail(result)
        ) {
          addLogWithPersist(
            '🔐 Your signed-in session has no email address; repairing it...\n',
            'info',
          );
          const repair = await window.electronAPI?.currentUser
            ?.repairIdentity?.()
            .catch(() => null);
          if (repair?.repaired === true) {
            result = typeof authApi.get === 'function' ? await authApi.get() : result;
          } else if (repair?.terminal === true) {
            throw { errorCode: 'identity_email_unavailable' };
          } else {
            stopCurrentUserStatusPolling();
            updateStatus('Login is required to repair your identity...');
            addLogWithPersist('🔐 Opening identity-only login.\n', 'info');
            window.electronAPI.launchGuidedSetupFromInit({
              setupMode: 'identity_repair',
              setupReason: 'session-email-missing',
              safeErrorCode: 'SETUP_IDENTITY_LOGIN_REQUIRED',
              seedDefaults: false,
            });
            return false;
          }
        }

        if (
          result?.authenticated !== true &&
          (setupDecision?.action === 'reconcile_identity' ||
            setupDecision?.action === 'identity_login')
        ) {
          stopCurrentUserStatusPolling();
          updateStatus('Login is required to repair your identity...');
          addLogWithPersist('🔐 Opening identity-only login.\n', 'info');
          window.electronAPI.launchGuidedSetupFromInit({
            setupMode: 'identity_repair',
            setupReason: setupDecision.reason,
            setupRequirementId: setupDecision.setupRequirementId,
            safeErrorCode: setupDecision.safeErrorCode,
            setupOperationId: setupDecision.setupOperationId,
            seedDefaults: false,
          });
          return false;
        }

        if (!result?.authenticated) {
          result = await authApi.ensureAuthenticated();
          // One attempt per gate run: a fresh sign-in that still yields no
          // email is the terminal IdP-side case — recovery is the
          // user-driven Retry Login button, never an automatic loop.
          if (
            result?.authenticated === true &&
            result?.sessionSummary &&
            !hasPlausibleSessionEmail(result)
          ) {
            throw { errorCode: 'identity_email_unavailable' };
          }
        }
        await syncCurrentUserStatusFromMain({ logChanges: false });

        if (!result?.success || !result?.authenticated || !result?.sessionSummary) {
          throw result || new Error('Login failed');
        }

        stopCurrentUserStatusPolling();
        setTaskCompleted('auth');
        updateProgress(Math.max(updateModeActive ? 0 : 5, 5));
        updateStatus('Login complete. Continuing startup...');
        addLogWithPersist('✅ Signed in\n', 'success');
        return true;
      } catch (error) {
        stopCurrentUserStatusPolling();
        const message = formatCurrentUserAuthError(error);
        setTaskFailed('auth');
        addLogWithPersist(`❌ Login failed: ${message}\n`, 'error');
        await stopServicesAfterAuthFailure();
        await setLogsDrawerOpen(true);
        setAuthRecoveryState(true, message);
        return false;
      } finally {
        authGateInProgress = false;
      }
    }

    async function continueAfterAuthentication() {
      let setupDecision;
      try {
        if (typeof window.electronAPI?.getSetupLaunchDecision !== 'function') {
          throw new Error('Setup launch decision is unavailable');
        }
        const decisionResult = await window.electronAPI.getSetupLaunchDecision();
        if (!decisionResult?.success || !decisionResult?.decision) {
          throw new Error(
            decisionResult?.error || 'Failed to re-evaluate setup after login',
          );
        }
        setupDecision = decisionResult.decision;
      } catch (error) {
        const message = error?.message || 'Failed to re-evaluate setup after login';
        setTaskFailed('auth');
        setAuthRecoveryState(true, message);
        updateStatus('Startup blocked');
        addLogWithPersist(`❌ Setup verification failed: ${message}\n`, 'error');
        recoveryButtons.classList.add('visible');
        await setLogsDrawerOpen(true);
        return;
      }

      if (
        setupDecision.action === 'full_setup' ||
        setupDecision.action === 'runtime_repair'
      ) {
        updateStatus('Additional setup is required...');
        addLogWithPersist(
          `⚙️ Opening required setup (${setupDecision.reason || 'unknown'}).\n`,
          'info',
        );
        window.electronAPI.launchGuidedSetupFromInit({
          setupMode: setupDecision.setupMode,
          setupReason: setupDecision.reason,
          setupRequirementId: setupDecision.setupRequirementId,
          safeErrorCode: setupDecision.safeErrorCode,
          setupOperationId: setupDecision.setupOperationId,
          seedDefaults: setupDecision.seedDefaults === true,
        });
        return;
      }

      if (setupDecision.action !== 'continue') {
        const message = setupDecision.action === 'reconcile_identity'
          ? 'The signed-in identity could not be reconciled with the managed runtime configuration.'
          : setupDecision.reasonMessage || 'Setup state is invalid and startup cannot continue.';
        setTaskFailed('auth');
        setAuthRecoveryState(true, message);
        updateStatus('Startup blocked');
        addLogWithPersist(
          `❌ Startup blocked by setup state (${setupDecision.reason || 'unknown'}): ${message}\n`,
          'error',
        );
        recoveryButtons.classList.add('visible');
        await setLogsDrawerOpen(true);
        return;
      }

      setAuthRecoveryState(false);
      clearManualRecovery();
      recoveryButtons.classList.remove('visible');
      setBodyMode('startup');
      updateInProgress = false;
      updateStatus('Starting initialization...');
      updateCurrentStepCaption(null, 'Starting initialization');
      window.electronAPI.startInitialization();
    }

    function launchMainWindowNow(options = {}) {
      if (launchTriggered) {
        return;
      }
      launchTriggered = true;
      updateStatus('Ready! Opening control plane...');
      updateProgress(100);
      setTaskCompleted('ready');
      window.electronAPI.showMainWindow(options);
    }

    function maybeLaunchAfterLoading() {
      if (!loadingFinished || launchTriggered || updateModeActive) {
        return;
      }
      window.setTimeout(() => launchMainWindowNow(), 350);
    }

    function isLogContentScrolledToBottom(container) {
      if (!container) return true;
      const threshold = 16;
      return (
        container.scrollTop + container.clientHeight >=
        container.scrollHeight - threshold
      );
    }

    function shouldHideFromInitLogView(text, type = 'info') {
      const level = (type || '').toLowerCase();
      if (level === 'error') {
        return false;
      }

      if (typeof text !== 'string') {
        return false;
      }

      // Keep OAuth logging noise out of startup UI while preserving file logging.
      return /\/api\/oauth-log(?:\b|\/|\?)/i.test(text);
    }
    
    function addLog(text, type = 'info') {
      if (shouldHideFromInitLogView(text, type)) {
        return;
      }

      const entry = document.createElement('div');
      entry.className = `log-entry ${type}`;
      entry.innerHTML = ansiToHtml(text);
      logContent.appendChild(entry);
      if (logAutoscrollEnabled) {
        scrollLogContentToBottom();
      }
    }
    
    function appendToLastLog(text, type = 'info') {
      if (shouldHideFromInitLogView(text, type)) {
        return;
      }

      const entries = logContent.querySelectorAll('.log-entry');
      if (entries.length > 0) {
        const lastEntry = entries[entries.length - 1];
        // Append text without newline
        lastEntry.innerHTML += ansiToHtml(text);
      } else {
        // If no entries, create a new one
        addLog(text, type);
      }
      if (logAutoscrollEnabled) {
        scrollLogContentToBottom();
      }
    }
    
    function updateStatus(message) {
      if (statusMessage) {
        statusMessage.textContent = message;
      }
      updateCurrentStepCaption(null, message || 'Preparing startup...');
    }

    function normalizeLoadingErrorPayload(payload) {
      if (!payload || typeof payload !== 'object') {
        return {
          message: typeof payload === 'string' && payload.trim()
            ? payload
            : 'Initialization encountered issues...',
          recovery: null,
        };
      }

      const message = typeof payload.message === 'string' && payload.message.trim()
        ? payload.message
        : 'Initialization encountered issues...';
      const recovery = payload.recovery && typeof payload.recovery === 'object'
        ? payload.recovery
        : null;

      return { message, recovery };
    }

    function clearManualRecovery() {
      currentRecoveryCommand = '';
      if (manualRecoveryPanel) {
        manualRecoveryPanel.classList.remove('visible');
      }
      if (manualRecoveryCommand) {
        manualRecoveryCommand.textContent = '';
      }
      if (manualRecoveryTitle) {
        manualRecoveryTitle.textContent = 'Run This In Terminal';
      }
      if (copyRecoveryCommandBtn) {
        copyRecoveryCommandBtn.classList.remove('copied');
        copyRecoveryCommandBtn.textContent = 'Copy';
      }
    }

    function showManualRecovery(recovery) {
      const command = typeof recovery?.command === 'string' ? recovery.command.trim() : '';
      if (!command || !manualRecoveryPanel || !manualRecoveryCommand) {
        clearManualRecovery();
        return;
      }

      currentRecoveryCommand = command;
      manualRecoveryCommand.textContent = command;
      if (manualRecoveryTitle) {
        manualRecoveryTitle.textContent =
          typeof recovery.title === 'string' && recovery.title.trim()
            ? recovery.title
            : 'Run This In Terminal';
      }
      if (copyRecoveryCommandBtn) {
        copyRecoveryCommandBtn.classList.remove('copied');
        copyRecoveryCommandBtn.textContent = 'Copy';
      }
      manualRecoveryPanel.classList.add('visible');
    }
    
    function updateProgress(percent) {
      progressBar.style.width = `${percent}%`;
    }

    function resetTaskState(taskId) {
      const task = tasks[taskId];
      if (!task) {
        return;
      }
      task.style.display = '';
      task.classList.remove('active', 'completed', 'failed', 'skipped');
    }
    
    function setTaskActive(taskId) {
      const task = tasks[taskId];
      if (task) {
        task.style.display = '';
        // Reset all tasks
        Object.values(tasks).forEach(t => {
          if (!t) return;
          t.classList.remove('active', 'failed');
        });
        task.classList.add('active');
      }
      updateCurrentStepCaption(taskId);
    }
    
    function setTaskCompleted(taskId) {
      const task = tasks[taskId];
      if (task) {
        task.style.display = '';
        task.classList.remove('active', 'failed');
        task.classList.add('completed');
      }
    }
    
    function setTaskFailed(taskId) {
      const task = tasks[taskId];
      if (task) {
        task.style.display = '';
        task.classList.remove('active', 'completed');
        task.classList.add('failed');
      }
      updateCurrentStepCaption(taskId);
    }

    function setTaskSkipped(taskId) {
      const task = tasks[taskId];
      if (task) {
        task.classList.remove('active');
        task.classList.add('skipped');
        if (taskId === 'host-mcpo') {
          task.style.display = 'none';
        }
      }
    }

    // Token redaction helper function for OAuth logs
    function redactTokens(text) {
      return text
        // Redact OAuth tokens (typically long base64 strings after "token" keyword)
        .replace(/token['":\s]+['"]?([A-Za-z0-9_-]{20,})['"]?/gi, 'token: [REDACTED]')
        // Redact Bearer tokens
        .replace(/Bearer\s+([A-Za-z0-9_-]{20,})/gi, 'Bearer [REDACTED]')
        // Redact access_token parameters
        .replace(/access_token=([A-Za-z0-9_-]{20,})/gi, 'access_token=[REDACTED]')
        // Redact refresh_token parameters
        .replace(/refresh_token=([A-Za-z0-9_-]{20,})/gi, 'refresh_token=[REDACTED]')
        // Redact code parameters (OAuth authorization codes)
        .replace(/code=([A-Za-z0-9_-]{20,})/gi, 'code=[REDACTED]')
        // Redact client_secret parameters
        .replace(/client_secret=([A-Za-z0-9_-]{20,})/gi, 'client_secret=[REDACTED]')
        // Redact generic long alphanumeric strings that look like tokens (40+ chars)
        .replace(/([A-Za-z0-9_-]{40,})/g, '[POSSIBLE_TOKEN_REDACTED]');
    }

    // Enhanced addLog that also writes to init log files AND OAuth log file
    function addLogWithPersist(message, type = 'info') {
      // Show in UI
      addLog(message, type);

      // Persist to file with tokens redacted
      const redactedMessage = redactTokens(message);
      if (window.electronAPI && window.electronAPI.sendInitLog) {
        window.electronAPI.sendInitLog(redactedMessage, type);
      }

      // Also write OAuth-related messages to the OAuth log file
      // This ensures all OAuth flow messages are in one place for debugging
      if (window.electronAPI && window.electronAPI.logOAuthEvent) {
        const isOAuthRelated = message.includes('OAuth') ||
                               message.includes('oauth') ||
                               message.includes('Waiting 10 seconds') ||
                               message.includes('Restarting') ||
                               message.includes('token') ||
                               message.includes('authorization');
        if (isOAuthRelated) {
          const level = type === 'error' ? 'ERROR' :
                        type === 'warning' ? 'WARN' :
                        type === 'success' ? 'INFO' : 'INFO';
          window.electronAPI.logOAuthEvent({
            layer: 'Frontend',
            level: level,
            message: redactedMessage.trim()
          });
        }
      }
    }

    function ensureDbRepairModal() {
      if (dbRepairModalState.initialized) {
        return dbRepairModalState.elements;
      }

      if (!document.getElementById('loading-db-repair-style')) {
        const style = document.createElement('style');
        style.id = 'loading-db-repair-style';
        style.textContent = `
          .loading-db-repair-overlay {
            position: fixed;
            inset: 0;
            background: rgba(4, 8, 12, 0.72);
            backdrop-filter: blur(6px);
            -webkit-backdrop-filter: blur(6px);
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 10030;
            opacity: 0;
            visibility: hidden;
            transition: opacity 0.2s ease, visibility 0.2s ease;
          }
          .loading-db-repair-overlay.visible {
            opacity: 1;
            visibility: visible;
          }
          .loading-db-repair-modal {
            width: min(480px, 92vw);
            background: linear-gradient(180deg, #353a3f 0%, #2f3438 100%);
            color: var(--text-primary, #e5e5e5);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 14px;
            padding: 22px;
            box-shadow: 0 24px 64px rgba(0, 0, 0, 0.45);
          }
          .loading-db-repair-icon-wrap {
            width: 56px;
            height: 56px;
            margin: 0 auto 14px auto;
            border-radius: 999px;
            background: rgba(245, 158, 11, 0.12);
            border: 1px solid rgba(245, 158, 11, 0.5);
            display: flex;
            align-items: center;
            justify-content: center;
          }
          .loading-db-repair-icon-wrap svg {
            width: 28px;
            height: 28px;
            stroke: #f59e0b;
            fill: none;
          }
          .loading-db-repair-modal h2 {
            margin: 0 0 10px 0;
            text-align: center;
            font-size: 24px;
            font-weight: 650;
          }
          .loading-db-repair-modal p {
            margin: 0 0 10px 0;
            line-height: 1.5;
            color: #b7bdc5;
            text-align: center;
          }
          .loading-db-repair-detail-title {
            margin-top: 12px;
            margin-bottom: 6px;
            font-size: 11px;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: #8e97a3;
          }
          .loading-db-repair-detail {
            padding: 10px 12px;
            border-radius: 8px;
            background: rgba(13, 18, 24, 0.58);
            border: 1px solid rgba(255, 255, 255, 0.08);
            font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
            font-size: 12px;
            color: #aab2bc;
            word-break: break-word;
          }
          .loading-db-repair-progress {
            margin-top: 12px;
            display: none;
            align-items: center;
            gap: 10px;
            background: rgba(13, 18, 24, 0.58);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 10px;
            padding: 10px 12px;
          }
          .loading-db-repair-progress.visible {
            display: flex;
          }
          .loading-db-repair-spinner {
            width: 16px;
            height: 16px;
            border-radius: 999px;
            border: 2px solid rgba(74, 222, 128, 0.3);
            border-top-color: #76e19b;
            animation: loading-db-repair-spin 0.8s linear infinite;
          }
          @keyframes loading-db-repair-spin {
            from { transform: rotate(0deg); }
            to { transform: rotate(360deg); }
          }
          .loading-db-repair-progress-text {
            font-size: 13px;
            color: #c1c8d1;
          }
          .loading-db-repair-actions {
            margin-top: 16px;
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 10px;
          }
          .loading-db-repair-btn {
            border-radius: 9px;
            padding: 10px 14px;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            transition: opacity 0.15s ease;
          }
          .loading-db-repair-btn:hover {
            opacity: 0.92;
          }
          .loading-db-repair-btn-cancel {
            background: rgba(17, 24, 31, 0.9);
            color: #c6ccd4;
            border: 1px solid rgba(255, 255, 255, 0.08);
          }
          .loading-db-repair-btn-start {
            background: #76e19b;
            color: #10231a;
            border: 1px solid rgba(118, 225, 155, 0.45);
          }
          .loading-db-repair-btn:disabled {
            cursor: not-allowed;
            opacity: 0.55;
          }
          [data-theme="light"] .loading-db-repair-overlay {
            background: rgba(2, 6, 11, 0.38);
          }
          [data-theme="light"] .loading-db-repair-modal {
            background: linear-gradient(180deg, #f5f7fa 0%, #eef2f5 100%);
            color: #1f2937;
            border-color: rgba(15, 23, 42, 0.12);
          }
          [data-theme="light"] .loading-db-repair-modal p {
            color: #4b5563;
          }
          [data-theme="light"] .loading-db-repair-detail {
            background: rgba(226, 232, 240, 0.75);
            color: #475569;
            border-color: rgba(15, 23, 42, 0.12);
          }
          [data-theme="light"] .loading-db-repair-progress {
            background: rgba(226, 232, 240, 0.75);
            border-color: rgba(15, 23, 42, 0.12);
          }
          [data-theme="light"] .loading-db-repair-btn-cancel {
            background: #e5e7eb;
            color: #374151;
            border-color: rgba(15, 23, 42, 0.12);
          }
        `;
        document.head.appendChild(style);
      }

      const overlay = document.createElement('div');
      overlay.className = 'loading-db-repair-overlay';
      overlay.innerHTML = `
        <div class="loading-db-repair-modal" role="dialog" aria-modal="true" aria-labelledby="loading-db-repair-title">
          <div class="loading-db-repair-icon-wrap" aria-hidden="true">
            <svg viewBox="0 0 24 24" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 9v4"></path>
              <path d="M12 17h.01"></path>
              <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.72 3h16.92a2 2 0 0 0 1.72-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
            </svg>
          </div>
          <h2 id="loading-db-repair-title">Database Corruption Detected.</h2>
          <p>Oops. Your local chat database is having issues, and needs to be repaired.</p>
          <p>A backup will be created first. Repair can take a few minutes for large databases.</p>
          <div class="loading-db-repair-detail-title">Detected Error Signature</div>
          <div class="loading-db-repair-detail" id="loading-db-repair-detail"></div>
          <div class="loading-db-repair-progress" id="loading-db-repair-progress">
            <div class="loading-db-repair-spinner"></div>
            <div class="loading-db-repair-progress-text" id="loading-db-repair-progress-text">Repairing database... this may take a few minutes.</div>
          </div>
          <div class="loading-db-repair-actions">
            <button class="loading-db-repair-btn loading-db-repair-btn-cancel" id="loading-db-repair-cancel-btn">Not Now</button>
            <button class="loading-db-repair-btn loading-db-repair-btn-start" id="loading-db-repair-start-btn">Repair Now</button>
          </div>
        </div>
      `;
      document.body.appendChild(overlay);

      const detail = overlay.querySelector('#loading-db-repair-detail');
      const progress = overlay.querySelector('#loading-db-repair-progress');
      const progressText = overlay.querySelector('#loading-db-repair-progress-text');
      const cancelBtn = overlay.querySelector('#loading-db-repair-cancel-btn');
      const startBtn = overlay.querySelector('#loading-db-repair-start-btn');

      const resolvePrompt = (value) => {
        if (!dbRepairModalState.resolver) return;
        const resolver = dbRepairModalState.resolver;
        dbRepairModalState.resolver = null;
        resolver(value);
      };

      cancelBtn.addEventListener('click', () => {
        if (dbRepairModalState.running) return;
        overlay.classList.remove('visible');
        resolvePrompt(false);
      });

      startBtn.addEventListener('click', () => {
        if (dbRepairModalState.running) return;
        resolvePrompt(true);
      });

      dbRepairModalState.elements = {
        overlay,
        detail,
        progress,
        progressText,
        cancelBtn,
        startBtn,
      };
      dbRepairModalState.initialized = true;
      return dbRepairModalState.elements;
    }

    function setDbRepairModalRunning(isRunning, message) {
      const elements = ensureDbRepairModal();
      dbRepairModalState.running = isRunning;
      elements.cancelBtn.disabled = isRunning;
      elements.startBtn.disabled = isRunning;
      elements.progress.classList.toggle('visible', isRunning);
      if (isRunning && message) {
        elements.progressText.textContent = message;
      }
    }

    function hideDbRepairModal() {
      const elements = ensureDbRepairModal();
      elements.overlay.classList.remove('visible');
      setDbRepairModalRunning(false);
    }

    function showDbRepairPrompt(matchPreview) {
      const elements = ensureDbRepairModal();
      elements.detail.textContent = matchPreview;
      elements.overlay.classList.add('visible');
      setDbRepairModalRunning(false);
      return new Promise((resolve) => {
        dbRepairModalState.resolver = resolve;
      });
    }

    async function handleDbCorruptionEvent(payload) {
      if (!payload || payload.detected !== true) {
        return;
      }
      if (dbRepairInProgress) {
        return;
      }

      const matchPreview = Array.isArray(payload.matches) && payload.matches.length > 0
        ? payload.matches[0]
        : 'Detected SQLite corruption in Open WebUI logs.';

      const shouldRepair = await showDbRepairPrompt(matchPreview);

      if (!shouldRepair) {
        hideDbRepairModal();
        return;
      }

      dbRepairInProgress = true;
      setDbRepairModalRunning(true, 'Repairing database... this may take a few minutes.');
      updateStatus('Repairing database... this may take a few minutes.');
      addLogWithPersist('⚠️ Detected Open WebUI DB corruption. Starting guided repair...', 'warning');

      try {
        const result = await window.electronAPI.repairOpenWebuiDb({
          reason: 'loading-screen-confirmed',
          manageContainer: true,
          restartContainerAfterRepair: false,
        });

        if (result && result.success) {
          addLogWithPersist(`✅ Open WebUI DB repair completed. Backup: ${result.backup?.db || 'created'}`, 'success');
          if (result.sqliteAutoInstalled) {
            addLogWithPersist('ℹ️ sqlite3 was missing and was installed automatically via Homebrew.', 'info');
          }
          setDbRepairModalRunning(true, 'Repair complete. Restarting services...');
          updateStatus('Repair complete. Restarting services...');

          const restartResult = await window.electronAPI.dockerRestart();
          if (restartResult && restartResult.success === false) {
            hideDbRepairModal();
            addLogWithPersist(`❌ Repair succeeded but restart failed: ${restartResult.error || 'unknown error'}`, 'error');
            updateStatus('Repair succeeded but service restart failed');
            recoveryButtons.classList.add('visible');
          }
          return;
        }

        const errorMessage = result?.error || 'Unknown database repair error';
        hideDbRepairModal();
        addLogWithPersist(`❌ Open WebUI DB repair failed: ${errorMessage}`, 'error');
        updateStatus('Database repair failed');
        recoveryButtons.classList.add('visible');
      } catch (error) {
        hideDbRepairModal();
        addLogWithPersist(`❌ Open WebUI DB repair error: ${error.message}`, 'error');
        updateStatus('Database repair failed');
        recoveryButtons.classList.add('visible');
      } finally {
        dbRepairInProgress = false;
      }
    }

    function showSetupWizardPrompt() {
      // Create modal overlay
      const overlay = document.createElement('div');
      overlay.style.position = 'fixed';
      overlay.style.top = '0';
      overlay.style.left = '0';
      overlay.style.width = '100%';
      overlay.style.height = '100%';
      overlay.style.background = 'rgba(30, 35, 36, 0.95)';
      overlay.style.display = 'flex';
      overlay.style.alignItems = 'center';
      overlay.style.justifyContent = 'center';
      overlay.style.zIndex = '10001';

      // Create modal content
      const modal = document.createElement('div');
      modal.style.background = 'var(--bg-secondary, #2D3233)';
      modal.style.padding = '40px';
      modal.style.borderRadius = '12px';
      modal.style.maxWidth = '500px';
      modal.style.textAlign = 'center';

      modal.innerHTML = `
        <div style="font-size: 48px; margin-bottom: 20px;">⚙️</div>
        <h2 style="color: var(--text-primary, #e5e5e5); font-size: 24px; margin-bottom: 15px;">Additional Setup Required</h2>
        <p style="color: var(--text-secondary, #a3a3a3); font-size: 16px; line-height: 1.6; margin-bottom: 30px;">
          Additional details are needed from you. Please complete the setup wizard to continue.
        </p>
        <button id="open-wizard-btn" style="
          background: var(--accent-primary, #0462f9);
          color: var(--bg-dark, #1E2324);
          border: none;
          padding: 12px 32px;
          border-radius: 6px;
          font-size: 16px;
          font-weight: 600;
          cursor: pointer;
          transition: background 0.15s ease;
        ">Open Setup Wizard</button>
      `;

      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      // Button hover effect
      const btn = document.getElementById('open-wizard-btn');
      btn.addEventListener('mouseenter', () => {
        btn.style.background = 'var(--accent-primary-hover, #0462f9)';
      });
      btn.addEventListener('mouseleave', () => {
        btn.style.background = 'var(--accent-primary, #0462f9)';
      });

      // Button click handler
      btn.addEventListener('click', () => {
        addLog('Opening setup wizard...', 'info');
        void (async () => {
          const result = await window.electronAPI.getSetupLaunchDecision?.();
          const decision = result?.decision || {};
          window.electronAPI.launchGuidedSetupFromInit({
            setupMode: decision.setupMode,
            setupReason: decision.reason,
            setupRequirementId: decision.setupRequirementId,
            safeErrorCode: decision.safeErrorCode,
            setupOperationId: decision.setupOperationId,
            seedDefaults: decision.seedDefaults === true,
          });
        })();
      });
    }

    // Listen for IPC events
    if (toggleLogsBtn) {
      toggleLogsBtn.addEventListener('click', () => {
        void setLogsDrawerOpen(!logsDrawerOpen);
      });
    }

    if (logContent) {
      logContent.addEventListener('scroll', () => {
        if (logScrollProgrammaticDepth > 0) {
          return;
        }
        logAutoscrollEnabled = isLogContentScrolledToBottom(logContent);
      });
    }

    window.electronAPI.onLoadingLog(({ text, type }) => {
      addLog(text, type);
    });
    
    window.electronAPI.onLoadingLogAppend(({ text, type }) => {
      appendToLastLog(text, type);
    });
    
    window.electronAPI.onLoadingStatus((message) => {
      updateStatus(message);
    });
    
    window.electronAPI.onLoadingProgress((percent) => {
      updateProgress(percent);
    });
    
    window.electronAPI.onLoadingStep((stepId) => {
      setTaskActive(stepId);
    });
    
    window.electronAPI.onLoadingStepComplete((stepId) => {
      setTaskCompleted(stepId);
    });
    
    window.electronAPI.onLoadingStepFailed((stepId) => {
      setTaskFailed(stepId);
    });

    window.electronAPI.onLoadingStepSkipped((stepId) => {
      setTaskSkipped(stepId);
    });

    window.electronAPI.onLoadingComplete(async () => {
      addLog('\n✅ Initialization complete!\n', 'success');
      addLog('Full health check will run shortly in background...\n', 'info');

      loadingFinished = true;
      clearManualRecovery();
      updateStatus('Initialization complete...');
      updateProgress(100);
      setTaskCompleted('ready');
      maybeLaunchAfterLoading();
    });
    
    window.electronAPI.onLoadingError((payload) => {
      const { message, recovery } = normalizeLoadingErrorPayload(payload);
      updateStatus(message);
      if (recovery) {
        showManualRecovery(recovery);
      } else {
        clearManualRecovery();
      }
      recoveryButtons.classList.add('visible');
      void setLogsDrawerOpen(true);

      // Hide the final task that won't run to prevent button overlap
      const readyTask = document.getElementById('task-ready');
      if (readyTask) readyTask.style.display = 'none';
    });

    if (window.electronAPI?.onDbCorruptionDetected) {
      window.electronAPI.onDbCorruptionDetected((payload) => {
        void handleDbCorruptionEvent(payload);
      });
    }

    window.electronAPI.onSetupWizardNeeded(async () => {
      console.log('Setup wizard needed - reconciling current user first');
      const authenticated = await runCurrentUserAuthGate({
        source: 'setup-required',
      });
      if (!authenticated) {
        return;
      }
      await continueAfterAuthentication();
    });

    // Track if update is being handled
    let updateInProgress = false;
    let updateTaskMode = 'legacy';
    const launchUpdateGate = {
      active: false,
      updateInfo: null,
      updateKey: null,
      lastPrepPhase: null,
      lastPrepLogText: null,
      installStarted: false,
      autoResumeAfterPreparation: false,
      autoResumeRetryCount: 0,
    };
    const LAUNCH_UPDATE_RETRY_REFRESH_TIMEOUT_MS = 10000;

    function normalizeChecksumValue(value) {
      if (typeof value !== 'string') return null;
      const normalized = value.trim().toLowerCase();
      return normalized || null;
    }

    function getChecksumIdentity(checksum) {
      if (!checksum || typeof checksum !== 'object') return null;
      const priority = ['sha256', 'sha512', 'sha1', 'md5'];
      for (const algorithm of priority) {
        const value = normalizeChecksumValue(checksum[algorithm]);
        if (value) return { algorithm, value };
      }
      return null;
    }

    function buildUpdateKey(updateInfo) {
      if (!updateInfo) return null;
      if (typeof updateInfo.updateKey === 'string' && updateInfo.updateKey.trim()) {
        return updateInfo.updateKey.trim();
      }
      if (!updateInfo.latestBuildNumber) return null;

      const channel = updateInfo.updateChannel || 'unknown';
      const checksumIdentity = getChecksumIdentity(updateInfo.checksum);
      if (checksumIdentity) {
        return `${updateInfo.latestBuildNumber}|${checksumIdentity.algorithm}:${checksumIdentity.value}|${channel}`;
      }

      const lastModified = updateInfo.lastModified || 'unknown';
      return `${updateInfo.latestBuildNumber}|legacy-lastModified:${lastModified}|${channel}`;
    }

    function setLaunchGateControls(isLaunchGate) {
      const controlPlaneBtn = document.getElementById('control-plane-btn');
      const retryBtn = document.getElementById('retry-btn');

      if (controlPlaneBtn) {
        controlPlaneBtn.style.display = isLaunchGate ? 'none' : '';
      }
      if (retryBtn) {
        retryBtn.textContent = isLaunchGate
          ? 'Retry Update Preparation'
          : 'Retry Initialization';
      }
    }

    function shouldHandleLaunchPrepStatus(status) {
      if (!launchUpdateGate.active) return false;
      if (!status || typeof status !== 'object') return false;
      if (
        launchUpdateGate.updateKey &&
        status.updateKey &&
        launchUpdateGate.updateKey !== status.updateKey
      ) {
        return false;
      }
      return true;
    }

    function shouldMirrorPrepLogLine(text) {
      if (!text) return false;
      return (
        text.includes('Using Docker image manifest') ||
        text.includes('Release manifest declares') ||
        text.includes('Pulling Docker image:') ||
        text.includes('Prepared Docker image:') ||
        text.includes('Failed Docker image pull:') ||
        text.includes('Retrying Docker image pull:') ||
        text.includes('Docker stalled; restarting OrbStack') ||
        text.includes('Retrying Docker image preparation') ||
        text.includes('Docker recovered after OrbStack restart') ||
        text.includes('Stopping OrbStack...') ||
        text.includes('Starting OrbStack...') ||
        text.includes('Waiting for OrbStack to be ready') ||
        text.includes('Docker image preparation complete') ||
        text.includes('Docker image preparation finished with failures') ||
        text.startsWith('  - ')
      );
    }

    function handleLaunchPrepStatus(status) {
      if (!shouldHandleLaunchPrepStatus(status)) return;

      const phase = status.phase || null;
      const prepMessage = status.message || 'Preparing required update...';
      const prepPercent = Number.isFinite(status.overallPercent)
        ? Math.max(0, Math.min(100, Math.round(status.overallPercent)))
        : 0;

      if (phase && phase !== launchUpdateGate.lastPrepPhase) {
        launchUpdateGate.lastPrepPhase = phase;
        addLog(`🛠️ ${prepMessage}`, 'info');
      }

      if (status.state === 'preparing') {
        updateStatus(prepMessage);
        updateProgress(Math.max(5, Math.min(90, prepPercent)));
        return;
      }

      if (status.state === 'failed') {
        const errorMessage = status.error || 'Unknown preparation error';
        launchUpdateGate.autoResumeAfterPreparation = false;
        updateStatus('Required update preparation failed');
        addLog(`❌ Update preparation failed: ${errorMessage}`, 'error');
        recoveryButtons.classList.add('visible');
        setLaunchGateControls(true);
        return;
      }

      if (status.state === 'ready') {
        if (launchUpdateGate.installStarted) {
          return;
        }

        const resumedUpdateInfo = {
          ...(launchUpdateGate.updateInfo || {}),
        };
        if (status.updateKey) {
          resumedUpdateInfo.updateKey = status.updateKey;
        }
        if (status.prepared && status.prepared.ready === true) {
          resumedUpdateInfo.prepared = status.prepared;
        }
        launchUpdateGate.updateInfo = resumedUpdateInfo;
        launchUpdateGate.updateKey = buildUpdateKey(resumedUpdateInfo);

        if (launchUpdateGate.autoResumeAfterPreparation) {
          launchUpdateGate.autoResumeAfterPreparation = false;
          launchUpdateGate.installStarted = true;
          recoveryButtons.classList.remove('visible');
          updateStatus('Required update is ready. Resuming installation...');
          updateProgress(92);
          addLog('✅ Refreshed update snapshot is ready. Resuming installation...', 'success');
          void executeUpdateFlow(resumedUpdateInfo, { resetLogs: false });
          return;
        }

        launchUpdateGate.installStarted = true;
        updateStatus('Required update is ready. Starting installation...');
        updateProgress(92);
        addLog('✅ Required update is prepared. Installing now...', 'success');
        recoveryButtons.classList.remove('visible');
        void executeUpdateFlow(resumedUpdateInfo, { resetLogs: true });
      }
    }

    function isUsableLaunchRetryUpdateInfo(updateCheckResult) {
      return Boolean(
        updateCheckResult?.success === true &&
        updateCheckResult?.updateAvailable === true &&
        typeof updateCheckResult?.downloadUrl === 'string' &&
        updateCheckResult.downloadUrl.trim() &&
        typeof updateCheckResult?.filename === 'string' &&
        updateCheckResult.filename.trim()
      );
    }

    async function refreshLaunchRetryUpdateInfo(timeoutMs = LAUNCH_UPDATE_RETRY_REFRESH_TIMEOUT_MS) {
      if (!window.electronAPI?.checkForUpdates) {
        return {
          success: false,
          error: 'Update recheck is unavailable in this window.',
        };
      }

      let timeoutId = null;
      const guardedUpdateCheck = Promise.resolve()
        .then(() => window.electronAPI.checkForUpdates())
        .then((result) => ({ success: true, result }))
        .catch((error) => ({
          success: false,
          error: error?.message || String(error || 'Unknown error'),
        }));

      const timeoutResult = new Promise((resolve) => {
        timeoutId = setTimeout(() => {
          resolve({
            success: false,
            timedOut: true,
            error: `Update recheck timed out after ${timeoutMs}ms`,
          });
        }, timeoutMs);
      });

      const outcome = await Promise.race([guardedUpdateCheck, timeoutResult]);
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      return outcome;
    }

    async function startLaunchUpdatePreparation(updateInfo, opts = {}) {
      if (!window.electronAPI?.startUpdatePreparation || !updateInfo) {
        addLog('❌ Unable to start required update preparation (missing metadata)', 'error');
        recoveryButtons.classList.add('visible');
        setLaunchGateControls(true);
        return;
      }

      const isRetry = opts.retry === true;
      if (isRetry) {
        addLog('🔄 Retrying update preparation...', 'info');
      } else {
        addLog('🚧 Preparing required update before startup...', 'info');
      }

      launchUpdateGate.lastPrepPhase = null;
      launchUpdateGate.lastPrepLogText = null;
      updateStatus('Preparing required update...');
      updateProgress(5);

      try {
        let preparationUpdateInfo = updateInfo;
        if (isRetry) {
          addLog('🔎 Rechecking update metadata before retrying preparation...', 'info');
          const refreshedUpdate = await refreshLaunchRetryUpdateInfo();
          if (isUsableLaunchRetryUpdateInfo(refreshedUpdate?.result)) {
            preparationUpdateInfo = refreshedUpdate.result;
            launchUpdateGate.updateInfo = preparationUpdateInfo;
            launchUpdateGate.updateKey = buildUpdateKey(preparationUpdateInfo);
            addLog('✅ Retry is using refreshed update metadata.', 'success');
          } else {
            const refreshFailure =
              refreshedUpdate?.error ||
              'Retry update recheck did not return a usable update payload.';
            addLog(`⚠️ ${refreshFailure} Continuing with cached update metadata.`, 'warning');
          }
        }

        const prepResult = await window.electronAPI.startUpdatePreparation(preparationUpdateInfo);
        if (prepResult?.success === false) {
          launchUpdateGate.autoResumeAfterPreparation = false;
          updateStatus('Required update preparation failed');
          addLog(`❌ Failed to start update preparation: ${prepResult.error || 'Unknown error'}`, 'error');
          recoveryButtons.classList.add('visible');
          setLaunchGateControls(true);
          return;
        }
        if (prepResult?.status) {
          handleLaunchPrepStatus(prepResult.status);
        }
      } catch (error) {
        updateStatus('Required update preparation failed');
        addLog(`❌ Failed to start update preparation: ${error.message}`, 'error');
        recoveryButtons.classList.add('visible');
        setLaunchGateControls(true);
      }
    }

    if (typeof window.electronAPI.onMenuUpdateRequested === 'function') {
      window.electronAPI.onMenuUpdateRequested(async (payload) => {
        const updateInfo = payload?.updateInfo;
        if (!updateInfo) {
          console.warn('[Update] Ignoring loading-window menu update request with missing metadata');
          return;
        }

        if (payload?.postPreparationAction !== 'auto-install') {
          console.warn('[Update] Ignoring loading-window menu update request that requires the main window prompt flow');
          return;
        }

        console.log('[Update] Loading window handling menu-triggered auto-install:', updateInfo);
        updateInProgress = true;
        launchUpdateGate.active = true;
        launchUpdateGate.updateInfo = updateInfo;
        launchUpdateGate.updateKey = buildUpdateKey(updateInfo);
        launchUpdateGate.lastPrepPhase = null;
        launchUpdateGate.lastPrepLogText = null;
        launchUpdateGate.installStarted = false;
        launchUpdateGate.autoResumeAfterPreparation = false;
        launchUpdateGate.autoResumeRetryCount = 0;
        setLaunchGateControls(true);
        recoveryButtons.classList.remove('visible');

        addLog(
          `🔄 Preparing requested install from the app menu: ${updateInfo.latestBuildNumber || 'latest build'}`,
          'info',
        );
        await startLaunchUpdatePreparation(updateInfo);
      });
    }
    
    // Listen for update available notification
    window.electronAPI.onUpdateAvailable((updateInfo) => {
      console.log('Update available notification received:', updateInfo);
      updateInProgress = true;
      launchUpdateGate.active = true;
      launchUpdateGate.updateInfo = updateInfo;
      launchUpdateGate.updateKey = buildUpdateKey(updateInfo);
      launchUpdateGate.lastPrepPhase = null;
      launchUpdateGate.lastPrepLogText = null;
      launchUpdateGate.installStarted = false;
      launchUpdateGate.autoResumeAfterPreparation = false;
      launchUpdateGate.autoResumeRetryCount = 0;
      setLaunchGateControls(true);
      recoveryButtons.classList.remove('visible');

      // Add update notification to logs
      const updateMessage = `🔄 Update available: ${updateInfo.latestBuildNumber} (current: ${updateInfo.currentBuildNumber})`;
      addLog(updateMessage, 'info');
      updateStatus('Preparing required update...');
      addLog('⛔ Launch is blocked until this required update is handled.', 'warning');
      void startLaunchUpdatePreparation(updateInfo);
    });
    
    // Listen for signal to proceed with initialization (no update available or check skipped).
    // Update workflows must finish first; once they do, auth becomes the first startup gate.
    window.electronAPI.onProceedWithInitialization(async () => {
      if (launchUpdateGate.active) {
        console.log('Ignoring proceed-with-initialization during launch update gate');
        return;
      }
      console.log('No update required, checking login before initialization');
      const authenticated = await runCurrentUserAuthGate({ source: 'post-update-check' });
      if (!authenticated) {
        return;
      }
      await continueAfterAuthentication();
    });

    window.electronAPI.onUpdatePreparationStatus((status) => {
      handleLaunchPrepStatus(status);
    });

    if (typeof window.electronAPI.onUpdatePreparationLog === 'function') {
      window.electronAPI.onUpdatePreparationLog((entry) => {
        if (!launchUpdateGate.active) return;
        const text = typeof entry?.text === 'string' ? entry.text.trim() : '';
        if (!shouldMirrorPrepLogLine(text)) return;
        if (launchUpdateGate.lastPrepLogText === text) return;
        launchUpdateGate.lastPrepLogText = text;
        addLog(`⚙️ ${text}`, entry?.type || 'info');
      });
    }

    // Listen for stopping services notification (when user quits mandatory update)
    window.electronAPI.onStoppingServices(() => {
      console.log('Stopping services notification received');
      const loadingOverlay = document.getElementById('debug-loading-overlay');
      const loadingText = loadingOverlay.querySelector('.loading-text');
      if (loadingText) {
        loadingText.textContent = 'Stopping services before exit...';
      }
      loadingOverlay.classList.add('visible');
      updateStatus('Stopping services...');
      addLog('⏹️ Stopping all services before exit...', 'warning');
    });

    // Set up update handlers BEFORE DOMContentLoaded
    function switchToUpdateTasks(updateInfo) {
      setBodyMode('update');
      updateTaskMode = Boolean(updateInfo?.prepared?.ready) ? 'prepared' : 'legacy';
    }

    async function executeUpdateFlow(updateInfo, options = {}) {
      if (!updateInfo) {
        updateStatus('Update failed');
        addLog('❌ Missing update metadata for execution', 'error');
        recoveryButtons.classList.add('visible');
        setLaunchGateControls(launchUpdateGate.active);
        return;
      }

      const resetLogs = options.resetLogs !== false;
      console.log('Starting update process:', updateInfo);
      updateInProgress = true;
      launchUpdateGate.active = true;
      launchUpdateGate.updateInfo = updateInfo;
      launchUpdateGate.updateKey = buildUpdateKey(updateInfo);
      launchUpdateGate.installStarted = true;
      if (resetLogs) {
        launchUpdateGate.autoResumeRetryCount = 0;
        launchUpdateGate.autoResumeAfterPreparation = false;
      }
      setLaunchGateControls(true);
      recoveryButtons.classList.remove('visible');

      // Switch to update-specific caption/progress handling.
      switchToUpdateTasks(updateInfo);

      // Update UI to show update mode
      const title = document.querySelector('h1');
      if (title) title.textContent = 'Updating Portico';

      if (resetLogs) {
        logContent.innerHTML = '';
        updateProgress(0);
        updateStatus('Starting update process...');
        addLog('🔄 Starting update process...', 'info');
        addLog(`Current version: ${updateInfo.currentBuildNumber}`, 'info');
        addLog(`New version: ${updateInfo.latestBuildNumber}`, 'info');
        addLog('', 'info');
      } else {
        updateStatus('Resuming update process...');
        addLog('🔄 Resuming update process with refreshed snapshot...', 'info');
      }

      // Start the update execution
      const result = await window.electronAPI.executeUpdate(updateInfo);
      console.log('Update execution started:', result);
      await handleImmediateUpdateExecutionResult(result);
    }

    async function handleImmediateUpdateExecutionResult(result) {
      // Script-based update flow emits "update-complete"; only handle immediate IPC returns here.
      if (!result || result.success !== false || typeof result.code !== 'undefined') {
        return false;
      }

      if (result.stalePrepared) {
        const nextUpdateInfo = result.nextUpdateInfo || launchUpdateGate.updateInfo;
        if (nextUpdateInfo) {
          launchUpdateGate.updateInfo = nextUpdateInfo;
          launchUpdateGate.updateKey = buildUpdateKey(nextUpdateInfo);
        }

        launchUpdateGate.installStarted = false;
        launchUpdateGate.lastPrepPhase = null;
        launchUpdateGate.autoResumeRetryCount += 1;
        launchUpdateGate.autoResumeAfterPreparation = true;
        recoveryButtons.classList.remove('visible');
        setLaunchGateControls(true);

        if (launchUpdateGate.autoResumeRetryCount > 3) {
          launchUpdateGate.autoResumeAfterPreparation = false;
          updateStatus('Update failed');
          addLog('❌ Update payload changed too many times during install. Please retry.', 'error');
          recoveryButtons.classList.add('visible');
          return true;
        }

        const staleMessage = result.error ||
          'Prepared update became stale while launching. Refreshing the latest payload.';
        addLog(`⚠️ ${staleMessage}`, 'warning');
        updateStatus('Preparing latest required update snapshot...');
        updateProgress(8);

        void startLaunchUpdatePreparation(launchUpdateGate.updateInfo, { retry: true });
        return true;
      }

      launchUpdateGate.autoResumeAfterPreparation = false;
      launchUpdateGate.installStarted = false;
      updateStatus('Update failed');
      addLog('', 'info');
      addLog('❌ Update failed: ' + (result.error || 'Unknown error'), 'error');
      recoveryButtons.classList.add('visible');
      setLaunchGateControls(launchUpdateGate.active);
      return true;
    }

    // Listen for signal to start update
    window.electronAPI.onStartUpdate(async (updateInfo) => {
      await executeUpdateFlow(updateInfo, { resetLogs: true });
    });
    
    // Listen for update output
    window.electronAPI.onUpdateOutput((data) => {
      // Add output to logs
      const lines = data.data.split('\n');
      lines.forEach(line => {
        if (line.trim()) {
          const isPreparedMode = updateTaskMode === 'prepared';

          // Parse special status lines into the single loading caption + progress bar.
          if (isPreparedMode && line.includes('Step 1: Validating prepared update')) {
            updateStatus('Validating prepared update...');
            updateProgress(22);
          } else if (
            isPreparedMode &&
            (
              line.includes('Step 2: Installing prepared backup artifacts') ||
              line.includes('Step 2: Installing prepared artifacts')
            )
          ) {
            updateStatus('Installing prepared files...');
            updateProgress(50);
          } else if (isPreparedMode && line.includes('Step 3: Syncing prepared source payload into managed installation')) {
            updateStatus('Installing prepared files...');
            updateProgress(62);
          } else if (isPreparedMode && line.includes('Step 4: Installing prepared artifacts')) {
            updateStatus('Installing prepared files...');
            updateProgress(76);
          } else if (
            isPreparedMode &&
            (
              line.includes('Step 5: Prepared update installed') ||
              line.includes('Step 3: Prepared update installed')
            )
          ) {
            updateStatus('Prepared files installed...');
            updateProgress(88);
          } else if (isPreparedMode && line.includes('READY_FOR_RESTART')) {
            updateProgress(95);
          } else if (!isPreparedMode && (line.includes('Step 1:') || line.includes('Downloading'))) {
            updateStatus('Downloading update...');
            updateProgress(20);
          } else if (!isPreparedMode && (line.includes('Step 2:') || line.includes('Extracting'))) {
            updateStatus('Extracting files...');
            updateProgress(30);
          } else if (!isPreparedMode && (line.includes('Step 3:') || line.includes('Building') || line.includes('npm run build'))) {
            updateStatus('Building application (this may take a few minutes)...');
            updateProgress(60);
          } else if (!isPreparedMode && (line.includes('Step 4:') || line.includes('Replacing') || line.includes('Swapping'))) {
            updateStatus('Installing update...');
            updateProgress(80);
          } else if (line.includes('✅')) {
            addLog(line, 'success');
            return;
          } else if (line.includes('❌')) {
            addLog(line, 'error');
            return;
          } else if (line.includes('⚠️')) {
            addLog(line, 'warning');
            return;
          }
          
          // Add regular log
          addLog(line, data.type === 'stderr' ? 'error' : 'info');
        }
      });
    });
    
    // Listen for update completion
    window.electronAPI.onUpdateComplete(async (data) => {
      console.log('Update complete:', data);
      
      if (data.success && data.readyForRestart) {
        updateProgress(100);
        updateStatus('Update complete! Restarting application...');
        
        addLog('', 'info');
        addLog('✅ Update completed successfully!', 'success');
        addLog('🔄 Restarting application...', 'info');
        
        // Wait a moment then restart
        setTimeout(async () => {
          const result = await window.electronAPI.restartAfterUpdate();
          if (!result.success) {
            addLog('❌ Failed to restart: ' + result.error, 'error');
            updateStatus('Update complete but restart failed');
            recoveryButtons.classList.add('visible');
            setLaunchGateControls(launchUpdateGate.active);
          }
        }, 2000);
      } else {
        launchUpdateGate.installStarted = false;
        updateStatus('Update failed');
        addLog('', 'info');
        addLog('❌ Update failed: ' + (data.error || 'Unknown error'), 'error');
        
        // Show recovery options
        recoveryButtons.classList.add('visible');
        setLaunchGateControls(launchUpdateGate.active);
      }
    });
    
    // Button handlers
    document.getElementById('copy-logs').addEventListener('click', async () => {
      const textContent = Array.from(logContent.querySelectorAll('.log-entry'))
        .map(entry => entry.textContent)
        .join('\n');
      
      if (!textContent) {
        addLog('No logs to copy\n', 'warning');
        return;
      }
      
      try {
        // Use Electron API for clipboard access instead of navigator.clipboard
        await window.electronAPI.copyToClipboard(textContent);
        const feedback = document.getElementById('copy-feedback');
        feedback.classList.add('visible');
        setTimeout(() => feedback.classList.remove('visible'), 2000);
      } catch (err) {
        console.error('Failed to copy:', err);
        addLog('Failed to copy logs to clipboard\n', 'error');
      }
    });

    if (copyRecoveryCommandBtn) {
      copyRecoveryCommandBtn.addEventListener('click', async () => {
        if (!currentRecoveryCommand) {
          return;
        }

        try {
          await window.electronAPI.copyToClipboard(currentRecoveryCommand);
          copyRecoveryCommandBtn.classList.add('copied');
          copyRecoveryCommandBtn.textContent = 'Copied';
          setTimeout(() => {
            copyRecoveryCommandBtn.classList.remove('copied');
            copyRecoveryCommandBtn.textContent = 'Copy';
          }, 2000);
        } catch (error) {
          addLog('Failed to copy recovery command to clipboard\n', 'error');
        }
      });
    }
    
    document.getElementById('control-plane-btn').addEventListener('click', () => {
      if (launchUpdateGate.active) {
        addLog('⛔ Cannot open Control Plane while required launch update is pending.', 'warning');
        return;
      }
      if (authFailureActive) {
        addLog('⛔ Startup is blocked until login succeeds.', 'warning');
        return;
      }
      // Open the control plane directly to allow debugging
      addLog('Opening control plane...', 'info');
      window.electronAPI.showMainWindow({ tab: 'control' });
    });
    
    document.getElementById('retry-btn').addEventListener('click', () => {
      if (launchUpdateGate.active) {
        recoveryButtons.classList.remove('visible');
        clearManualRecovery();
        launchUpdateGate.installStarted = false;
        launchUpdateGate.autoResumeAfterPreparation = false;
        updateStatus('Retrying required update preparation...');
        setLaunchGateControls(true);
        void startLaunchUpdatePreparation(launchUpdateGate.updateInfo, { retry: true });
        return;
      }

      if (authFailureActive) {
        recoveryButtons.classList.remove('visible');
        clearManualRecovery();
        setAuthRecoveryState(false);
        resetTaskState('auth');
        updateStatus('Retrying login...');
        addLog('🔄 Retrying login...\n', 'info');
        void (async () => {
          const authenticated = await runCurrentUserAuthGate({ source: 'retry' });
          if (!authenticated) {
            return;
          }
          await continueAfterAuthentication();
        })();
        return;
      }

      // Reset UI state
      Object.values(tasks).forEach(task => {
        if (!task) return;
        task.classList.remove('active', 'completed', 'failed');
        task.style.display = ''; // Show all tasks again
      });
      setBodyMode('startup');
      launchTriggered = false;
      loadingFinished = false;
      setAuthRecoveryState(false);
      updateProgress(0);
      logContent.innerHTML = '';
      recoveryButtons.classList.remove('visible');
      clearManualRecovery();
      
      updateStatus('Retrying initialization...');
      addLog('🔄 Retrying initialization...\n', 'info');
      
      // Start initialization with retry flag to restart OrbStack first
      window.electronAPI.startInitializationWithRetry();
    });
    
    document.getElementById('debug-btn').addEventListener('click', async () => {
      const debugLoadingOverlay = document.getElementById('debug-loading-overlay');
      const debugLoadingText = document.querySelector('#debug-loading-overlay .loading-text');
      const defaultDebugLoadingText = 'Collecting debug information...';
      const startedAt = Date.now();

      debugLoadingOverlay.classList.add('visible');
      if (debugLoadingText) {
        debugLoadingText.textContent = defaultDebugLoadingText;
      }

      // Save the initialization logs before collecting debug info
      const logEntries = Array.from(logContent.querySelectorAll('.log-entry'));
      const initLogs = logEntries
        .map(entry => entry.textContent)
        .join('\n');

      if (window.electronAPI?.logToMain) {
        window.electronAPI.logToMain('info', '[Debug Info] Loading screen collection started', {
          source: 'loading',
          logEntries: logEntries.length,
          initLogChars: initLogs.length,
          startedAt
        });
      }

      window.electronAPI.saveInitLogs(initLogs);

      try {
        const result = await window.electronAPI.collectDebugInfo();

        if (!result.success || !result.zipFile) {
          const errMsg = result.error || 'Debug collection did not produce a zip file';
          addLog('Failed to collect debug information. Please try again.', 'error');
          if (window.electronAPI?.logToMain) {
            window.electronAPI.logToMain('error', '[Debug Info] Loading screen collection failed', {
              source: 'loading',
              elapsedMs: Date.now() - startedAt,
              error: errMsg
            });
          }
          return;
        }

        if (window.electronAPI?.logToMain) {
          window.electronAPI.logToMain('info', '[Debug Info] Collection complete', {
            source: 'loading',
            elapsedMs: Date.now() - startedAt,
            zipFile: result.zipFile
          });
        }

        addLog(`Debug information collected: ${result.zipFile}`, 'success');
      } catch (error) {
        addLog('Something went wrong while collecting debug information. Please try again.', 'error');
        if (window.electronAPI?.logToMain) {
          window.electronAPI.logToMain('error', '[Debug Info] Loading screen collection errored', {
            source: 'loading',
            elapsedMs: Date.now() - startedAt,
            error: error.message
          });
        }
      } finally {
        debugLoadingOverlay.classList.remove('visible');
        if (debugLoadingText) {
          debugLoadingText.textContent = defaultDebugLoadingText;
        }
      }
    });
    
    // Listen for restart initialization (from control panel)
    window.electronAPI.onStartInitializationForRestart(() => {
      console.log('Received restart initialization request');
      // Reset UI
      Object.values(tasks).forEach(task => {
        if (!task) return;
        task.classList.remove('active', 'completed', 'failed');
        task.style.display = ''; // Show all tasks again
      });
      setBodyMode('startup');
      launchTriggered = false;
      loadingFinished = false;
      setAuthRecoveryState(false);
      stopCurrentUserStatusPolling();
      updateProgress(0);
      logContent.innerHTML = '';
      recoveryButtons.classList.remove('visible');
      clearManualRecovery();
      
      addLog('🔄 Restarting Portico services...\n', 'info');
      updateStatus('Restarting services...');
      
      // Start initialization
      window.electronAPI.startInitialization();
    });
    
    // Setup build info and wait for signals from main process
    window.addEventListener('DOMContentLoaded', async () => {
      console.log('DOM loaded, waiting for main process signals...');
      setBodyMode('startup');
      
      // Load build info using extracted component
      if (window.renderBuildBadge) {
        await window.renderBuildBadge();
      }
      
      // DO NOT start initialization automatically!
      // Wait for explicit signals from main process:
      // - 'proceed-with-initialization' (no update or user chose Later)
      // - 'start-update' (update available and user accepted)
      // The main process will send one of these after checking for updates
      console.log('Loading window ready, waiting for update check to complete...');
      updateStatus('Checking for updates...');
      updateCurrentStepCaption(null, 'Checking for updates...');
      void setLogsDrawerOpen(false);
    });
