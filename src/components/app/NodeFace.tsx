import type { ReactNode } from 'react';
import type { FaceShape, FaceState, FaceTone } from '../../lib/node-face';
import { useT } from '../../i18n';
import { Button } from '../ui/button';

// The card face: the layers a node shows at every zoom that still shows
// text. Sized in em off the face's own font size (14px × --k), so the map
// tier renders the SAME face larger instead of a different plaque.
// Styles live in styles/canvas.css (.tdag-face …).

const STATE_KEY = {
  failed: 'common.generationFailed',
  wait: 'face.awaiting',
  running: 'face.running',
  upstream: 'paradigm.waitingUpstream',
  stale: 'node.staleBadge',
  unlinked: 'content.unlinked',
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

/** Layer 1, the name row: shape · name · tags · state, then whatever
 *  controls the working card needs (never shown on the map). What the turn
 *  did with its tools is the panel's to say, not the card's. */
export function FaceName({ shape, tone, name, state, stateMark, trailing, tags, className = '' }: {
  shape: FaceShape;
  tone: FaceTone;
  /** null until the node has a real name — the question right below
      already says what a fallback name would repeat */
  name: string | null;
  state: FaceState | null;
  /** replaces the plain state mark (the working card makes "stale" clickable) */
  stateMark?: ReactNode;
  trailing?: ReactNode;
  /** marks that belong to this node alone, right after its name: the role
      it was set to, that it reruns itself, the session it left */
  tags?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`tdag-l1 ${className}`} data-tone={tone}>
      <span className="tdag-shape" data-shape={shape} />
      {name && <span className="tdag-name" title={name}>{name}</span>}
      {tags}
      <span className="flex-1" />
      {stateMark ?? (state && <StateMark state={state} />)}
      {trailing}
    </div>
  );
}

/** Layers 2 + 3 folded: the question in two lines, the conclusion in one —
 *  told apart by weight and tone, no marker (the line is the judged takeaway
 *  or, until one arrives, the answer's own words). */
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
