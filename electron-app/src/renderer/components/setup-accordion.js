const { scheduleExpandedAccordionVisibility } = require('./accordion-visibility');

// Accordion component for guided setup
// Extracted from guided-setup.js

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

// Create initial accordions from HTML content, respecting confirmation boundaries
function createInitialAccordions(html, context) {
  console.log('[createInitialAccordions] Processing content for:', context);

  // Split HTML into lines to process
  const lines = html.split('\n');
  const result = [];
  let currentAccordion = null;
  let accordionIndex = 0;
  let insideHiddenContent = false;
  let hiddenContentDepth = 0;

  lines.forEach(line => {
    const trimmedLine = line.trim();

    // Track when we're inside content-after-confirmation divs
    if (trimmedLine.includes('class="content-after-confirmation"')) {
      insideHiddenContent = true;
      hiddenContentDepth = 1;
      result.push(line); // Keep the div as-is
      return;
    }

    // Track nested divs inside hidden content
    if (insideHiddenContent) {
      if (trimmedLine.startsWith('<div')) {
        hiddenContentDepth++;
      } else if (trimmedLine.startsWith('</div>')) {
        hiddenContentDepth--;
        if (hiddenContentDepth === 0) {
          insideHiddenContent = false;
        }
      }
      result.push(line); // Keep hidden content as-is, don't process into accordions
      return;
    }

    if (trimmedLine.match(/^<h2>/)) {
      // Start new accordion for H2 header (only if not inside hidden content)
      if (currentAccordion) {
        // Close previous accordion
        result.push('    </div>');
        result.push('  </div>');
      }

      // Extract title from H2 tag
      const title = trimmedLine.replace(/<\/?h2[^>]*>/g, '');
      const accordionId = `accordion-initial-${context}-${accordionIndex++}`;

      // Start new accordion (expanded by default)
      result.push(`  <div class="accordion-section" id="${accordionId}">`);
      result.push(`    <div class="accordion-header" onclick="toggleAccordion('${accordionId}')">`);
      result.push(`      <div class="accordion-title">${title}</div>`);
      result.push(`      <div class="accordion-toggle">▼</div>`);
      result.push(`    </div>`);
      result.push(`    <div class="accordion-content">`);

      currentAccordion = { id: accordionId, title };

      // Skip adding the H2 line to accordion content since we already have the title in the header
    } else if (trimmedLine.match(/^<h1>/)) {
      // H1 headers stay outside accordions
      if (currentAccordion) {
        // Close current accordion
        result.push('    </div>');
        result.push('  </div>');
        currentAccordion = null;
      }
      result.push(line);
    } else if (currentAccordion) {
      // Content inside accordion
      result.push(`      ${line}`);
    } else {
      // Content outside accordions
      result.push(line);
    }
  });

  // Close final accordion if exists
  if (currentAccordion) {
    result.push('    </div>');
    result.push('  </div>');
  }

  const processedHtml = result.join('\n');
  console.log('[createInitialAccordions] Created', accordionIndex, 'visible accordions');
  return processedHtml;
}

// Mark accordion containing confirmation as completed and collapse it
function markAccordionsAsCompleted(confirmationId) {
  const confirmationCard = document.getElementById(confirmationId);
  if (!confirmationCard) return;

  console.log('[markAccordionsAsCompleted] Processing accordion containing:', confirmationId);

  // Find the accordion that contains this confirmation
  const containingAccordion = confirmationCard.closest('.accordion-section');
  if (containingAccordion) {
    // Mark as completed and collapse
    containingAccordion.classList.add('completed');
    containingAccordion.classList.add('collapsed');
    console.log('[markAccordionsAsCompleted] Marked accordion as completed:', containingAccordion.id);
  } else {
    console.log('[markAccordionsAsCompleted] No containing accordion found for confirmation');
  }
}

// Create accordion section HTML
function createAccordionSection(title, elements, accordionId) {
  return `
    <div class="accordion-section collapsed" id="${accordionId}">
      <div class="accordion-header" onclick="toggleAccordion('${accordionId}')">
        <div class="accordion-title">${title}</div>
        <div class="accordion-toggle">▼</div>
      </div>
      <div class="accordion-content">
      </div>
    </div>
  `;
}

// Toggle accordion expand/collapse
function toggleAccordion(accordionId) {
  const accordion = document.getElementById(accordionId);
  if (!accordion) return null;

  accordion.classList.toggle('collapsed');

  const isCollapsed = accordion.classList.contains('collapsed');
  console.log('[toggleAccordion]', accordionId, isCollapsed ? 'collapsed' : 'expanded');
  return isCollapsed;
}

// Create accordions for visible content in the specified container
function createAccordionsForVisibleContent(container, context, options = {}) {
  console.log('[createAccordionsForVisibleContent] Processing visible content for:', context);
  const startCollapsed = options.startCollapsed === true;
  const autoExpandFirst = options.autoExpandFirst === true;
  const onToggle = typeof options.onToggle === 'function' ? options.onToggle : null;
  const scrollOnExpand = options.scrollOnExpand !== false;

  // Find all H2 elements within the specified container
  const allH2s = container.querySelectorAll('h2');
  let accordionIndex = 0;
  const createdAccordions = [];

  allH2s.forEach(h2 => {
    // Skip if this H2 is already inside an accordion
    if (h2.closest('.accordion-section')) {
      console.log('[createAccordionsForVisibleContent] Skipping H2 already in accordion:', h2.textContent);
      return;
    }

    // Hidden follow-up confirmation branches are processed only when their
    // specific content-after-confirmation container is revealed.
    const containingDeferredContent = findClosestAncestorWithClass(h2, 'content-after-confirmation');
    if (containingDeferredContent && containingDeferredContent !== container) {
      console.log('[createAccordionsForVisibleContent] Skipping H2 inside hidden follow-up content:', h2.textContent);
      return;
    }

    console.log('[createAccordionsForVisibleContent] Processing visible H2:', h2.textContent);

    // Create accordion for this H2 and its following content
    const accordionId = `accordion-visible-${context}-${accordionIndex++}`;
    const title = h2.textContent || h2.innerHTML;

    // Create accordion wrapper
    const accordion = document.createElement('div');
    accordion.className = `accordion-section${startCollapsed ? ' collapsed' : ''}`;
    accordion.id = accordionId;

    // Create accordion header
    const header = document.createElement('div');
    header.className = 'accordion-header';
    header.onclick = () => {
      const isCollapsed = toggleAccordion(accordionId);
      if (onToggle) {
        onToggle({
          accordionId,
          accordion,
          context,
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
      <div class="accordion-title">${title}</div>
      <div class="accordion-toggle">▼</div>
    `;

    // Create accordion content
    const content = document.createElement('div');
    content.className = 'accordion-content';

    // Insert accordion before the H2
    h2.parentNode.insertBefore(accordion, h2);
    accordion.appendChild(header);
    accordion.appendChild(content);
    createdAccordions.push({ accordion, header });

    // Move elements after H2 into accordion content until we hit another H2 or boundary
    let currentElement = h2.nextSibling;
    const elementsToMove = [];

    while (currentElement) {
      const nextElement = currentElement.nextSibling;

      // Stop if we hit another H2 or H1
      if (currentElement.nodeType === Node.ELEMENT_NODE) {
        if (currentElement.tagName === 'H2' || currentElement.tagName === 'H1') {
          break;
        }

        // Stop if we hit a content-after-confirmation div
        if (currentElement.classList && currentElement.classList.contains('content-after-confirmation')) {
          break;
        }
      }

      elementsToMove.push(currentElement);
      currentElement = nextElement;
    }

    // Move elements into accordion content
    elementsToMove.forEach(el => {
      content.appendChild(el);
    });

    // Remove the original H2 since we don't want it duplicated
    h2.remove();

    console.log('[createAccordionsForVisibleContent] Created accordion:', accordionId, 'with', elementsToMove.length, 'elements');
  });

  if (autoExpandFirst && startCollapsed && createdAccordions.length > 0) {
    const firstAccordion = createdAccordions[0];
    if (firstAccordion.accordion.classList.contains('collapsed')) {
      firstAccordion.header.onclick();
    }
  }

  return createdAccordions;
}

// Export functions
module.exports = {
  createInitialAccordions,
  markAccordionsAsCompleted,
  createAccordionSection,
  toggleAccordion,
  createAccordionsForVisibleContent
};

// Also expose to window for onclick handlers
if (typeof window !== 'undefined') {
  window.createInitialAccordions = createInitialAccordions;
  window.markAccordionsAsCompleted = markAccordionsAsCompleted;
  window.createAccordionSection = createAccordionSection;
  window.toggleAccordion = toggleAccordion;
  window.createAccordionsForVisibleContent = createAccordionsForVisibleContent;
}
