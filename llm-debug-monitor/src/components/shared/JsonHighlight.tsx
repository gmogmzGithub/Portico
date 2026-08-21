import { JsonView, defaultStyles } from 'react-json-view-lite';
import 'react-json-view-lite/dist/index.css';

interface JsonHighlightProps {
  data: unknown;
  collapsed?: boolean;
  expandLevel?: number;
}

const jsonStyles = {
  ...defaultStyles,
  container: 'bg-transparent font-mono text-sm',
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

function tryParseJson(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return value;
}

export function JsonHighlight({ data, collapsed = false, expandLevel = 2 }: JsonHighlightProps) {
  const parsed = tryParseJson(data);

  // If it's still a string after trying to parse, just display it
  if (typeof parsed === 'string') {
    return <span className="text-amber-300 font-mono text-sm whitespace-pre-wrap">{parsed}</span>;
  }

  return (
    <JsonView
      data={parsed as object}
      style={jsonStyles}
      shouldExpandNode={(level) => !collapsed && level < expandLevel}
    />
  );
}
