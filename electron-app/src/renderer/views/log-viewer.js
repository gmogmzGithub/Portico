import { ansiToHtml } from '../../utils/ansi.js';

const { ipcRenderer } = window.require('electron');
const logContainer = document.getElementById('log-container');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const lineCount = document.getElementById('line-count');
const copyBtn = document.getElementById('copy-btn');
const clearBtn = document.getElementById('clear-btn');
const autoscrollBtn = document.getElementById('autoscroll-btn');
const closeBtn = document.getElementById('close-btn');

let autoScroll = true;
let lines = 0;

function addLogEntry(text, type = 'info') {
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;
  entry.innerHTML = ansiToHtml(text);
  logContainer.appendChild(entry);

  lines++;
  lineCount.textContent = `${lines} lines`;

  if (autoScroll) {
    logContainer.scrollTop = logContainer.scrollHeight;
  }
}

ipcRenderer.on('log-output', (event, data) => {
  addLogEntry(data.data, data.type === 'stderr' ? 'error' : 'info');
  statusDot.className = 'status-dot running';
  statusText.textContent = 'Running...';
});

ipcRenderer.on('log-complete', (event, data) => {
  if (data.code === 0) {
    statusDot.className = 'status-dot';
    statusText.textContent = 'Completed successfully';
    addLogEntry('\n✅ Process completed successfully\n', 'success');
  } else {
    statusDot.className = 'status-dot error';
    statusText.textContent = `Failed with code ${data.code}`;
    addLogEntry(`\n❌ Process failed with exit code ${data.code}\n`, 'error');
  }
});

ipcRenderer.on('add-log', (event, { text, type }) => {
  addLogEntry(text, type);
});

copyBtn.addEventListener('click', () => {
  const entries = Array.from(logContainer.querySelectorAll('.log-entry'));
  const textContent = entries.map(entry => entry.textContent).join('\n');

  if (!textContent) {
    return;
  }

  navigator.clipboard.writeText(textContent)
    .then(() => {
      const originalText = copyBtn.innerHTML;
      copyBtn.style.background = '#9ece6a';
      copyBtn.style.color = '#1a1b26';
      copyBtn.innerHTML = copyBtn.innerHTML.replace('Copy', 'Copied!');
      setTimeout(() => {
        copyBtn.style.background = '';
        copyBtn.style.color = '';
        copyBtn.innerHTML = originalText;
      }, 1000);
    })
    .catch(err => {
      console.error('Failed to copy:', err);
      const textarea = document.createElement('textarea');
      textarea.value = textContent;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
        copyBtn.style.background = '#9ece6a';
        setTimeout(() => copyBtn.style.background = '', 1000);
      } catch (e) {
        console.error('Fallback copy failed:', e);
      }
      document.body.removeChild(textarea);
    });
});

clearBtn.addEventListener('click', () => {
  logContainer.innerHTML = '';
  lines = 0;
  lineCount.textContent = '0 lines';
});

autoscrollBtn.addEventListener('click', () => {
  autoScroll = !autoScroll;
  autoscrollBtn.classList.toggle('active', autoScroll);
});

closeBtn.addEventListener('click', () => {
  window.close();
});

logContainer.addEventListener('scroll', () => {
  const isAtBottom = logContainer.scrollHeight - logContainer.scrollTop === logContainer.clientHeight;
  if (!isAtBottom && autoScroll) {
    autoScroll = false;
    autoscrollBtn.classList.remove('active');
  } else if (isAtBottom && !autoScroll) {
    autoScroll = true;
    autoscrollBtn.classList.add('active');
  }
});
