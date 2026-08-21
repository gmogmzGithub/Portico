// Markdown parsing for setup guides
// Extracted from guided-setup.js

// Substitute user variables in markdown content
function substituteVariables(html, envVars) {
  // Get user LDAP and name from envVars
  const userLdap = envVars['PORTICO_USER_ID'] || '[your-ldap]';
  const userName = envVars['PORTICO_USER_NAME'] || '[your-name]';

  // Replace variable tags with actual values
  html = html.replace(/<USER_LDAP\/>/g, userLdap);
  html = html.replace(/<USER_NAME\/>/g, userName);

  return html;
}

// Process browser-open tags - always opens externally (single button)
function processBrowserOpenTags(html) {
  const browserMatches = html.match(/<browser-open[^>]*url="([^"]+)"[^>]*\/>/g);
  if (browserMatches) {
    browserMatches.forEach(match => {
      const url = match.match(/url="([^"]+)"/)[1];
      // Always use single button that opens externally (matches mcp-config-modal pattern)
      const buttonHtml = `
        <div class="gs-browser-buttons">
          <button type="button" class="gs-open-browser-btn" onclick="openExternalUrl('${url}')">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
              <polyline points="15 3 21 3 21 9"></polyline>
              <line x1="10" y1="14" x2="21" y2="3"></line>
            </svg>
            Open in Browser
          </button>
        </div>
      `;
      html = html.replace(match, buttonHtml);
    });
  }
  return html;
}

// A usable chat surface does not exist during first-run Guided Setup. Consume
// runtime-only controls so their surrounding textual guidance remains without
// exposing an inert or raw custom element.
function processNewChatTags(html) {
  return html.replace(/<new-chat\b[^>]*\/>/gi, '');
}

// Process copy tags
function processCopyTags(html) {
  const copyMatches = html.match(/<copy>([\s\S]*?)<\/copy>/g);
  if (copyMatches) {
    copyMatches.forEach((match, index) => {
      const innerContent = match.match(/<copy>([\s\S]*?)<\/copy>/)[1];
      const copyId = `copy-${Date.now()}-${index}`;

      // Extract plain text for copying (strip HTML tags and markdown)
      const plainText = innerContent.replace(/<[^>]*>/g, '').replace(/\*\*/g, '');

      // Check if content is multi-line (only for actual line breaks, not just long text)
      const isMultiLine = plainText.includes('\n');

      let copyHtml;
      if (isMultiLine) {
        // Multi-line content - render as a pane
        let displayContent = innerContent;
        // Convert markdown-style lists to bullet points
        displayContent = displayContent.replace(/^-\s+(.+)$/gm, '• $1');
        // Preserve the plain text for copying
        const escapedContent = plainText.replace(/'/g, "\\'").replace(/\n/g, "\\n");
        copyHtml = `<div class="copy-pane"><div class="copy-pane-content">${displayContent}</div><button class="copy-pane-button" onclick="copyToClipboard('${escapedContent}', '${copyId}')" id="${copyId}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg><span>Copy</span></button></div>`;
      } else {
        // Single-line content - render inline
        copyHtml = `<span class="copy-inline-wrapper">${innerContent}<button class="copy-inline-button" onclick="copyToClipboard('${plainText.replace(/'/g, "\\'")}', '${copyId}')" id="${copyId}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg><span>Copy</span></button></span>`;
      }

      html = html.replace(match, copyHtml);
    });
  }
  return html;
}

// Process color tags - uses CSS classes for theme support
function processColorTags(html) {
  html = html.replace(/<CYAN>([\s\S]*?)<\/CYAN>/g, '<span class="gs-md-cyan">$1</span>');
  html = html.replace(/<GREEN>([\s\S]*?)<\/GREEN>/g, '<span class="gs-md-green">$1</span>');
  html = html.replace(/<YELLOW>([\s\S]*?)<\/YELLOW>/g, '<span class="gs-md-yellow">$1</span>');
  html = html.replace(/<BLUE>([\s\S]*?)<\/BLUE>/g, '<span class="gs-md-blue">$1</span>');
  html = html.replace(/<RED>([\s\S]*?)<\/RED>/g, '<span class="gs-md-red">$1</span>');
  return html;
}

// Process user-input tags
function processUserInputTags(html, envVars) {
  const inputMatches = html.match(/<user-input[^>]+\/>/g);
  if (inputMatches) {
    inputMatches.forEach(match => {
      const varNameRaw = match.match(/var="([^"]+)"/)[1];
      const prompt = match.match(/prompt="([^"]+)"/)[1];
      const validate = match.match(/validate="([^"]+)"/)?.[1] || '';
      const error = match.match(/error="([^"]+)"/)?.[1] || 'Invalid input';
      const placeholderAttr = match.match(/placeholder="([^"]+)"/);
      const placeholder = placeholderAttr ? placeholderAttr[1] : `Enter ${prompt.toLowerCase().replace(/:$/, '')}`;

      // Handle comma-separated var names (use first one for ID)
      const varNames = varNameRaw.split(',').map(v => v.trim());
      const primaryVarName = varNames[0];

      // Check if existing value exists
      const existingValue = envVars[primaryVarName] || '';

      const inputHtml = `
        <div class="input-group">
          <label class="input-label" for="input-${primaryVarName}">${prompt}</label>
          <input type="text"
                 class="input-field"
                 id="input-${primaryVarName}"
                 data-var="${varNameRaw}"
                 data-validate="${validate}"
                 data-error="${error}"
                 value="${existingValue}"
                 placeholder="${placeholder}">
          <div class="input-error" id="error-${primaryVarName}">${error}</div>
        </div>
      `;

      html = html.replace(match, inputHtml);
    });
  }
  return html;
}

// Convert markdown headings to HTML
function processMarkdownHeadings(html) {
  html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');
  return html;
}

// Convert markdown formatting to HTML
function processMarkdownFormatting(html) {
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return html;
}

// Process numbered lists
function processNumberedLists(html) {
  // Handle indented numbered lists (preserve the indentation)
  html = html.replace(/^(\s{4,})(\d+\.)\s(.+)$/gm, (match, indent, num, text) => {
    const indentLevel = Math.floor(indent.length / 4);
    return `<div style="margin-left: ${indentLevel * 26}px; margin-bottom: 6px; line-height: 1.6;">${num} ${text}</div>`;
  });

  // Handle regular numbered lists
  html = html.replace(/^(\d+\.)\s(.+)$/gm, '<div style="margin-bottom: 6px; line-height: 1.55;">$1 $2</div>');

  return html;
}

// Process bullet lists
function processBulletLists(html) {
  html = html.replace(/^\s*[-*]\s+(.+)$/gm, '<div style="margin-left: 18px; margin-bottom: 6px; line-height: 1.5;">• $1</div>');
  return html;
}

// Process paragraphs
function processParagraphs(html) {
  const sections = html.split(/\n\n+/);
  html = sections.map(section => {
    section = section.trim();
    if (!section) return '';

    // Check if this section starts with a block element
    const blockElements = /^(<h[123]>|<div|<p>|<ul>|<ol>|<button)/i;
    if (blockElements.test(section)) {
      return section;
    }

    // Only wrap plain text in paragraphs
    if (section && !section.includes('<div') && !section.includes('<h')) {
      return `<p>${section}</p>`;
    }
    return section;
  }).filter(s => s).join('\n\n');

  return html;
}

// Generate confirmation card HTML
function generateConfirmationCard(message, confirmationId, context) {
  const cannedMessage = context === 'server-config'
    ? "Clicking 'No' will skip the rest of this server's configuration.<br>You can re-launch this setup wizard at any time to complete your configuration later."
    : "You can re-launch this setup wizard at any time to complete your configuration later.";

  return `
    <div class="confirmation-card" id="${confirmationId}" data-guidance-target="confirmation">
      <div class="confirmation-message">${message}</div>
      <div class="confirmation-canned-message">${cannedMessage}</div>
      <div class="confirmation-buttons">
        <button class="btn btn-confirm-yes" type="button" onclick="handleConfirmationYes('${confirmationId}', '${context}')">
          <span class="confirmation-button-icon" aria-hidden="true">✓</span>
          <span>Yes</span>
        </button>
        <button class="btn btn-confirm-no" type="button" onclick="handleConfirmationNo('${confirmationId}', '${context}')">
          <span class="confirmation-button-icon" aria-hidden="true">✕</span>
          <span>No</span>
        </button>
      </div>
    </div>
  `;
}

// Process confirmation blocks
function processConfirmationBlocks(html, context) {
  const confirmationMatches = html.match(/<confirmation[^>]+\/>/g);
  let confirmationIndex = 0;

  if (confirmationMatches) {
    confirmationMatches.forEach(match => {
      const message = match.match(/message="([^"]+)"/)[1];
      const confirmationId = `confirmation-${Date.now()}-${confirmationIndex++}`;

      const confirmationHtml = generateConfirmationCard(message, confirmationId, context);

      // Split content at confirmation point
      const confirmationPosition = html.indexOf(match);
      const beforeConfirmation = html.substring(0, confirmationPosition);
      const afterConfirmation = html.substring(confirmationPosition + match.length);

      // Wrap content after confirmation in a hideable div
      html = beforeConfirmation + confirmationHtml +
             `<div class="content-after-confirmation" id="after-${confirmationId}">${afterConfirmation}</div>`;
    });
  }

  return html;
}

// Clean up success messages
function cleanSuccessMessages(html) {
  return html.replace(/<success[^>]*\/>/g, '');
}

// Main function to parse setup markdown
function parseMarkdownContent(content, envVars, context = 'server-config') {
  let html = content;

  // Substitute user variables first
  html = substituteVariables(html, envVars);

  // Process browser-open tags
  html = processBrowserOpenTags(html);

  // Remove runtime-only new-chat controls
  html = processNewChatTags(html);

  // Process copy tags before color tags
  html = processCopyTags(html);

  // Process color tags
  html = processColorTags(html);

  // Process user-input tags
  html = processUserInputTags(html, envVars);

  // Process markdown headings
  html = processMarkdownHeadings(html);

  // Process markdown formatting
  html = processMarkdownFormatting(html);

  // Process numbered lists
  html = processNumberedLists(html);

  // Process bullet lists
  html = processBulletLists(html);

  // Process paragraphs
  html = processParagraphs(html);

  // Process confirmation blocks
  html = processConfirmationBlocks(html, context);

  // Clean up success messages
  html = cleanSuccessMessages(html);

  return html;
}

// Export functions
module.exports = {
  substituteVariables,
  processBrowserOpenTags,
  processNewChatTags,
  processCopyTags,
  processColorTags,
  processUserInputTags,
  processMarkdownHeadings,
  processMarkdownFormatting,
  processNumberedLists,
  processBulletLists,
  processParagraphs,
  generateConfirmationCard,
  processConfirmationBlocks,
  cleanSuccessMessages,
  parseMarkdownContent
};
