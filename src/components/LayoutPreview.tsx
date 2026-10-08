import { useEffect, useMemo } from 'react';
import { Panel, ViewportPortal, useReactFlow } from '@xyflow/react';
import { useStore } from '../store';
import { useUiStore } from '../lib/ui-store';
import { isPinned, planRelayout } from '../lib/layout';
import { isFrameNode } from '../lib/frames';
import { useT, fmt } from '../i18n';
import { Button } from './ui/button';
import type { ThoughtNode } from '../types';

// The one-click relayout, shown before it lands: a dashed outline where each
// card that moves will end up, and a bar that applies or drops the plan. A
// relayout re-derives the canvas; seeing that first is what makes it safe to
// press. The plan is recomputed from the live graph on every change, and
// applying runs the same plan (lib/layout planRelayout) through the store.

type Box = { id: string; x: number; y: number; width: number; height: number; frame: boolean };

const boxOf = (n: ThoughtNode): Box => ({
  id: n.id,
  x: n.position.x,
  y: n.position.y,
  width: n.measured?.width ?? n.width ?? 520,
  height: n.measured?.height ?? n.height ?? 120,
  frame: isFrameNode(n),
});

export default function LayoutPreview() {
  const preview = useUiStore((s) => s.layoutPreview);
  if (!preview) return null;
  return <OpenPreview resetPins={preview.resetPins} />;
}

function OpenPreview({ resetPins }: { resetPins: boolean }) {
  const t = useT();
  const rf = useReactFlow();
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);

  const { ghosts, held } = useMemo(() => {
    const before = new Map(nodes.map((n) => [n.id, n]));
    const out: Box[] = [];
    for (const n of planRelayout(nodes, edges, resetPins).nodes) {
      const b = before.get(n.id);
      if (!b) continue;
      const to = boxOf(n);
      const from = boxOf(b);
      const moved = Math.abs(to.x - from.x) > 0.5 || Math.abs(to.y - from.y) > 0.5;
      const resized = to.frame && (Math.abs(to.width - from.width) > 0.5 || Math.abs(to.height - from.height) > 0.5);
      if (moved || resized) out.push(to);
    }
    return { ghosts: out, held: resetPins ? 0 : nodes.filter(isPinned).length };
  }, [nodes, edges, resetPins]);

  // Frame the change once, on open: where the cards are and where they go
  useEffect(() => {
    const moving = new Set(ghosts.map((g) => g.id));
    const boxes = [...ghosts, ...nodes.filter((n) => moving.has(n.id)).map(boxOf)];
    if (boxes.length === 0) return;
    const x = Math.min(...boxes.map((b) => b.x));
    const y = Math.min(...boxes.map((b) => b.y));
    const width = Math.max(...boxes.map((b) => b.x + b.width)) - x;
    const height = Math.max(...boxes.map((b) => b.y + b.height)) - y;
    void rf.fitBounds({ x, y, width, height }, { padding: 0.15, duration: 300 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per open
  }, []);

  const close = () => useUiStore.getState().setLayoutPreview(null);
  const apply = () => {
    close();
    useStore.getState().relayout(resetPins);
    // after the cards have glided into place (lib/layout-motion)
    setTimeout(() => { void rf.fitView({ duration: 400, padding: 0.15 }); }, 260);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const summary = ghosts.length === 0
    ? t('layoutPreview.nothing')
    : fmt(t('layoutPreview.summary'), { n: ghosts.filter((g) => !g.frame).length });

  return (
    <>
      <ViewportPortal>
        {ghosts.map((g) => (
          <div
            key={g.id}
            className={`absolute left-0 top-0 pointer-events-none rounded-xl border-2 border-dashed ${g.frame ? 'border-muted-foreground/60' : 'border-primary/80 bg-primary/10'}`}
            style={{ transform: `translate(${g.x}px, ${g.y}px)`, width: g.width, height: g.height }}
            data-layout-ghost
          />
        ))}
      </ViewportPortal>
      <Panel position="top-center" className="!mt-16">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-card px-4 py-2 text-sm shadow-sm" role="status" data-layout-preview>
          <span className="text-foreground">{summary}</span>
          {held > 0 && <span className="text-muted-foreground">{fmt(t('layoutPreview.held'), { n: held })}</span>}
          <span className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={close}>{t('common.cancel')}</Button>
            <Button size="sm" onClick={apply} disabled={ghosts.length === 0}>{t('layoutPreview.apply')}</Button>
          </span>
        </div>
      </Panel>
    </>
  );
}
