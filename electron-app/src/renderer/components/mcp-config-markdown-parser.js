// Markdown parsing for MCP config modal
// Browser-compatible version adapted from setup-markdown-parser.js

(function(root) {
  'use strict';

  const accordionVisibilityApi =
    root?.AccordionVisibility ||
    (typeof require === 'function' ? require('./accordion-visibility') : null) ||
    {};
  const scheduleExpandedAccordionVisibility =
    accordionVisibilityApi.scheduleExpandedAccordionVisibility ||
    function noopScheduleExpandedAccordionVisibility() {
      return null;
    };

  // Substitute user variables in markdown content
  function substituteVariables(html, envVars) {
    const userLdap = envVars['PORTICO_USER_ID'] || '[your-ldap]';
    const userName = envVars['PORTICO_USER_NAME'] || '[your-name]';

    html = html.replace(/<USER_LDAP\/>/g, userLdap);
    html = html.replace(/<USER_NAME\/>/g, userName);

    return html;
  }

  // Process browser-open tags - always opens externally in config modal
  function processBrowserOpenTags(html) {
    const browserMatches = html.match(/<browser-open[^>]*url="([^"]+)"[^>]*\/>/g);
    if (browserMatches) {
      browserMatches.forEach(match => {
        const url = match.match(/url="([^"]+)"/)[1];
        // Always use single button that opens externally
        const buttonHtml = `
          <div class="mcp-config-browser-buttons">
            <button type="button" class="mcp-config-open-browser-btn" data-url="${url}">
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

  function getTagAttribute(tag, attributeName) {
    const escapedName = String(attributeName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rawValue =
      tag.match(new RegExp(`\\s${escapedName}\\s*=\\s*"([^"]*)"`, 'i'))?.[1] || '';
    return rawValue
      .replace(/&quot;/gi, '"')
      .replace(/&apos;/gi, "'")
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&amp;/gi, '&');
  }

  function getActionableNewChatControl(tag) {
    const prompt = getTagAttribute(tag, 'prompt').trim();
    if (!prompt) {
      return null;
    }

    return {
      prompt,
      label: getTagAttribute(tag, 'label').trim() || 'Open new chat',
    };
  }

  function hasActionableNewChatControl(content, envVars = {}) {
    if (typeof content !== 'string') {
      return false;
    }

    const substitutedContent = substituteVariables(content, envVars || {});
    const tags = substitutedContent.match(/<new-chat\b[^>]*\/>/gi) || [];
    return tags.some(tag => getActionableNewChatControl(tag) !== null);
  }

  // Process runtime-only new-chat controls. A prompt is required because the
  // explicit click is also the user's consent to submit that first turn.
  function processNewChatTags(html) {
    return html.replace(/<new-chat\b[^>]*\/>/gi, (tag) => {
      const control = getActionableNewChatControl(tag);
      if (!control) {
        return '';
      }
      return `
        <div class="mcp-config-new-chat-buttons">
          <button type="button" class="mcp-config-new-chat-btn" data-chat-prompt="${escapeHtml(control.prompt)}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z"></path>
              <path d="M12 7v6"></path>
              <path d="M9 10h6"></path>
            </svg>
            ${escapeHtml(control.label)}
          </button>
        </div>
      `;
    });
  }

  // Process copy tags
  function processCopyTags(html) {
    const copyMatches = html.match(/<copy>([\s\S]*?)<\/copy>/g);
    if (copyMatches) {
      copyMatches.forEach((match, index) => {
        const innerContent = match.match(/<copy>([\s\S]*?)<\/copy>/)[1];
        const copyId = `mcp-config-copy-${Date.now()}-${index}`;

        // Extract plain text for copying (strip HTML tags and markdown)
        const plainText = innerContent.replace(/<[^>]*>/g, '').replace(/\*\*/g, '').trim();

        // Check if content is multi-line
        const isMultiLine = plainText.includes('\n');

        // Escape for data attribute
        const escapedForAttr = plainText.replace(/"/g, '&quot;').replace(/\n/g, '&#10;');

        let copyHtml;
        if (isMultiLine) {
          let displayContent = innerContent;
          displayContent = displayContent.replace(/^-\s+(.+)$/gm, '&#8226; $1');
          copyHtml = `<div class="mcp-config-copy-pane"><div class="mcp-config-copy-pane-content">${displayContent}</div><button type="button" class="mcp-config-copy-btn" data-copy-text="${escapedForAttr}" id="${copyId}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>Copy</button></div>`;
        } else {
          copyHtml = `<span class="mcp-config-copy-inline">${innerContent}<button type="button" class="mcp-config-copy-btn" data-copy-text="${escapedForAttr}" id="${copyId}"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>Copy</button></span>`;
        }

        html = html.replace(match, copyHtml);
      });
    }
    return html;
  }

  // Process color tags - uses CSS classes for theme support
  function processColorTags(html) {
    html = html.replace(/<CYAN>([\s\S]*?)<\/CYAN>/g, '<span class="mcp-md-cyan">$1</span>');
    html = html.replace(/<GREEN>([\s\S]*?)<\/GREEN>/g, '<span class="mcp-md-green">$1</span>');
    html = html.replace(/<YELLOW>([\s\S]*?)<\/YELLOW>/g, '<span class="mcp-md-yellow">$1</span>');
    html = html.replace(/<BLUE>([\s\S]*?)<\/BLUE>/g, '<span class="mcp-md-blue">$1</span>');
    html = html.replace(/<RED>([\s\S]*?)<\/RED>/g, '<span class="mcp-md-red">$1</span>');
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

        const varNames = varNameRaw.split(',').map(v => v.trim());
        const primaryVarName = varNames[0];

        const existingValue = envVars[primaryVarName] || '';

        // Determine if field should be password type (sensitive vars)
        const sensitiveVars = ['TOKEN', 'SECRET', 'KEY', 'PASSWORD', 'API_KEY', 'XOXP', 'XOXC', 'XOXD'];
        const isSensitive = sensitiveVars.some(sv => primaryVarName.toUpperCase().includes(sv));
        const inputType = isSensitive ? 'password' : 'text';

        const inputHtml = `
          <div class="input-group">
            <label class="input-label" for="input-${primaryVarName}">${prompt}</label>
            <input type="${inputType}"
                   class="input-field"
                   id="input-${primaryVarName}"
                   data-var="${varNameRaw}"
                   data-validate="${validate}"
                   data-error="${error}"
                   value="${escapeHtml(existingValue)}"
                   placeholder="${placeholder}">
            <div class="input-error" id="error-${primaryVarName}">${error}</div>
          </div>
        `;

        html = html.replace(match, inputHtml);
      });
    }
    return html;
  }

  // Process markdown headings
  function processMarkdownHeadings(html) {
    html = html.replace(/^###\s+(.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^##\s+(.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^#\s+(.+)$/gm, '<h1>$1</h1>');
    return html;
  }

  // Process markdown formatting
  function processMarkdownFormatting(html) {
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    return html;
  }

  // Process numbered lists
  function processNumberedLists(html) {
    html = html.replace(/^(\s{4,})(\d+\.)\s(.+)$/gm, (match, indent, num, text) => {
      const indentLevel = Math.floor(indent.length / 4);
      return `<div style="margin-left: ${indentLevel * 30}px; margin-bottom: 8px; line-height: 1.8;">${num} ${text}</div>`;
    });

    html = html.replace(/^(\d+\.)\s(.+)$/gm, '<div style="margin-bottom: 8px;">$1 $2</div>');

    return html;
  }

  // Process bullet lists
  function processBulletLists(html) {
    html = html.replace(/^\s*[-*]\s+(.+)$/gm, '<div style="margin-left: 20px; margin-bottom: 8px;">&#8226; $1</div>');
    return html;
  }

  // Process paragraphs
  function processParagraphs(html) {
    const sections = html.split(/\n\n+/);
    html = sections.map(section => {
      section = section.trim();
      if (!section) return '';

      const blockElements = /^(<h[123]>|<div|<p>|<ul>|<ol>|<button)/i;
      if (blockElements.test(section)) {
        return section;
      }

      if (section && !section.includes('<div') && !section.includes('<h')) {
        return `<p>${section}</p>`;
      }
      return section;
    }).filter(s => s).join('\n\n');

    return html;
  }

  // Generate confirmation card HTML
  function generateConfirmationCard(message, confirmationId) {
    return `
      <div class="mcp-config-confirmation-card" id="${confirmationId}" data-guidance-target="confirmation">
        <div class="mcp-config-confirmation-message">${message}</div>
        <div class="mcp-config-confirmation-canned-message">
          Clicking 'No' will skip the rest of this server's configuration.<br>You can reopen this configuration from Control Plane later.
        </div>
        <div class="mcp-config-confirmation-buttons">
          <button class="btn btn-confirm-yes" type="button">
            <span class="mcp-config-confirmation-button-icon" aria-hidden="true">✓</span>
            <span>Yes</span>
          </button>
          <button class="btn btn-confirm-no" type="button">
            <span class="mcp-config-confirmation-button-icon" aria-hidden="true">✕</span>
            <span>No</span>
          </button>
        </div>
      </div>
    `;
  }

  // Process confirmation blocks
  function processConfirmationBlocks(html) {
    const confirmationMatches = html.match(/<confirmation[^>]+\/>/g);
    let confirmationIndex = 0;

    if (confirmationMatches) {
      confirmationMatches.forEach(match => {
        const message = match.match(/message="([^"]+)"/)[1];
        const confirmationId = `mcp-config-confirmation-${Date.now()}-${confirmationIndex++}`;

        const confirmationHtml = generateConfirmationCard(message, confirmationId);

        const confirmationPosition = html.indexOf(match);
        const beforeConfirmation = html.substring(0, confirmationPosition);
        const afterConfirmation = html.substring(confirmationPosition + match.length);

        html = beforeConfirmation + confirmationHtml +
               `<div class="mcp-config-content-after-confirmation" id="after-${confirmationId}">${afterConfirmation}</div>`;
      });
    }

    return html;
  }

  // Process cleanup-vars tags (just remove them - they're handled separately)
  function processCleanupVars(html) {
    return html.replace(/<cleanup-vars[^>]*\/>/g, '');
  }

  // Clean up success messages
  function cleanSuccessMessages(html) {
    return html.replace(/<success[^>]*\/>/g, '');
  }

  // Escape HTML special characters
  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;')
              .replace(/'/g, '&#039;');
  }

  // Toggle accordion expand/collapse
  function mcpConfigToggleAccordion(accordionId) {
    const accordion = document.getElementById(accordionId);
    if (!accordion) return null;

    accordion.classList.toggle('collapsed');
    return accordion.classList.contains('collapsed');
  }

  function findClosestAncestorWithClass(node, className) {
    let current = node?.parentElement || node?.parentNode || null;

    while (current) {
      if (current.classList?.contains?.(className)) {
        return current;
      }
      current = current.parentElement || current.parentNode || null;
    }

    return null;
  }

  // Create accordions for H2 elements in MCP config modal
  function createAccordionsForMcpConfig(container, options = {}) {
    if (!container) return [];
    const startCollapsed = options.startCollapsed !== false;
    const autoExpandFirst = options.autoExpandFirst === true;
    const onToggle = typeof options.onToggle === 'function' ? options.onToggle : null;
    const scrollOnExpand = options.scrollOnExpand !== false;

    const allH2s = container.querySelectorAll('h2');
    let accordionIndex = 0;
    const createdAccordions = [];

    allH2s.forEach(h2 => {
      // Skip if already in accordion
      if (h2.closest('.mcp-config-accordion')) return;

      const containingDeferredContent = findClosestAncestorWithClass(h2, 'mcp-config-content-after-confirmation');
      if (containingDeferredContent && containingDeferredContent !== container) return;

      const accordionId = `mcp-config-accordion-${Date.now()}-${accordionIndex++}`;
      const title = h2.textContent || h2.innerHTML;

      // Create accordion wrapper
      const accordion = document.createElement('div');
      accordion.className = `mcp-config-accordion${startCollapsed ? ' collapsed' : ''}`;
      accordion.id = accordionId;

      // Create header
      const header = document.createElement('div');
      header.className = 'mcp-config-accordion-header';
      header.onclick = () => {
        const isCollapsed = mcpConfigToggleAccordion(accordionId);
        if (onToggle) {
          onToggle({
            accordionId,
            accordion,
            context: options.context || 'mcp-config',
            isCollapsed,
          });
        }
        if (!isCollapsed && scrollOnExpand) {
          scheduleExpandedAccordionVisibility(accordion, {
            scrollContainer: options.scrollContainer,
            topPadding: options.scrollTopPadding,
            bottomPadding: options.scrollBottomPadding,
            behavior: options.scrollBehavior,
            schedule: options.scrollSchedule,
          });
        }
      };
      header.innerHTML = `
        <div class="mcp-config-accordion-title">${title}</div>
        <div class="mcp-config-accordion-toggle">▼</div>
      `;

      // Create content
      const content = document.createElement('div');
      content.className = 'mcp-config-accordion-content';

      // Insert accordion before H2
      h2.parentNode.insertBefore(accordion, h2);
      accordion.appendChild(header);
      accordion.appendChild(content);
      createdAccordions.push({ accordion, header });

      // Move elements after H2 into accordion content until boundary
      let currentElement = h2.nextSibling;
      const elementsToMove = [];

      while (currentElement) {
        const nextElement = currentElement.nextSibling;

        if (currentElement.nodeType === Node.ELEMENT_NODE) {
          if (currentElement.tagName === 'H2' || currentElement.tagName === 'H1') break;
          if (currentElement.classList && currentElement.classList.contains('mcp-config-content-after-confirmation')) break;
        }

        elementsToMove.push(currentElement);
        currentElement = nextElement;
      }

      elementsToMove.forEach(el => content.appendChild(el));
      h2.remove();
    });

    if (autoExpandFirst && startCollapsed && createdAccordions.length > 0) {
      const firstAccordion = createdAccordions[0];
      if (firstAccordion.accordion.classList.contains('collapsed')) {
        firstAccordion.header.onclick();
      }
    }

    return createdAccordions;
  }

  // Main function to parse setup markdown
  function parseMarkdownContent(content, envVars) {
    let html = content;

    // Substitute user variables first
    html = substituteVariables(html, envVars);

    // Process browser-open tags
    html = processBrowserOpenTags(html);

    // Process new-chat tags
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
    html = processConfirmationBlocks(html);

    // Process cleanup-vars tags
    html = processCleanupVars(html);

    // Clean up success messages
    html = cleanSuccessMessages(html);

    return html;
  }

  // Copy to clipboard handler - uses Electron IPC for proper permissions
  async function mcpConfigCopyToClipboard(text, buttonId) {
    try {
      // Use Electron's clipboard API via IPC (has proper permissions)
      if (window.electronAPI && window.electronAPI.copyToClipboard) {
        await window.electronAPI.copyToClipboard(text);
      } else {
        // Fallback for non-Electron context
        await navigator.clipboard.writeText(text);
      }

      // Update button to show success
      const btn = document.getElementById(buttonId);
      if (btn) {
        const originalHTML = btn.innerHTML;
        btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>Copied!';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.innerHTML = originalHTML;
          btn.classList.remove('copied');
        }, 2000);
      }
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }

  // Open external URL handler
  function mcpConfigOpenExternal(url) {
    if (window.electronAPI && window.electronAPI.openExternal) {
      window.electronAPI.openExternal(url);
    } else {
      window.open(url, '_blank');
    }
  }

  // Confirmation Yes handler
  function mcpConfigConfirmationYes(confirmationId, options = {}) {
    const card = document.getElementById(confirmationId);
    const afterContent = document.getElementById(`after-${confirmationId}`);

    // Find and mark containing accordion as completed and collapse it
    const containingAccordion = card ? card.closest('.mcp-config-accordion') : null;
    if (containingAccordion) {
      containingAccordion.classList.add('completed');
      containingAccordion.classList.add('collapsed');
    }

    if (card) {
      card.classList.add('confirmed');
      card.innerHTML = `
        <div class="mcp-config-confirmation-done">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="20 6 9 17 4 12"></polyline>
          </svg>
          Confirmed
        </div>
      `;
    }

    if (afterContent) {
      afterContent.classList.remove('hidden');
      afterContent.classList.add('visible');

      // Create accordions for newly visible content
      createAccordionsForMcpConfig(afterContent, {
        startCollapsed: true,
        autoExpandFirst: true,
        onToggle: options.onToggle,
        scrollContainer: options.scrollContainer,
        scrollTopPadding: options.scrollTopPadding,
        scrollBottomPadding: options.scrollBottomPadding,
        scrollBehavior: options.scrollBehavior,
        scrollSchedule: options.scrollSchedule,
        context: options.context || 'mcp-config',
      });
    }

    options.refreshGuidance?.();
  }

  // Confirmation No handler
  function mcpConfigConfirmationNo(confirmationId, options = {}) {
    const card = document.getElementById(confirmationId);
    const afterContent = document.getElementById(`after-${confirmationId}`);

    if (card) {
      card.classList.add('skipped');
      card.innerHTML = `
        <div class="mcp-config-confirmation-done skipped">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
          Skipped
        </div>
      `;
    }

    // Hide content after this confirmation
    if (afterContent) {
      afterContent.classList.remove('visible');
      afterContent.classList.add('hidden');
    }

    options.refreshGuidance?.();
  }

  // Attach event listeners to rendered content
  function attachEventListeners(container, options = {}) {
    if (!container) return;

    // Create accordions for H2 elements
    createAccordionsForMcpConfig(container, options);

    // Browser open buttons
    container.querySelectorAll('.mcp-config-open-browser-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const url = btn.dataset.url;
        if (url) {
          mcpConfigOpenExternal(url);
        }
      });
    });

    // New-chat buttons
    container.querySelectorAll('.mcp-config-new-chat-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const prompt = String(btn.dataset.chatPrompt || '').trim();
        if (!prompt || typeof options.openNewChat !== 'function' || btn.disabled) {
          return;
        }

        btn.disabled = true;
        try {
          await options.openNewChat(prompt);
        } finally {
          if (btn.isConnected !== false) {
            btn.disabled = false;
          }
        }
      });
    });

    // Copy buttons
    container.querySelectorAll('.mcp-config-copy-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const text = btn.dataset.copyText;
        if (text) {
          // Decode HTML entities
          const decoded = text.replace(/&#10;/g, '\n').replace(/&quot;/g, '"');
          mcpConfigCopyToClipboard(decoded, btn.id);
        }
      });
    });

    // Confirmation Yes buttons
    container.querySelectorAll('.btn-confirm-yes').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const card = btn.closest('.mcp-config-confirmation-card');
        if (card) {
          mcpConfigConfirmationYes(card.id, options);
        }
      });
    });

    // Confirmation No buttons
    container.querySelectorAll('.btn-confirm-no').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const card = btn.closest('.mcp-config-confirmation-card');
        if (card) {
          mcpConfigConfirmationNo(card.id, options);
        }
      });
    });
  }

  // Expose to window
  const api = {
    parseMarkdownContent,
    attachEventListeners,
    substituteVariables,
    hasActionableNewChatControl,
    processNewChatTags,
    escapeHtml,
    generateConfirmationCard,
    createAccordionsForMcpConfig,
    mcpConfigToggleAccordion,
    mcpConfigConfirmationYes,
    mcpConfigConfirmationNo,
  };
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  }
  if (typeof root !== 'undefined') {
    root.McpConfigMarkdownParser = api;

    // Expose handlers to window for onclick (backup)
    root.mcpConfigCopyToClipboard = mcpConfigCopyToClipboard;
    root.mcpConfigOpenExternal = mcpConfigOpenExternal;
    root.mcpConfigConfirmationYes = mcpConfigConfirmationYes;
    root.mcpConfigConfirmationNo = mcpConfigConfirmationNo;
    root.mcpConfigToggleAccordion = mcpConfigToggleAccordion;
    root.createAccordionsForMcpConfig = createAccordionsForMcpConfig;
  }

})(typeof globalThis !== 'undefined' ? globalThis : this);
