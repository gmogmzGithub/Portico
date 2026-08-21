function getGuidedSetupStageWindowOptions(stageName, setupState = {}) {
  // hello is the only stage whose WIDTH is load-bearing: below 861px the two
  // mode cards collapse to a single column (guided-setup.css media query), so
  // state it explicitly rather than relying on the resize default.
  if (stageName === 'hello') {
    return { targetWidth: 1180, targetHeight: 820 };
  }

  if (stageName === 'oauth') {
    return { targetHeight: 860 };
  }

  if (stageName === 'configuration') {
    return { targetHeight: 1080 };
  }

  if (stageName === 'finalize') {
    return { targetHeight: 800 };
  }

  if (stageName === 'server-selection' && setupState?.onboardingMode === 'power') {
    return { targetHeight: 880 };
  }

  return null;
}

module.exports = {
  getGuidedSetupStageWindowOptions,
};
