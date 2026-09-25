import type { ReactNode } from 'react';
import { BookOpen, Bot, Globe, Pencil, Search, SquareTerminal, Wrench } from 'lucide-react';
import type { ActionKind, ActionMark } from '../../lib/turn-insight';
import type { FaceShape, FaceState, FaceTone } from '../../lib/node-face';
import { useT, fmt } from '../../i18n';
import { Button } from '../ui/button';

// The card face: the layers a node shows at every zoom that still shows
// text. Sized in em off the face's own font size (14px × --k), so the map
// tier renders the SAME face larger instead of a different plaque.
// Styles live in styles/canvas.css (.tdag-face …).

const ACT_ICON: Record<ActionKind, typeof Pencil> = {
  edit: Pencil,
  read: BookOpen,
  search: Search,
  run: SquareTerminal,
  web: Globe,
  agent: Bot,
  other: Wrench,
};

const STATE_KEY = {
  failed: 'common.generationFailed',
  wait: 'face.awaiting',
  running: 'face.running',
  upstream: 'paradigm.waitingUpstream',
  stale: 'node.staleBadge',
} as const;

export function StateMark({ state, onClick, title }: { state: FaceState; onClick?: (e: React.MouseEvent) => void; title?: string }) {
  const t = useT();
  const label = t(STATE_KEY[state]);
  return onClick ? (
    <Button variant="ghost" size="xs" className="tdag-state nodrag" data-state={state} onClick={onClick} title={title}>{label}</Button>
  ) : (
    <span className="tdag-state" data-state={state} title={title}>{label}</span>
  );
}

export function ActionMarks({ marks }: { marks: ActionMark[] }) {
  const t = useT();
  if (marks.length === 0) return null;
  return (
    <span className="tdag-acts" data-action-marks>
      {marks.map(({ kind, count }) => {
        const Icon = ACT_ICON[kind];
        return (
          <span key={kind} className="tdag-act" data-kind={kind} title={fmt(t(`face.act.${kind}`), { n: count })}>
            <Icon strokeWidth={1.75} />{count}
          </span>
        );
      })}
    </span>
  );
}

/** Layer 1, the name row: shape · name · actions · state, then whatever
 *  controls the working card needs (never shown on the map). */
export function FaceName({ shape, tone, name, marks, state, stateMark, trailing, className = '' }: {
  shape: FaceShape;
  tone: FaceTone;
  /** null until the node has a real name — the question right below
      already says what a fallback name would repeat */
  name: string | null;
  marks: ActionMark[];
  state: FaceState | null;
  /** replaces the plain state mark (the working card makes "stale" clickable) */
  stateMark?: ReactNode;
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`tdag-l1 ${className}`} data-tone={tone}>
      <span className="tdag-shape" data-shape={shape} />
      {name && <span className="tdag-name" title={name}>{name}</span>}
      <ActionMarks marks={marks} />
      <span className="flex-1" />
      {stateMark ?? (state && <StateMark state={state} />)}
      {trailing}
    </div>
  );
}

/** Layers 2 + 3 folded: the question in two lines, the conclusion in one. */
export function FaceBody({ question, placeholder, conclusion }: { question: string; placeholder: string; conclusion: string | null }) {
  return (
    <>
      <div className={`tdag-q tdag-clamp-2 ${question.trim() ? '' : 'tdag-q-empty'}`}>{question.trim() || placeholder}</div>
      {conclusion
        ? <div className="tdag-c"><span className="tdag-clamp-1">{conclusion}</span></div>
        : <div className="tdag-c-gap" />}
    </>
  );
}

/** The far view: the name row's shape grown into a dot, with the name
 *  beside it. Counter-scaled to a fixed screen size (canvas.css), labels
 *  thinned by priority as the map gets dense. */
export function FarMark({ shape, tone, name, state, priority }: {
  shape: FaceShape;
  tone: FaceTone;
  name: string | null;
  state: FaceState | null;
  priority: number;
}) {
  return (
    <span className="tdag-far" data-tone={tone} data-state={state ?? undefined} data-pri={priority}>
      <span className="tdag-far-dot" data-shape={shape} />
      {name && <span className="tdag-far-label">{name}</span>}
    </span>
  );
}
