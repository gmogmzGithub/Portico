/**
 * XML utilities for parsing and prettifying Portico context XML
 */

/**
 * Check if content starts with <portico_context>
 */
export function isPorticoContextXml(content: string): boolean {
  return content.trimStart().startsWith('<portico_context>');
}

/**
 * Prettify XML with proper indentation
 * Handles potentially malformed XML gracefully
 */
export function prettifyXml(xml: string, indent: string = '  '): string {
  // Remove existing whitespace between tags
  let formatted = xml.replace(/>\s*</g, '><');

  // Track nesting level
  let level = 0;
  let result = '';
  let i = 0;

  while (i < formatted.length) {
    // Find the next tag
    const tagStart = formatted.indexOf('<', i);

    if (tagStart === -1) {
      // No more tags, add remaining text
      const text = formatted.slice(i).trim();
      if (text) {
        result += indent.repeat(level) + text + '\n';
      }
      break;
    }

    // Add any text before the tag
    if (tagStart > i) {
      const text = formatted.slice(i, tagStart).trim();
      if (text) {
        result += indent.repeat(level) + text + '\n';
      }
    }

    // Find the end of the tag
    const tagEnd = formatted.indexOf('>', tagStart);
    if (tagEnd === -1) {
      // Malformed XML - add rest and break
      result += formatted.slice(tagStart);
      break;
    }

    const tag = formatted.slice(tagStart, tagEnd + 1);

    // Determine tag type
    const isClosingTag = tag.startsWith('</');
    const isSelfClosing = tag.endsWith('/>');
    const isComment = tag.startsWith('<!--');
    const isDeclaration = tag.startsWith('<?') || tag.startsWith('<!');

    if (isClosingTag) {
      level = Math.max(0, level - 1);
      result += indent.repeat(level) + tag + '\n';
    } else if (isSelfClosing || isComment || isDeclaration) {
      result += indent.repeat(level) + tag + '\n';
    } else {
      result += indent.repeat(level) + tag + '\n';
      level++;
    }

    i = tagEnd + 1;
  }

  return result.trim();
}

/**
 * Token types for XML syntax highlighting
 */
export type XmlTokenType =
  | 'tag-bracket'      // < > </ />
  | 'tag-name'         // element names
  | 'attribute-name'   // attribute names
  | 'attribute-value'  // attribute values (in quotes)
  | 'text'             // text content
  | 'comment'          // <!-- -->
  | 'equals'           // =
  | 'quote';           // " or '

export interface XmlToken {
  type: XmlTokenType;
  value: string;
}

/**
 * Tokenize XML for syntax highlighting
 * Returns an array of tokens with their types
 */
export function tokenizeXml(xml: string): XmlToken[] {
  const tokens: XmlToken[] = [];
  let i = 0;

  while (i < xml.length) {
    // Check for comment
    if (xml.slice(i, i + 4) === '<!--') {
      const commentEnd = xml.indexOf('-->', i);
      const end = commentEnd === -1 ? xml.length : commentEnd + 3;
      tokens.push({ type: 'comment', value: xml.slice(i, end) });
      i = end;
      continue;
    }

    // Check for tag start
    if (xml[i] === '<') {
      // Opening bracket
      if (xml[i + 1] === '/') {
        tokens.push({ type: 'tag-bracket', value: '</' });
        i += 2;
      } else {
        tokens.push({ type: 'tag-bracket', value: '<' });
        i += 1;
      }

      // Parse tag name
      let tagName = '';
      while (i < xml.length && /[a-zA-Z0-9_:-]/.test(xml[i])) {
        tagName += xml[i];
        i++;
      }
      if (tagName) {
        tokens.push({ type: 'tag-name', value: tagName });
      }

      // Parse attributes until we hit > or />
      while (i < xml.length && xml[i] !== '>' && !(xml[i] === '/' && xml[i + 1] === '>')) {
        // Capture whitespace between attributes (preserve spacing)
        if (/\s/.test(xml[i])) {
          let whitespace = '';
          while (i < xml.length && /\s/.test(xml[i])) {
            whitespace += xml[i];
            i++;
          }
          // Add space token if there's more content coming (not at end of tag)
          if (i < xml.length && xml[i] !== '>' && !(xml[i] === '/' && xml[i + 1] === '>')) {
            tokens.push({ type: 'text', value: ' ' }); // Normalize to single space
          }
          continue;
        }

        // Parse attribute name
        let attrName = '';
        while (i < xml.length && /[a-zA-Z0-9_:-]/.test(xml[i])) {
          attrName += xml[i];
          i++;
        }
        if (attrName) {
          tokens.push({ type: 'attribute-name', value: attrName });
        }

        // Skip whitespace
        while (i < xml.length && /\s/.test(xml[i])) i++;

        // Check for =
        if (xml[i] === '=') {
          tokens.push({ type: 'equals', value: '=' });
          i++;

          // Skip whitespace
          while (i < xml.length && /\s/.test(xml[i])) i++;

          // Parse attribute value
          const quote = xml[i];
          if (quote === '"' || quote === "'") {
            tokens.push({ type: 'quote', value: quote });
            i++;

            let attrValue = '';
            while (i < xml.length && xml[i] !== quote) {
              attrValue += xml[i];
              i++;
            }
            if (attrValue) {
              tokens.push({ type: 'attribute-value', value: attrValue });
            }

            if (xml[i] === quote) {
              tokens.push({ type: 'quote', value: quote });
              i++;
            }
          }
        }
      }

      // Closing bracket
      if (xml[i] === '/' && xml[i + 1] === '>') {
        tokens.push({ type: 'tag-bracket', value: '/>' });
        i += 2;
      } else if (xml[i] === '>') {
        tokens.push({ type: 'tag-bracket', value: '>' });
        i++;
      }
      continue;
    }

    // Text content
    let text = '';
    while (i < xml.length && xml[i] !== '<') {
      text += xml[i];
      i++;
    }
    if (text) {
      // Preserve whitespace structure but trim each line for display
      tokens.push({ type: 'text', value: text });
    }
  }

  return tokens;
}
