import { useState } from 'react';
import { JsonView, defaultStyles } from 'react-json-view-lite';
import 'react-json-view-lite/dist/index.css';

interface PayloadViewerProps {
  payload: Record<string, unknown>;
  modelName?: string;
  note?: string;
}

export function PayloadViewer({ payload, modelName, note }: PayloadViewerProps) {
  const isAtlas = (modelName || '').toLowerCase().includes('atlas');
  const isGpt5 = (modelName || '').toLowerCase().startsWith('gpt-5');
  const hasNamespaces = payload?._tool_namespaces && typeof payload._tool_namespaces === 'object';
  const bridgeNote = note
    ?? (isAtlas
      ? 'The Rust bridge preserves separate Atlas system messages, sets stable cache breakpoints on the static context and model prompt, and the upstream provider payload reflects the final request sent to Bedrock.'
      : isGpt5 && hasNamespaces
        ? 'The Rust bridge groups tools into namespaces and hoists static system messages to the Responses API "instructions" field before sending to OpenAI.'
        : isGpt5
          ? 'The Rust bridge hoists static system messages to the Responses API "instructions" field before sending to OpenAI.'
          : null);
  const [expandLevel, setExpandLevel] = useState(2);

  const customStyles = {
    ...defaultStyles,
    container: 'p-4 font-mono text-sm',
    basicChildStyle: 'text-slate-300',
    label: 'text-blue-400 mr-1',
    nullValue: 'text-slate-500',
    undefinedValue: 'text-slate-500',
    numberValue: 'text-green-400',
    stringValue: 'text-amber-300',
    booleanValue: 'text-purple-400',
    punctuation: 'text-slate-500',
    collapseIcon: 'text-slate-400 cursor-pointer hover:text-white',
    expandIcon: 'text-slate-400 cursor-pointer hover:text-white',
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
  };

  return (
    <div className="h-full flex flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between p-2 border-b border-monitor-border bg-monitor-bg">
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-500">Expand level:</span>
          {[1, 2, 3, 5, 10].map((level) => (
            <button
              key={level}
              onClick={() => setExpandLevel(level)}
              className={`px-2 py-0.5 text-xs rounded ${
                expandLevel === level
                  ? 'bg-monitor-accent text-white'
                  : 'bg-monitor-card text-slate-400 hover:text-white'
              }`}
            >
              {level}
            </button>
          ))}
        </div>
        <button
          onClick={handleCopy}
          className="flex items-center gap-1 px-2 py-1 text-xs text-slate-400 hover:text-white bg-monitor-card rounded"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          Copy
        </button>
      </div>

      {/* Bridge transformation note */}
      {bridgeNote && (
        <div className="flex items-start gap-2 px-3 py-2 border-b border-monitor-border bg-amber-950/20 text-xs text-amber-300/80">
          <svg className="w-4 h-4 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span>{bridgeNote}</span>
        </div>
      )}

      {/* JSON View */}
      <div className="flex-1 overflow-auto bg-monitor-bg">
        <JsonView
          data={payload}
          shouldExpandNode={(level) => level < expandLevel}
          style={customStyles}
        />
      </div>
    </div>
  );
}
