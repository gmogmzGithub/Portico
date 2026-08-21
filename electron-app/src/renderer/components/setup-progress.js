// Progress tracker component for guided setup
// Extracted from guided-setup.js

// Update progress tracker based on current state
function stepIsHiddenForMode(stepName, onboardingMode) {
  return (
    onboardingMode === 'basic' &&
    (stepName === 'server-selection' || stepName === 'configuration')
  );
}

function getHelloStepLabel(onboardingMode) {
  if (onboardingMode === 'basic') return 'Basic';
  if (onboardingMode === 'power') return 'Power';
  return 'Mode';
}

function prerequisitesStepIsHidden(prereqPolicy = {}) {
  return prereqPolicy?.showStep === false;
}

function oauthStepIsHidden(oauthStepRequired, progressState = {}) {
  const oauthServerIds = toTrackedIdSet(progressState.oauthServers);
  if (oauthServerIds.size > 0) {
    return false;
  }
  return oauthStepRequired === false;
}

function stepIsHidden(stepName, onboardingMode, prereqPolicy = {}, oauthStepRequired = null, progressState = {}) {
  return stepIsHiddenForMode(stepName, onboardingMode) ||
    (stepName === 'prerequisites' && prerequisitesStepIsHidden(prereqPolicy)) ||
    (stepName === 'oauth' && oauthStepIsHidden(oauthStepRequired, progressState));
}

function toTrackedIdSet(values) {
  const normalizedValues = values instanceof Set
    ? Array.from(values)
    : Array.isArray(values)
      ? values
      : [];
  const ids = new Set();

  normalizedValues.forEach((value) => {
    const id = typeof value === 'string' ? value : value?.id;
    if (typeof id === 'string' && id.trim()) {
      ids.add(id);
    }
  });

  return ids;
}

function countTrackedIdsInScope(scopeIds, candidateIds) {
  let count = 0;

  scopeIds.forEach((id) => {
    if (candidateIds.has(id)) {
      count += 1;
    }
  });

  return count;
}

function getConfigurationProgress(currentStage, completedSteps = {}, serverConfigs = [], progressState = {}) {
  const configServerIds = toTrackedIdSet(serverConfigs);
  const configuredServerIds = toTrackedIdSet(progressState.configuredServers);
  const skippedServerIds = toTrackedIdSet(progressState.skippedServers);
  const manuallyConfiguredServerIds = new Set();

  Object.entries(completedSteps?.servers || {}).forEach(([serverId, completed]) => {
    if (completed === true && typeof serverId === 'string' && serverId.trim()) {
      configuredServerIds.add(serverId);
      manuallyConfiguredServerIds.add(serverId);
    }
  });

  if (configServerIds.size === 0) {
    return {
      isComplete: currentStage === 'finalize' || currentStage === 'success',
      isPartial: false,
    };
  }

  const configuredCount = countTrackedIdsInScope(configServerIds, configuredServerIds);
  const skippedCount = countTrackedIdsInScope(configServerIds, skippedServerIds);
  const manuallyConfiguredCount = countTrackedIdsInScope(configServerIds, manuallyConfiguredServerIds);
  const isComplete = configuredCount === configServerIds.size && skippedCount === 0;
  const isPartial = !isComplete && (manuallyConfiguredCount > 0 || skippedCount > 0);

  return { isComplete, isPartial };
}

function getOauthProgress(completedSteps = {}, progressState = {}) {
  const oauthServerIds = toTrackedIdSet(progressState.oauthServers);
  const completedOAuthIds = toTrackedIdSet(progressState.completedOAuthServers);
  const connectedOAuthIds = toTrackedIdSet(progressState.connectedOAuthServers);
  const skippedOAuthIds = toTrackedIdSet(progressState.skippedOAuthServers);

  if (oauthServerIds.size === 0) {
    return {
      isComplete: completedSteps.oauth === true,
      isPartial: false,
    };
  }

  const completedCount = countTrackedIdsInScope(oauthServerIds, completedOAuthIds);
  const skippedCount = countTrackedIdsInScope(oauthServerIds, skippedOAuthIds);
  const connectedCount = countTrackedIdsInScope(oauthServerIds, connectedOAuthIds);
  const isComplete = skippedCount === 0 && (
    completedSteps.oauth === true ||
    completedCount === oauthServerIds.size
  );
  const isPartial = !isComplete && (connectedCount > 0 || skippedCount > 0);

  return { isComplete, isPartial };
}

function updateProgressTracker(currentStage, completedSteps, serverConfigs, onboardingMode = null, prereqPolicy = {}, oauthStepRequired = null, progressState = {}) {
  const steps = document.querySelectorAll('.progress-step');
  const helloLabel = document.getElementById('progress-label-hello');
  const oauthProgress = getOauthProgress(completedSteps, progressState);
  const configurationProgress = getConfigurationProgress(currentStage, completedSteps, serverConfigs, progressState);

  if (helloLabel) {
    helloLabel.textContent = getHelloStepLabel(onboardingMode);
  }

  steps.forEach(step => {
    const stepName = step.dataset.step;
    step.classList.remove('active', 'completed', 'inactive', 'warning', 'partial');
    step.style.display = stepIsHidden(stepName, onboardingMode, prereqPolicy, oauthStepRequired, progressState) ? 'none' : '';

    if (stepIsHidden(stepName, onboardingMode, prereqPolicy, oauthStepRequired, progressState)) {
      return;
    }

    if (stepName === 'hello') {
      if (currentStage === 'hello') {
        step.classList.add('active');
      } else if (currentStage !== 'welcome') {
        step.classList.add('completed');
      } else {
        step.classList.add('inactive');
      }
    } else if (stepName === 'prerequisites') {
      if (currentStage === 'prerequisites') {
        step.classList.add('active');
        if (completedSteps.prerequisitesWarning) {
          step.classList.add('warning');
        }
      } else if (completedSteps.prerequisites) {
        step.classList.add(completedSteps.prerequisitesWarning ? 'warning' : 'completed');
      } else {
        step.classList.add('inactive');
      }
    } else if (stepName === 'server-selection') {
      if (currentStage === 'server-selection') {
        step.classList.add('active');
      } else if (completedSteps.serverSelection) {
        step.classList.add('completed');
      } else if (completedSteps.prerequisites) {
        step.classList.add('inactive');
      } else {
        step.classList.add('inactive');
      }
    } else if (stepName === 'oauth') {
      // OAuth step - shown between server selection and configuration
      if (currentStage === 'oauth') {
        step.classList.add('active');
      } else if (oauthProgress.isComplete) {
        step.classList.add('completed');
      } else if (oauthProgress.isPartial) {
        step.classList.add('partial');
      } else if (completedSteps.serverSelection) {
        step.classList.add('inactive');
      } else {
        step.classList.add('inactive');
      }
    } else if (stepName === 'configuration') {
      if (currentStage === 'configuration') {
        step.classList.add('active');
      } else if (configurationProgress.isComplete) {
        step.classList.add('completed');
      } else if (configurationProgress.isPartial) {
        step.classList.add('partial');
      } else {
        step.classList.add('inactive');
      }
    } else if (stepName === 'finalize') {
      if (currentStage === 'finalize' || currentStage === 'success') {
        step.classList.add('active');
      } else {
        step.classList.add('inactive');
      }
    }
  });
}

// Check if step is accessible for navigation
function isStepAccessible(stepName, completedSteps, serverConfigs, currentStage, onboardingMode = null, prereqPolicy = {}, oauthStepRequired = null, progressState = {}) {
  if (stepIsHidden(stepName, onboardingMode, prereqPolicy, oauthStepRequired, progressState)) {
    return false;
  }

  const canBypassPrerequisites = completedSteps.prerequisites || prerequisitesStepIsHidden(prereqPolicy);
  const canAccessConfiguration = serverConfigs.length > 0 && (
    completedSteps.oauth ||
    oauthStepIsHidden(oauthStepRequired, progressState) ||
    currentStage === 'configuration'
  );

  switch (stepName) {
    case 'hello':
      return currentStage !== 'welcome';
    case 'prerequisites':
      return completedSteps.prerequisites || currentStage === 'prerequisites';
    case 'server-selection':
      return canBypassPrerequisites || currentStage === 'server-selection';
    case 'oauth':
      return completedSteps.serverSelection;
    case 'configuration':
      return canAccessConfiguration;
    case 'finalize':
      return currentStage === 'finalize';
    default:
      return false;
  }
}

// Show/hide progress tracker and panel header
function toggleProgressVisibility(stageName, completedSteps = {}, onboardingMode = null, prereqPolicy = {}, options = {}) {
  const trackerWrapper = document.getElementById('progress-tracker-wrapper');
  const header = document.getElementById('panel-header');
  const tracker = document.querySelector('.progress-tracker');
  const showPrerequisitesTracker = stageName === 'prerequisites' && options.showPrerequisitesTracker === true;

  const trackerHiddenStages = ['welcome', 'hello', 'success', 'vpn-check', 'prerequisites', 'finalize'];
  const headerHiddenStages = ['welcome', 'hello', 'success', 'vpn-check', 'prerequisites', 'server-selection', 'oauth', 'configuration', 'finalize'];

  if (showPrerequisitesTracker || !trackerHiddenStages.includes(stageName)) {
    if (trackerWrapper) trackerWrapper.style.display = 'block';
  } else {
    if (trackerWrapper) trackerWrapper.style.display = 'none';
  }

  if (!headerHiddenStages.includes(stageName)) {
    if (header) header.style.display = 'flex';
  } else {
    if (header) header.style.display = 'none';
  }

  // Toggle compact mode after the initial welcome screen.
  const compactStages = ['server-selection', 'oauth', 'configuration', 'finalize'];
  const shouldCompactPrereqs = stageName === 'prerequisites' && completedSteps.prerequisites;
  if (compactStages.includes(stageName) || shouldCompactPrereqs) {
    if (header) header.classList.add('compact');
    if (trackerWrapper) trackerWrapper.classList.add('compact');
    if (tracker) tracker.classList.add('compact');
  } else {
    if (header) header.classList.remove('compact');
    if (trackerWrapper) trackerWrapper.classList.remove('compact');
    if (tracker) tracker.classList.remove('compact');
  }
}

// Export functions
module.exports = {
  updateProgressTracker,
  isStepAccessible,
  toggleProgressVisibility
};

// Also expose to window for onclick handlers
if (typeof window !== 'undefined') {
  window.updateProgressTracker = updateProgressTracker;
}
