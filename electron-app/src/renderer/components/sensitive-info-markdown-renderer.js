const { lexer } = require("marked");

const SAFE_HTTP_PROTOCOLS = new Set(["http:", "https:"]);

function textNode(text) {
  return {
    type: "text",
    text: String(text || ""),
  };
}

function elementNode(tag, children = [], attributes = {}) {
  return {
    type: "element",
    tag,
    attributes,
    children: children.filter(Boolean),
  };
}

function normalizeSafeModalPreambleUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return null;
  }

  try {
    const parsed = new URL(raw);
    if (!SAFE_HTTP_PROTOCOLS.has(parsed.protocol)) {
      return null;
    }
    return parsed.toString();
  } catch (_) {
    return null;
  }
}

function inlineTokensToSafeNodes(tokens = []) {
  return tokens.flatMap((token) => {
    switch (token?.type) {
      case "text":
      case "escape":
        return token.tokens?.length
          ? inlineTokensToSafeNodes(token.tokens)
          : [textNode(token.text)];
      case "strong":
        return [elementNode("strong", inlineTokensToSafeNodes(token.tokens))];
      case "em":
        return [elementNode("em", inlineTokensToSafeNodes(token.tokens))];
      case "codespan":
        return [elementNode("code", [textNode(token.text)])];
      case "br":
        return [elementNode("br")];
      case "link": {
        const children = token.tokens?.length
          ? inlineTokensToSafeNodes(token.tokens)
          : [textNode(token.text)];
        const href = normalizeSafeModalPreambleUrl(token.href);
        return href
          ? [elementNode("a", children, { href })]
          : children;
      }
      case "image":
        return token.text ? [textNode(token.text)] : [];
      case "del":
        return inlineTokensToSafeNodes(token.tokens);
      case "html":
        return [];
      default:
        return token?.tokens?.length
          ? inlineTokensToSafeNodes(token.tokens)
          : token?.text
            ? [textNode(token.text)]
            : [];
    }
  });
}

function blockTokensToSafeNodes(tokens = []) {
  return tokens.flatMap((token) => {
    switch (token?.type) {
      case "space":
      case "hr":
      case "html":
        return [];
      case "paragraph":
        return [elementNode("p", inlineTokensToSafeNodes(token.tokens))];
      case "text":
        return token.tokens?.length
          ? [elementNode("p", inlineTokensToSafeNodes(token.tokens))]
          : [textNode(token.text)];
      case "heading":
        return [
          elementNode("p", [
            elementNode("strong", inlineTokensToSafeNodes(token.tokens)),
          ]),
        ];
      case "list":
        return [
          elementNode(
            token.ordered ? "ol" : "ul",
            (token.items || []).map((item) =>
              elementNode("li", blockTokensToSafeNodes(item.tokens)),
            ),
          ),
        ];
      case "blockquote":
        return blockTokensToSafeNodes(token.tokens);
      case "code":
        return [elementNode("p", [elementNode("code", [textNode(token.text)])])];
      default:
        return token?.tokens?.length
          ? blockTokensToSafeNodes(token.tokens)
          : token?.text
            ? [textNode(token.text)]
            : [];
    }
  });
}

function buildSafeModalPreambleTree(markdown) {
  const source = String(markdown || "").trim();
  if (!source) {
    return [];
  }

  try {
    return blockTokensToSafeNodes(
      lexer(source, {
        breaks: true,
        gfm: true,
      }),
    );
  } catch (_) {
    return [elementNode("p", [textNode(source)])];
  }
}

function appendSafeNode(documentRef, parent, node, openExternal) {
  if (node.type === "text") {
    parent.appendChild(documentRef.createTextNode(node.text));
    return;
  }

  const element = documentRef.createElement(node.tag);
  if (node.tag === "a") {
    const href = normalizeSafeModalPreambleUrl(node.attributes?.href);
    if (href) {
      element.setAttribute("href", href);
      element.setAttribute("rel", "noopener noreferrer");
      element.addEventListener("click", (event) => {
        event.preventDefault();
        void openExternal(href);
      });
    }
  }
  for (const child of node.children || []) {
    appendSafeNode(documentRef, element, child, openExternal);
  }
  parent.appendChild(element);
}

function renderSafeModalPreamble(
  container,
  markdown,
  {
    documentRef = globalThis.document,
    openExternal = (url) => globalThis.window?.electronAPI?.openExternal?.(url),
  } = {},
) {
  const nodes = buildSafeModalPreambleTree(markdown);
  container.replaceChildren();
  container.hidden = nodes.length === 0;

  for (const node of nodes) {
    appendSafeNode(documentRef, container, node, openExternal);
  }
  return nodes.length > 0;
}

const safeModalMarkdownRenderer = {
  buildSafeModalPreambleTree,
  normalizeSafeModalPreambleUrl,
  renderSafeModalPreamble,
  // Compatibility aliases for the original sensitive-info-only caller/tests.
  buildSensitiveInfoPreambleTree: buildSafeModalPreambleTree,
  normalizeSensitiveInfoPreambleUrl: normalizeSafeModalPreambleUrl,
  renderSensitiveInfoPreamble: renderSafeModalPreamble,
};

if (typeof window !== "undefined") {
  window.safeModalMarkdownRenderer = safeModalMarkdownRenderer;
  window.sensitiveInfoMarkdownRenderer = safeModalMarkdownRenderer;
}

if (typeof module !== "undefined") {
  module.exports = safeModalMarkdownRenderer;
}
