import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Globe, GraduationCap, MessageCircleQuestion, SquareTerminal, Trash2 } from 'lucide-react';
import type { ThoughtNode as ThoughtNodeType, ThoughtData } from '../types';
import { useStore } from '../store';
import { effectiveRoles } from '../lib/role-templates';
import { useUiStore } from '../lib/ui-store';
import { useI18n, useT } from '../i18n';
import { Button } from './ui/button';

// Orchestration-view card. A paradigm has exactly two node kinds:
//   human  — a dialogue turn: the human asks here. The card holds optional
//            guidance for the operator; it instantiates as an EMPTY question
//            node awaiting the human.
//   prompt — a machine processing step: a fixed prompt (plus optional role)
//            applied to whatever flows in from upstream nodes.
// Flow patterns (fan-out, review, synthesis) are drawn as graph shape, not
// node kinds. No LLM ever runs in this view. Legacy v1 kinds render as
// 'prompt' but keep their stored data for instantiation.

const KINDS: { kind: 'human' | 'prompt'; icon: typeof SquareTerminal; labelKey: string }[] = [
  { kind: 'human', icon: MessageCircleQuestion, labelKey: 'paradigm.kind.human' },
  { kind: 'prompt', icon: SquareTerminal, labelKey: 'paradigm.kind.prompt' },
];

const KIND_STYLES: Record<'human' | 'prompt', string> = {
  human: 'border-edge-explore/70',
  prompt: 'border-primary/50',
};

export default function ParadigmNode({ id, data }: NodeProps<ThoughtNodeType>) {
  const t = useT();
  const lang = useI18n((s) => s.lang);
  const deleteNode = useStore((s) => s.deleteNode);
  const patch = (p: Partial<ThoughtData>) => {
    useStore.setState((state) => ({
      nodes: state.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...p } } : n)),
    }));
  };
  const kind: 'human' | 'prompt' = data.stepKind === 'human' ? 'human' : 'prompt';

  return (
    <div className={`bg-card border-2 border-dashed rounded-xl w-[440px] shadow-sm ${KIND_STYLES[kind]}`}>
      <Handle type="target" position={Position.Top} id="top" className="!bg-muted-foreground !w-3.5 !h-3.5 !border-2 !border-white tdag-handle" />
      {/* Invisible side anchors: watch/reference edges route through these */}
      <Handle type="target" position={Position.Left} id="left" isConnectable={false} className="!bg-transparent !w-0 !h-0 !border-0 !pointer-events-none" style={{ top: '40%' }} />
      <Handle type="source" position={Position.Right} id="branch" isConnectable={false} className="!bg-transparent !w-0 !h-0 !border-0 !pointer-events-none" style={{ top: '50%' }} />

      {/* header: drag handle + kind switcher + delete */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border/60 cursor-grab active:cursor-grabbing drag-handle">
        <div className="flex gap-1">
          {KINDS.map(({ kind: k, icon: Icon, labelKey }) => (
            <Button variant="ghost"
              key={k}
              onClick={(e) => { e.stopPropagation(); patch({ stepKind: k }); }}
              title={t(labelKey as Parameters<typeof t>[0])}
              size="icon-sm"
              className={`${
                kind === k ? (k === 'human' ? 'bg-edge-explore/15 text-edge-explore' : 'bg-primary/10 text-primary') : 'text-muted-foreground hover:bg-accent'
              }`}
            >
              <Icon size={14} strokeWidth={1.75} />
            </Button>
          ))}
          <span className={`text-2xs self-center ml-1 uppercase tracking-wider font-medium ${kind === 'human' ? 'text-edge-explore' : 'text-primary/80'}`}>
            {t(`paradigm.kind.${kind}` as Parameters<typeof t>[0])}
          </span>
        </div>
        <Button variant="ghost" size="icon-sm"
          onClick={(e) => { e.stopPropagation(); deleteNode(id); }}
          className="text-muted-foreground hover:text-destructive/90"
        >
          <Trash2 size={13} strokeWidth={1.75} />
        </Button>
      </div>

      <div className="px-4 py-3 space-y-2.5 nodrag">
        {/* step title */}
        <input
          type="text"
          value={data.question}
          onChange={(e) => patch({ question: e.target.value })}
          placeholder={t('paradigm.titlePlaceholder')}
          className="w-full text-sm font-semibold text-foreground bg-transparent focus:outline-none placeholder-muted-foreground"
        />

        {/* body: THE prompt (machine) or operator guidance (human) — one
            field; a persona is just the opening lines of the prompt */}
        <textarea
          value={data.instruction ?? ''}
          onChange={(e) => patch({ instruction: e.target.value })}
          placeholder={t(kind === 'human' ? 'paradigm.humanHintPlaceholder' : 'paradigm.promptPlaceholder')}
          rows={kind === 'human' ? 3 : 4}
          className={`w-full text-xs text-foreground bg-background border border-border rounded-lg px-2.5 py-2 focus:outline-none focus:ring-1 resize-y leading-relaxed nowheel ${
            kind === 'human' ? 'focus:ring-edge-explore/40' : 'focus:ring-ring/40'
          }`}
        />

        {/* persona chips: prepend a template persona into the prompt */}
        {kind === 'prompt' && (
          <div className="flex flex-wrap gap-1" title={t('paradigm.insertPersona')}>
            {effectiveRoles(lang, useUiStore.getState().roleLib).map((tpl) => (
              <Button variant="ghost" size="xs"
                key={tpl.id}
                onClick={() => patch({ instruction: `${tpl.prompt}\n${data.instruction ?? ''}` })}
                className="text-2xs bg-muted hover:bg-primary/10 hover:text-primary text-muted-foreground"
              >
                + {tpl.name}
              </Button>
            ))}
          </div>
        )}

        {/* per-step search permissions — carried into the instantiated run */}
        {kind === 'prompt' && (
          <div className="flex items-center gap-1.5">
            <Button variant="ghost"
              onClick={() => patch({ webSearch: !data.webSearch })}
              title={data.webSearch ? t('toolbar.webSearch') : t('toolbar.webSearchOff')}
              className={`text-2xs px-2 py-1 rounded-full transition-colors flex items-center gap-1 ${
                data.webSearch ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground hover:bg-border'
              }`}
            >
              <Globe size={12} strokeWidth={1.75} /> {t('paradigm.webSearch')}
            </Button>
            <Button variant="ghost"
              onClick={() => patch({ scholarSearch: !data.scholarSearch })}
              title={data.scholarSearch ? t('toolbar.scholarSearch') : t('toolbar.scholarSearchOff')}
              className={`text-2xs px-2 py-1 rounded-full transition-colors flex items-center gap-1 ${
                data.scholarSearch ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground hover:bg-border'
              }`}
            >
              <GraduationCap size={12} strokeWidth={1.75} /> {t('paradigm.scholarSearch')}
            </Button>
          </div>
        )}
      </div>

      <Handle type="source" position={Position.Bottom} id="continue" className="!bg-muted-foreground !w-3.5 !h-3.5 !border-2 !border-white tdag-handle" />
    </div>
  );
}
