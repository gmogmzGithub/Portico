import { estimateTokens } from '@/utils/time';

interface TokenBadgeProps {
  charCount: number;
  className?: string;
}

export function TokenBadge({ charCount, className = '' }: TokenBadgeProps) {
  return (
    <span className={`px-1.5 py-0.5 text-[10px] font-medium bg-slate-700/50 text-slate-400 rounded ${className}`}>
      {estimateTokens(charCount)}
    </span>
  );
}
