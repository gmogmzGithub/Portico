import { useMemo } from 'react';
import { clsx } from 'clsx';
import type { ActiveTool } from '@/types/events';

interface CapabilitiesViewerProps {
  toolIds: string[];
  skills: string[];
  activeServers?: ActiveTool[];
}

export function CapabilitiesViewer({ toolIds, skills, activeServers = [] }: CapabilitiesViewerProps) {
  // Build server info with metadata from activeServers
  const servers = useMemo(() => {
    return toolIds.map((toolId) => {
      const serverId = toolId.replace('server:', '');
      const serverMeta = activeServers.find((s) => s.server_id === serverId);

      // Icon URL can come from serverMeta (relative to OWUI) or construct our own
      // For LLM debug monitor, we need to point to the OWUI backend
      // Detection: Check which OWUI port is available
      // - Ports 5176/5173: LLM debug monitor's own Vite dev server -> OWUI on 3789
      // - Port 8879: Docker container -> check both, prefer dev (3789)
      // In Docker dev mode, OWUI is on 3789; in prod, it's on 8080
      // Since we can't easily detect at runtime, we use port 3789 when on 8879
      // (icons will gracefully fallback to initials if URL fails)
      const port = window.location.port;
      const useDevOwui = port === '5176' || port === '5173' || port === '8879';
      const owuiBase = useDevOwui
        ? 'http://localhost:3789'  // Dev mode: OWUI Vite dev server
        : 'http://localhost:8080'; // Prod mode: Direct OWUI
      const iconPath = serverMeta?.icon_url || `/api/v1/chats/mcp/servers/${serverId}/icon`;
      // If icon_url is relative, prepend OWUI base URL
      const iconUrl = iconPath.startsWith('/') ? `${owuiBase}${iconPath}` : iconPath;

      return {
        serverId,
        displayName: serverMeta?.display_name || serverId.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        iconUrl,
        isCore: serverMeta?.is_core ?? false,
        isUserInstalled: serverMeta?.user_installed ?? false,
      };
    }).sort((a, b) => {
      // Sort: Core first, then System, then User, alphabetically within each
      if (a.isCore !== b.isCore) return a.isCore ? -1 : 1;
      if (a.isUserInstalled !== b.isUserInstalled) return a.isUserInstalled ? 1 : -1;
      return a.displayName.localeCompare(b.displayName);
    });
  }, [toolIds, activeServers]);

  const hasServers = servers.length > 0;
  const hasSkills = skills.length > 0;

  if (!hasServers && !hasSkills) {
    return (
      <div className="p-8 text-center">
        <div className="text-slate-500 text-sm">No capabilities enabled for this request</div>
      </div>
    );
  }

  return (
    <div className="p-4 space-y-6">
      {/* Tool Servers Section */}
      {hasServers && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <svg className="w-4 h-4 text-blue-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
            </svg>
            <h3 className="text-sm font-medium text-slate-300">
              MCP Servers
              <span className="ml-2 px-1.5 py-0.5 text-xs bg-monitor-bg rounded">{servers.length}</span>
            </h3>
          </div>

          <div className="grid gap-2">
            {servers.map((server) => (
              <div
                key={server.serverId}
                className="flex items-center gap-3 p-3 rounded-lg bg-monitor-bg border border-monitor-border hover:border-slate-600 transition-colors"
              >
                {/* Icon */}
                <div className="size-8 rounded-lg overflow-hidden bg-slate-800 flex-shrink-0 flex items-center justify-center">
                  <img
                    src={server.iconUrl}
                    alt=""
                    className="size-full object-cover"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                      const parent = (e.target as HTMLImageElement).parentElement;
                      if (parent) {
                        const fallback = parent.querySelector('.fallback');
                        if (fallback) (fallback as HTMLElement).style.display = 'flex';
                      }
                    }}
                  />
                  <span className="fallback hidden size-full items-center justify-center text-xs font-medium text-slate-400">
                    {server.displayName.charAt(0).toUpperCase()}
                  </span>
                </div>

                {/* Name and Badge */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-200 truncate">
                      {server.displayName}
                    </span>
                    <span
                      className={clsx(
                        'px-1.5 py-0.5 text-[10px] font-medium rounded flex-shrink-0',
                        server.isCore
                          ? 'bg-blue-900/50 text-blue-300 border border-blue-700/50'
                          : server.isUserInstalled
                          ? 'bg-emerald-900/50 text-emerald-300 border border-emerald-700/50'
                          : 'bg-purple-900/50 text-purple-300 border border-purple-700/50'
                      )}
                    >
                      {server.isCore ? 'Core' : server.isUserInstalled ? 'User' : 'System'}
                    </span>
                  </div>
                  <div className="text-xs text-slate-500 font-mono truncate">{server.serverId}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Skills Section */}
      {hasSkills && (
        <div>
          <div className="flex items-center gap-2 mb-3">
            <svg className="w-4 h-4 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
            </svg>
            <h3 className="text-sm font-medium text-slate-300">
              Activated Skills
              <span className="ml-2 px-1.5 py-0.5 text-xs bg-monitor-bg rounded">{skills.length}</span>
            </h3>
          </div>

          <div className="flex flex-wrap gap-2">
            {skills.map((skill) => (
              <div
                key={skill}
                className="flex items-center gap-2 px-3 py-2 rounded-lg bg-purple-950/30 border border-purple-900/50"
              >
                <svg className="w-4 h-4 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
                </svg>
                <span className="text-sm font-medium text-purple-200">
                  {skill.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
