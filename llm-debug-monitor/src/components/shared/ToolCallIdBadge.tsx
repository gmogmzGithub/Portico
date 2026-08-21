interface ToolCallIdBadgeProps {
  id: string;
  className?: string;
  isSelected?: boolean;
  onClick?: (id: string) => void;
}

export function ToolCallIdBadge({ id, className = '', isSelected = false, onClick }: ToolCallIdBadgeProps) {
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onClick?.(id);
  };

  return (
    <span
      onClick={onClick ? handleClick : undefined}
      className={`px-1.5 py-0.5 text-[10px] font-mono rounded transition-all ${
        isSelected
          ? 'bg-cyan-950 text-cyan-200 border border-cyan-400 ring-2 ring-cyan-400/50 shadow-lg shadow-cyan-500/30'
          : 'bg-cyan-900/50 text-cyan-300 border border-cyan-700/50'
      } ${onClick ? 'cursor-pointer hover:bg-cyan-800/70 hover:border-cyan-600' : ''} ${className}`}
    >
      {id}
    </span>
  );
}
