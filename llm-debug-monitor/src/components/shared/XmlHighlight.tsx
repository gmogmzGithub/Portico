import { useMemo, useState, useCallback } from 'react';
import { clsx } from 'clsx';
import { prettifyXml, tokenizeXml, type XmlToken } from '@/utils/xml';

interface XmlHighlightProps {
  xml: string;
  /** Show line numbers */
  showLineNumbers?: boolean;
  /** Maximum height before scrolling (in rem) */
  maxHeight?: string;
  /** Initial collapsed state */
  collapsed?: boolean;
}

/**
 * Syntax-highlighted XML viewer with proper indentation
 * Designed for Portico context XML in system messages
 */
export function XmlHighlight({
  xml,
  showLineNumbers = true,
  maxHeight = '24rem',
  collapsed: initialCollapsed = false,
}: XmlHighlightProps) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => !prev);
  }, []);

  // Prettify and tokenize the XML
  const { lines, tokenizedLines } = useMemo(() => {
    const prettified = prettifyXml(xml);
    const lines = prettified.split('\n');

    // Tokenize each line for syntax highlighting
    const tokenizedLines = lines.map((line) => tokenizeXml(line));

    return { lines, tokenizedLines };
  }, [xml]);

  // Get styles for each token type
  const getTokenStyle = (type: XmlToken['type']): string => {
    switch (type) {
      case 'tag-bracket':
        return 'text-slate-500';
      case 'tag-name':
        return 'text-blue-400';
      case 'attribute-name':
        return 'text-purple-400';
      case 'attribute-value':
        return 'text-amber-300';
      case 'equals':
        return 'text-slate-500';
      case 'quote':
        return 'text-slate-500';
      case 'comment':
        return 'text-slate-600 italic';
      case 'text':
      default:
        return 'text-slate-300';
    }
  };

  // Render a single token
  const renderToken = (token: XmlToken, index: number) => (
    <span key={index} className={getTokenStyle(token.type)}>
      {token.value}
    </span>
  );

  // Preview for collapsed state - show first tag
  const previewText = useMemo(() => {
    const match = xml.match(/<(\w+)[^>]*>/);
    return match ? `<${match[1]}>...</${match[1]}>` : '<...>';
  }, [xml]);

  if (collapsed) {
    return (
      <div className="font-mono text-xs">
        <button
          onClick={toggleCollapsed}
          className="flex items-center gap-2 text-slate-400 hover:text-white transition-colors"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <span className="text-blue-400">{previewText}</span>
          <span className="text-slate-600 text-xs">({lines.length} lines)</span>
        </button>
      </div>
    );
  }

  return (
    <div className="relative">
      {/* XML Indicator Header */}
      <div className="flex items-center gap-2 mb-2 text-xs">
        <span className="px-2 py-0.5 bg-blue-900/50 text-blue-300 rounded border border-blue-700/50 font-medium">
          XML
        </span>
        <span className="text-slate-500">{lines.length} lines</span>
        {/* Collapse button */}
        <button
          onClick={toggleCollapsed}
          className="p-1 text-slate-500 hover:text-white transition-colors"
          title="Collapse"
        >
          <svg className="w-3 h-3 rotate-90" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>

      <div
        className={clsx(
          'overflow-auto rounded bg-slate-950/50 border border-blue-700/30',
          showLineNumbers && 'pl-2'
        )}
        style={{ maxHeight }}
      >
        <table className="w-full font-mono text-xs border-collapse">
          <tbody>
            {tokenizedLines.map((tokens, lineIndex) => (
              <tr key={lineIndex} className="hover:bg-slate-800/30">
                {showLineNumbers && (
                  <td className="text-right pr-3 py-0.5 text-slate-600 select-none w-8 align-top text-xs">
                    {lineIndex + 1}
                  </td>
                )}
                <td className="py-0.5 whitespace-pre">
                  {tokens.map(renderToken)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
