import { MessageCircleQuestion } from 'lucide-react';
import { useT, fmt } from '../../i18n';
import { useRuns } from '../../lib/agents/runs';
import { useProjects, switchProject } from '../../store/projects';
import { useStore } from '../../store';
import { useUiStore } from '../../lib/ui-store';
import { Button } from '../ui/button';
import { Popover, PopoverContent, PopoverHeader, PopoverTitle, PopoverTrigger } from '../ui/popover';
import { ApprovalCard } from './ApprovalCard';

// The page's waiting questions: an agent run asks while its canvas is out
// of view — it goes on running when the canvas is switched — and the
// question waits here instead of being withdrawn. Each is answered in
// place, or one click takes the person to the node it belongs to. The
// canvas in view asks on its own cards (and a toast when the card is off
// screen), so only other canvases' questions gather here.

export default function WaitingQuestions() {
  const t = useT();
  const activeId = useProjects((s) => s.activeId);
  const projects = useProjects((s) => s.projects);
  const runs = useRuns((s) => s.runs);
  const waiting = Object.values(runs).filter((r) => r.approvals.length > 0 && r.canvasId !== activeId);
  if (waiting.length === 0) return null;
  const count = waiting.reduce((n, r) => n + r.approvals.length, 0);
  const goTo = async (canvasId: string, nodeId: string) => {
    await switchProject(canvasId);
    useStore.getState().setSelectedNodeId(nodeId);
    useUiStore.getState().setArrivalFocusNodeId(nodeId);
  };
  return (
    <Popover>
      <PopoverTrigger
        render={<Button variant="chrome" className="gap-1.5 px-2 text-xs text-warning" data-waiting-questions={count} />}
        title={fmt(t('runs.waitingTitle'), { n: count })}
      >
        <MessageCircleQuestion strokeWidth={1.75} /> {count}
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-[360px] max-h-[70vh] overflow-y-auto">
        <PopoverHeader>
          <PopoverTitle>{fmt(t('runs.waitingTitle'), { n: count })}</PopoverTitle>
        </PopoverHeader>
        {waiting.map((r) => (
          <div key={r.nodeId} className="flex flex-col gap-1.5" data-waiting-run={r.nodeId}>
            <div className="flex items-center gap-2 text-2xs text-muted-foreground">
              <span className="truncate flex-1 min-w-0" title={r.question}>
                {projects.find((p) => p.id === r.canvasId)?.name ?? ''} · {r.question.split('\n')[0].slice(0, 60)}
              </span>
              <Button variant="link" size="xs" className="h-auto px-0 text-2xs shrink-0" onClick={() => void goTo(r.canvasId, r.nodeId)}>
                {t('offscreen.locate')}
              </Button>
            </div>
            {r.approvals.map((req) => <ApprovalCard key={req.id} nodeId={r.nodeId} request={req} compact />)}
          </div>
        ))}
      </PopoverContent>
    </Popover>
  );
}
