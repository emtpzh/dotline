import { useEffect, useMemo, useState } from 'react';
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { ChevronsDownUp, UnfoldVertical } from 'lucide-react';
import type { ThoughtNode as ThoughtNodeType } from '../types';
import { useStore } from '../store';
import { useZoomTier } from '../lib/use-map-mode';
import { pleatTurnsKey, type PleatTurn } from '../lib/pleats';
import { remeasure } from '../lib/remeasure';
import { useT, fmt } from '../i18n';
import { Button } from './ui/button';
import { FaceName, FarMark } from './app/NodeFace';

// A pleat: a run of folded turns on one column, drawn as one strip by the
// run's first turn (lib/pleats; App hides the others and draws their wires
// to it). A bead per turn, marked with the turn's judged move: hover reads
// it, a click takes it out. Unfold brings the whole run back; the cards the
// strip holds peek out underneath it.

const BEAD = 24; // a bead's hit area: Button icon-xs
const BEADS_LEFT = 10; // the beads row's inset (px-4 less -ml-1.5)
const PEEK_W = 360;
// zero-size anchors on the card's border, as the real card's side anchors:
// the wires meet the strip, nobody wires from it
const ANCHOR = '!bg-transparent !w-0 !h-0 !border-0 !pointer-events-none';
// the moves a bead and a peek mark; a plain insight stays unmarked
const MOVE_KEY = { ruleout: 'takeaway.ruleout', decision: 'takeaway.decision', pivot: 'takeaway.pivot', open: 'takeaway.open' } as const;
const markOf = (move: string | null) => (move && move in MOVE_KEY ? (move as keyof typeof MOVE_KEY) : undefined);

const hm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
const md = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;

/** When the run was asked: one time, a span within a day, or dates too. */
function span(turns: PleatTurn[]): string {
  const ds = turns.map((t) => (t.at ? new Date(t.at) : null)).filter((d): d is Date => !!d && !isNaN(d.getTime()));
  if (ds.length === 0) return '';
  const a = ds[0];
  const b = ds[ds.length - 1];
  if (a.toDateString() !== b.toDateString()) return `${md(a)} ${hm(a)} – ${md(b)} ${hm(b)}`;
  return hm(a) === hm(b) ? hm(a) : `${hm(a)} – ${hm(b)}`;
}

/** What the run went through, by name: all of it when short. */
function trail(turns: PleatTurn[]): string {
  const names = turns.map((t) => t.name).filter(Boolean);
  return names.length <= 3 ? names.join(' → ') : `${names[0]} → ${names[1]} → … → ${names[names.length - 1]}`;
}

function Bead({ turn, ctx }: { turn: PleatTurn; ctx?: boolean }) {
  return (
    <span className="pleat-bead" data-move={markOf(turn.move)}
      data-fork={turn.fork ? '' : undefined} data-marked={turn.marked ? '' : undefined} data-ctx={ctx ? '' : undefined} />
  );
}

/** Hovering a bead: that turn's face, lifted above the strip. */
function Peek({ turn, left }: { turn: PleatTurn; left: number }) {
  const t = useT();
  const mark = markOf(turn.move);
  return (
    <div className="pointer-events-none absolute bottom-[calc(100%+12px)] rounded-xl border border-border bg-card shadow-lg animate-in duration-(--dur-fast) fade-in-0 zoom-in-95"
      style={{ left, width: PEEK_W }} data-pleat-peek>
      <div className="tdag-face">
        <FaceName shape="round" tone="primary" name={turn.name || null} state={null}
          tags={mark ? <span className="tdag-tag">{t(MOVE_KEY[mark])}</span> : undefined}
          trailing={<span className="font-mono text-2xs text-muted-foreground tabular-nums">#{turn.n}{turn.at ? ` · ${hm(new Date(turn.at))}` : ''}</span>} />
        <div className="tdag-q tdag-clamp-2">{turn.question || t('face.noQuestion')}</div>
        {turn.conclusion
          ? <div className="tdag-c"><span className="tdag-clamp-2">{turn.conclusion}</span></div>
          : <div className="tdag-c-gap" />}
      </div>
      <div className="-mt-2 px-4 pb-2.5 text-2xs text-primary">{t('pleat.peekHint')}</div>
    </div>
  );
}

export default function PleatNode({ id, data }: NodeProps<ThoughtNodeType>) {
  const t = useT();
  const ids = data.pleat?.ids ?? [id];
  const ctx = data.pleat?.ctx ?? 0;
  const turnsKey = useStore((s) => pleatTurnsKey(s.nodes, s.edges, ids));
  const turns = useMemo(() => JSON.parse(turnsKey) as PleatTurn[], [turnsKey]);
  const setFolded = useStore((s) => s.setFolded);
  const [hover, setHover] = useState<number | null>(null);
  const tier = useZoomTier();
  const glyph = tier === 'glyph';
  // the anchors move to the dot at the far tier — React Flow re-measures them
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => { remeasure(id, updateNodeInternals); }, [glyph, id, updateNodeInternals]);

  const label = fmt(t('pleat.folded'), { n: turns.length });
  const unfold = () => setFolded(ids, false);
  const hasFork = turns.some((x) => x.fork);
  const anchors = (
    <>
      <Handle type="target" position={Position.Top} id="top" isConnectable={false} className={ANCHOR} style={glyph ? { top: '50%' } : undefined} />
      <Handle type="target" position={Position.Left} id="left" isConnectable={false} className={ANCHOR} style={glyph ? { top: '50%', left: '50%' } : { top: '40%' }} />
      <Handle type="source" position={Position.Bottom} id="continue" isConnectable={false} className={ANCHOR} style={glyph ? { top: '50%', bottom: 'auto' } : undefined} />
      <Handle type="source" position={Position.Right} id="branch" isConnectable={false} className={ANCHOR} style={glyph ? { top: '50%', left: '50%', right: 'auto' } : { top: '68%' }} />
    </>
  );

  if (glyph) {
    // Far: one dot for the whole run, named by its size
    return (
      <div className="relative h-32 w-[520px]" title={trail(turns)} data-glyph-node data-pleat>
        {anchors}
        <FarMark shape="round" tone="muted" name={label} state={null} priority={1} />
      </div>
    );
  }

  const map = tier === 'map';
  const peekLeft = hover === null ? 0 : Math.max(-24, Math.min(520 - PEEK_W + 24, BEADS_LEFT + BEAD * hover + BEAD / 2 - PEEK_W / 2));
  return (
    <div className={`pleat ${map ? 'map-node' : ''}`} data-pleat
      onMouseLeave={() => setHover(null)}
      onDoubleClick={(e) => { e.stopPropagation(); unfold(); }}>
      <div className="pleat-sheet" data-depth="2" />
      <div className="pleat-sheet" data-depth="1" />
      <div className={`thought-node pleat-card rounded-xl ${ctx > 0 ? 'pleat-ctx' : ''}`}>
        {anchors}
        {map ? (
          // Map: the same strip drawn larger, its size and its beads
          <div className="flex min-w-0 items-center gap-[0.6em]">
            <ChevronsDownUp className="size-[1em] shrink-0 text-muted-foreground" strokeWidth={1.75} />
            <span className="shrink-0 font-semibold text-foreground">{label}</span>
            <span className="pleat-beads">{turns.map((x) => <Bead key={x.id} turn={x} />)}</span>
          </div>
        ) : (
          <>
            <div className="flex h-6 min-w-0 items-center gap-2">
              <ChevronsDownUp className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
              <span className="shrink-0 text-sm font-semibold text-foreground">{label}</span>
              <span className="min-w-0 truncate text-xs text-muted-foreground" title={turns.map((x) => x.name).join(' → ')}>{trail(turns)}</span>
              <span className="flex-1" />
              <Button variant="ghost" size="xs" title={t('pleat.unfoldTitle')}
                className="-mr-2 shrink-0 text-muted-foreground nodrag nopan hover:text-foreground"
                onClick={(e) => { e.stopPropagation(); unfold(); }} data-pleat-unfold>
                <UnfoldVertical strokeWidth={1.75} />{t('pleat.unfold')}
              </Button>
            </div>
            <div className="-ml-1.5 flex h-6 min-w-0 items-center">
              <span className="flex min-w-0 items-center overflow-hidden">
                {turns.map((x, i) => (
                  <Button key={x.id} variant="ghost" size="icon-xs" className="shrink-0 rounded-full nodrag nopan"
                    aria-label={fmt(t('pleat.bead'), { n: x.n, name: x.name })}
                    onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onBlur={() => setHover(null)}
                    onClick={(e) => { e.stopPropagation(); setHover(null); setFolded([x.id], false); }}
                    data-pleat-bead={x.id}>
                    <Bead turn={x} />
                  </Button>
                ))}
              </span>
              <span className="min-w-2 flex-1" />
              <span className="pleat-meta" data-ctx={ctx > 0 ? '' : undefined}>
                {ctx > 0 ? fmt(t('pleat.inContext'), { n: ctx }) : span(turns)}
              </span>
            </div>
          </>
        )}
      </div>
      {hasFork && <span className="pleat-port" title={t('pleat.forkPort')} />}
      {!map && hover !== null && turns[hover] && <Peek turn={turns[hover]} left={peekLeft} />}
    </div>
  );
}
