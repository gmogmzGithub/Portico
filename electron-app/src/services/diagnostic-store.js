// diagnostic-store.js - Local persistence for diagnostic reports
// State & Persistence layer
// Writes report JSON to ~/Library/Application Support/portico/logs/diagnostics/

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

function getDiagnosticsDir() {
  return path.join(app.getPath('userData'), 'logs', 'diagnostics');
}

async function saveDiagnosticReport(referenceId, snapshot, userDescription) {
  const dir = getDiagnosticsDir();
  fs.mkdirSync(dir, { recursive: true });

  const report = {
    reference_id: referenceId,
    user_description: userDescription || '',
    submitted_at: new Date().toISOString(),
    ...snapshot,
  };

  const filePath = path.join(dir, `${referenceId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf-8');
  return { filePath, referenceId };
}

module.exports = { saveDiagnosticReport, getDiagnosticsDir };
