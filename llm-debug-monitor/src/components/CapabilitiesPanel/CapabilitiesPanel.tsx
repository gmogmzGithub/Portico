import type { ActiveTool, ActiveSkill } from '@/types/events';

interface CapabilitiesPanelProps {
  capabilities?: {
    tools: ActiveTool[];
    skills: ActiveSkill[];
  };
}

export function CapabilitiesPanel({ capabilities }: CapabilitiesPanelProps) {
  if (!capabilities || (capabilities.tools.length === 0 && capabilities.skills.length === 0)) {
    return (
      <div className="p-4 text-center">
        <p className="text-xs text-slate-500">No capabilities active</p>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4 max-h-64 overflow-y-auto">
      {/* Tools */}
      {capabilities.tools.length > 0 && (
        <div>
          <div className="text-xs font-medium text-slate-400 mb-2 flex items-center gap-1">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            </svg>
            Tools ({capabilities.tools.length})
          </div>
          <div className="flex flex-wrap gap-1.5">
            {capabilities.tools.map((tool) => (
              <div
                key={tool.server_id}
                className="flex items-center gap-1.5 px-2 py-1 bg-blue-500/20 text-blue-300 rounded text-xs"
                title={tool.server_id}
              >
                {tool.icon_url ? (
                  <img
                    src={tool.icon_url}
                    alt=""
                    className="w-3.5 h-3.5 rounded"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                ) : (
                  <div className="w-3.5 h-3.5 rounded bg-blue-500/30 flex items-center justify-center text-[8px]">
                    {tool.display_name.charAt(0).toUpperCase()}
                  </div>
                )}
                {tool.display_name}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Skills */}
      {capabilities.skills.length > 0 && (
        <div>
          <div className="text-xs font-medium text-slate-400 mb-2 flex items-center gap-1">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
            </svg>
            Skills ({capabilities.skills.length})
          </div>
          <div className="flex flex-wrap gap-1.5">
            {capabilities.skills.map((skill) => (
              <div
                key={skill.name}
                className="flex items-center gap-1.5 px-2 py-1 bg-purple-500/20 text-purple-300 rounded text-xs"
                title={skill.name}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
                </svg>
                {skill.display_name}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
