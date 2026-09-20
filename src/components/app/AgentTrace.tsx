import { Loader2, Check, X, SquareTerminal } from 'lucide-react';
import { useT } from '../../i18n';
import type { AgentTraceEntry } from '../../types';

// What the agent is doing right now, one line per tool call, newest at the
// bottom — the transcript a terminal would show, on the node. Replaces the
// single progress line for agent lanes while the turn runs; the finished
// turn's calls become attachments (footprints) and this list goes away.

export function AgentTrace({ entries, compact }: { entries: AgentTraceEntry[]; compact?: boolean }) {
  const t = useT();
  const shown = compact ? entries.slice(-4) : entries;
  return (
    <div className={`rounded-xl bg-wash/70 ${compact ? 'px-3 py-2' : 'px-3 py-2.5'}`} data-agent-trace>
      <div className="text-2xs text-ink-faint mb-1 flex items-center gap-1.5">
        <SquareTerminal size={12} strokeWidth={1.75} /> {t('agent.trace')}
        {compact && entries.length > shown.length && <span className="ml-auto">+{entries.length - shown.length}</span>}
      </div>
      <ol className="space-y-0.5">
        {shown.map((e) => (
          <li key={e.id} className="flex items-center gap-1.5 text-2xs font-mono text-ink-muted min-w-0">
            {e.status === 'running' ? <Loader2 size={11} className="animate-spin shrink-0 text-accent" /> : e.status === 'ok' ? <Check size={11} className="shrink-0 text-emerald-600" /> : <X size={11} className="shrink-0 text-red-500" />}
            <span className="shrink-0 text-ink">{e.name}</span>
            <span className="truncate">{e.query}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
