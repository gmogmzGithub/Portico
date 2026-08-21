// Copy to clipboard component for guided setup
// Extracted from guided-setup.js
// Refactored to use secure IPC via window.electronAPI (no direct Node.js access)

// Copy text to clipboard with visual feedback
function copyToClipboard(text, buttonId) {
  console.log('Copy function called with text:', text, 'buttonId:', buttonId);

  try {
    // Strip HTML tags from the text
    const plainText = text.replace(/<[^>]*>/g, '');
    console.log('Plain text to copy:', plainText);

    // Use secure IPC to copy to clipboard
    if (window.electronAPI && window.electronAPI.copyToClipboard) {
      window.electronAPI.copyToClipboard(plainText);
      console.log('Successfully copied to clipboard via IPC');
    } else {
      // Fallback to navigator.clipboard API (modern browsers)
      navigator.clipboard.writeText(plainText).then(() => {
        console.log('Successfully copied to clipboard via navigator.clipboard');
      }).catch(err => {
        console.error('Fallback clipboard write failed:', err);
      });
    }

    const button = document.getElementById(buttonId);
    if (button) {
      const originalHTML = button.innerHTML;

      // Show copied feedback
      button.classList.add('copied');

      // Check if it's a pane button or inline button
      const isPaneButton = button.classList.contains('copy-pane-button');
      const iconSize = isPaneButton ? '16' : '14';

      button.innerHTML = `<svg width="${iconSize}" height="${iconSize}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg><span>Copied!</span>`;

      // Reset after 2 seconds
      setTimeout(() => {
        button.classList.remove('copied');
        button.innerHTML = originalHTML;
      }, 2000);
    }
  } catch (err) {
    console.error('Failed to copy:', err);
    if (typeof addLog === 'function') {
      addLog('Failed to copy to clipboard', 'error');
    }
  }
}

// Setup keyboard shortcuts for clipboard operations
function setupClipboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Never prevent Cmd+V or Ctrl+V
    if ((e.metaKey || e.ctrlKey) && e.key === 'v') {
      return true;
    }
    // Never prevent Cmd+A or Ctrl+A
    if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
      return true;
    }
    // Never prevent Cmd+C or Ctrl+C
    if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
      return true;
    }
  }, true);
}

// Export functions
module.exports = {
  copyToClipboard,
  setupClipboardShortcuts
};

// Also expose to window for onclick handlers
if (typeof window !== 'undefined') {
  window.copyToClipboard = copyToClipboard;
}
