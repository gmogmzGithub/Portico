// Success screen module for guided setup
// Shows completion message and launch button
// Refactored to use secure IPC via window.electronAPI (no direct Node.js access)

// Launch the app
function launchApp() {
  window.electronAPI.electronAppComplete();
}

// Export functions
module.exports = {
  launchApp
};

// NOTE: Window exports are handled by the main guided-setup.js orchestrator
// launchApp doesn't need callbacks but we keep consistency
