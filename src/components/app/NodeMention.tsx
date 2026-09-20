import { useEffect, useMemo, useState } from 'react';
import { AtSign, X } from 'lucide-react';
import { useStore } from '../../store';
import { useT } from '../../i18n';
import { nodeMentionTitle, type MentionState } from '../../lib/mentions';
import { Button } from '../ui/button';
import { Popover, PopoverContent } from '../ui/popover';

/** The @-picker (rendered right above the textarea) plus the attached
    chips row. Keyboard handling registers back into the mention state so
    the host textarea can defer to the picker while it is open. */
export default function MentionSurface({ m, text, setText }: {
  m: MentionState; text: string; setText: (v: string) => void;
}) {
  const nodes = useStore((s) => s.nodes);
  const t = useT();
  const [active, setActive] = useState(0);

  const candidates = useMemo(() => {
    if (m.query === null) return [];
    const q = m.query.toLowerCase();
    return nodes
      .filter((n) => n.id !== m.selfNodeId
        && n.data.stepKind !== 'frame'
        && (n.data.question || n.data.response)
        && !m.mentions.some((x) => x.nodeId === n.id))
      .filter((n) => !q
        || n.data.question.toLowerCase().includes(q)
        || n.data.response.toLowerCase().includes(q))
      .slice(0, 6);
  }, [nodes, m.query, m.selfNodeId, m.mentions]);

  useEffect(() => {
    m.setKeyHandler((e) => {
      if (m.query === null || candidates.length === 0) return false;
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => (a + 1) % candidates.length); return true; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => (a - 1 + candidates.length) % candidates.length); return true; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); m.pick(candidates[Math.min(active, candidates.length - 1)], text, setText); setActive(0); return true; }
      if (e.key === 'Escape') { e.preventDefault(); m.close(); return true; }
      return false;
    });
  });

  return (
    <>
      {/* Anchored to the textarea and portaled: an ask box sits at the foot
          of a card or a panel that clips its own overflow, and the picker
          has to stand outside that box. The textarea keeps the keyboard. */}
      <Popover open={m.query !== null && candidates.length > 0 && !!m.anchor}>
        <PopoverContent
          anchor={m.anchor}
          side="top"
          align="start"
          sideOffset={6}
          initialFocus={false}
          finalFocus={false}
          className="w-[var(--anchor-width)] max-h-[220px] overflow-y-auto gap-0 p-0 py-1 nodrag nopan"
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="px-3 py-1 text-2xs text-muted-foreground flex items-center gap-1">
            <AtSign size={11} strokeWidth={1.75} /> {t('mention.hint')}
          </div>
          {candidates.map((n, i) => (
            <Button variant="ghost"
              key={n.id}
              onMouseDown={(e) => { e.preventDefault(); m.pick(n, text, setText); setActive(0); }}
              onMouseEnter={() => setActive(i)}
              className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 transition-colors ${i === active ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-accent'}`}
            >
              <span className="truncate flex-1">{nodeMentionTitle(n)}</span>
              {n.data.stepKind && <span className="text-2xs text-muted-foreground shrink-0">{n.data.stepKind}</span>}
            </Button>
          ))}
        </PopoverContent>
      </Popover>
      {m.mentions.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1.5">
          {m.mentions.map((x) => (
            <span key={x.nodeId} className="inline-flex items-center gap-1 text-2xs bg-primary/10 text-primary rounded-full pl-2 pr-1 py-0.5 max-w-[220px]" data-mention-chip>
              <AtSign size={10} strokeWidth={2} className="shrink-0" />
              <span className="truncate">{x.title}</span>
              <Button variant="ghost"
                onMouseDown={(e) => { e.preventDefault(); m.remove(x.nodeId); }}
                className="w-3.5 h-3.5 hover:bg-primary/20 shrink-0"
              >
                <X size={9} strokeWidth={2.5} />
              </Button>
            </span>
          ))}
        </div>
      )}
    </>
  );
}
