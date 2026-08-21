function getBuildInfoHelpers() {
  if (window.buildInfoHelpers?.getResolvedBuildChannelInfo) {
    return window.buildInfoHelpers;
  }
  throw new Error('Build info channel helper is unavailable');
}

// Build badge component - extracted from renderer.js
async function renderBuildBadge() {
  try {
    const buildInfo = await window.electronAPI.getBuildInfo();
    const buildText = document.getElementById('build-text');
    const copyButton = document.getElementById('copy-build');

    if (buildInfo && buildInfo.buildNumber && buildText) {
      const buildInfoHelpers = getBuildInfoHelpers();
      const { displayChannel, label: channelLabel } =
        buildInfoHelpers.getResolvedBuildChannelInfo(buildInfo);
      const channelBadge = `<span class="channel-badge ${displayChannel}">${channelLabel}</span>`;
      buildText.innerHTML = `${channelBadge} Build: ${buildInfo.buildNumber}`;

      if (copyButton) {
        copyButton.onclick = async () => {
          try {
            const fullBuildString = `Portico ${channelLabel} Build: ${buildInfo.buildNumber}`;
            await window.electronAPI.copyToClipboard(fullBuildString);
            const originalHTML = copyButton.innerHTML;
            copyButton.classList.add('copied');
            copyButton.innerHTML = `
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
              <span>Copied!</span>
            `;
            setTimeout(() => {
              copyButton.classList.remove('copied');
              copyButton.innerHTML = originalHTML;
            }, 2000);
          } catch (err) {
            console.error('Failed to copy:', err);
          }
        };
      }
    } else if (buildText) {
      buildText.innerHTML = '<span class="channel-badge dev">Dev</span> Build: dev-build';
      if (copyButton) copyButton.style.display = 'none';
    }
  } catch (error) {
    console.error('Failed to load build info:', error);
    const buildText = document.getElementById('build-text');
    if (buildText) buildText.innerHTML = '<span class="channel-badge dev">Dev</span> Build: dev-build';
    const copyButton = document.getElementById('copy-build');
    if (copyButton) copyButton.style.display = 'none';
  }
}

window.renderBuildBadge = renderBuildBadge;
