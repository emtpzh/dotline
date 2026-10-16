import { ChevronRight, Loader2, X } from 'lucide-react';
import { useT, fmt, type MessageKey } from '../../i18n';
import { countSteps, opOf, stepHeadline, type StepCount } from '../../lib/transcript';
import type { AgentStep, AgentTraceEntry } from '../../types';
import { LINE_BODY_CLASS, LINE_CLASS } from './line';

// A run of tool calls between two passages of an answer, folded to one grey
// line that says what they did ("Read 2 files, ran a command"). Open, each
// call is a line of its own — the tool and what it was pointed at — that
// opens onto what it was given and what came back.

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

function useStepsLabel(): (counts: StepCount[]) => string {
  const t = useT();
  return (counts) => counts
    .map((c) => (c.n === 1 ? t(`transcript.${c.op}One` as MessageKey) : fmt(t(`transcript.${c.op}` as MessageKey), { n: c.n })))
    // one sentence: only its first word keeps the capital
    .map((s, i) => (i > 0 ? lowerFirst(s) : s))
    .join(t('transcript.sep'));
}

const STEP_SUMMARY = 'flex min-w-0 cursor-pointer list-none items-baseline gap-2 py-0.5 font-mono text-xs [&::-webkit-details-marker]:hidden';
const STEP_BLOCK = 'mt-1 mb-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted px-2.5 py-1.5 font-mono text-2xs leading-relaxed';

function StepRow({ step }: { step: AgentStep }) {
  const t = useT();
  const headline = stepHeadline(step);
  // the call shows above the output where it says more than the headline:
  // an edit's diff, a call that names no file, page or command
  const call = step.call.trim();
  const op = opOf(step);
  const showCall = !!call && (op === 'edit' || op === 'write'
    || (op !== 'run' && !step.paths?.length && !step.url && call !== headline && (call.includes('\n') || call.length > headline.length + 8)));
  return (
    <li>
      <details>
        <summary className={STEP_SUMMARY} title={step.paths?.join('\n') ?? step.url ?? undefined}>
          <span className="shrink-0 text-foreground">{step.tool}</span>
          <span className="truncate text-muted-foreground">{headline}</span>
        </summary>
        {showCall && <pre className={`${STEP_BLOCK} text-foreground/80`}>{call}</pre>}
        <pre className={`${STEP_BLOCK} text-muted-foreground`}>{step.result.trim() || t('transcript.noOutput')}</pre>
      </details>
    </li>
  );
}

/** The calls of a finished turn. */
export function StepsLine({ steps }: { steps: AgentStep[] }) {
  const label = useStepsLabel();
  return (
    <details className="group/steps" data-transcript-steps>
      <summary className={LINE_CLASS}>
        <span className="truncate">{label(countSteps(steps))}</span>
        <ChevronRight size={14} strokeWidth={1.75} className="shrink-0 transition-transform group-open/steps:rotate-90" />
      </summary>
      <ol className={`${LINE_BODY_CLASS} flex flex-col`}>
        {steps.map((s) => <StepRow key={s.id} step={s} />)}
      </ol>
    </details>
  );
}

/** The calls of a turn still running: the one in flight says so, with a spinner. */
export function LiveStepsLine({ entries }: { entries: AgentTraceEntry[] }) {
  const t = useT();
  const label = useStepsLabel();
  const running = [...entries].reverse().find((e) => e.status === 'running');
  const done = entries.filter((e) => e.status !== 'running');
  return (
    <details className="group/steps" data-transcript-steps data-agent-trace>
      <summary className={`${LINE_CLASS} ${running ? 'text-muted-foreground' : ''}`}>
        {running ? (
          <>
            <Loader2 size={14} strokeWidth={1.75} className="shrink-0 animate-spin text-primary" />
            <span className="truncate">
              {fmt(t('transcript.running'), { name: running.name })}
              {running.query && <span className="font-mono text-xs"> {running.query}</span>}
              {done.length > 0 && <span> · {lowerFirst(label(countSteps(done)))}</span>}
            </span>
          </>
        ) : (
          <span className="truncate">{label(countSteps(entries))}</span>
        )}
        <ChevronRight size={14} strokeWidth={1.75} className="shrink-0 transition-transform group-open/steps:rotate-90" />
      </summary>
      <ol className={`${LINE_BODY_CLASS} flex flex-col`}>
        {entries.map((e) => (
          <li key={e.id} className="flex min-w-0 items-center gap-2 py-0.5 font-mono text-xs">
            {e.status === 'running'
              ? <Loader2 size={11} className="shrink-0 animate-spin text-primary" />
              : e.status === 'error' ? <X size={11} className="shrink-0 text-destructive" /> : null}
            <span className="shrink-0 text-foreground">{e.name}</span>
            <span className="truncate text-muted-foreground">{e.query}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}
