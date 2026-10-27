import { useMemo } from 'react';
import { ChevronRight } from 'lucide-react';
import { useStore } from '../../store';
import { buildContext, referenceBlockContent } from '../../store/context-builder';
import type { ContextPartition } from '../../lib/graph';
import { conclusionOf } from '../../lib/turn-insight';
import { countTokens } from '../../utils';
import { useT, fmt } from '../../i18n';
import { isViewerMode } from '../../lib/viewer';
import type { ThoughtData, ThoughtNode } from '../../types';
import { Button } from '../ui/button';
import { LINE_BODY_CLASS, LINE_CLASS } from './line';

// Everything the next question carries, folded into one line above the
// question: the turns before this one and their size. Open, it reads in the
// order the prompt is assembled — upstream files, materials and references,
// the conversation — so what is read here is what the model reads. Files
// handed down from upstream can be left out here; a turn, a material or a
// reference is one click from being the panel's. The compiled messages
// themselves are one more fold away.

const kTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

const ROW = 'grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-baseline gap-2 text-xs';
const TAG = 'rounded-sm bg-muted px-1.5 text-2xs text-muted-foreground';
const TOK = 'font-mono text-2xs text-muted-foreground/70';
const NAME = 'h-auto min-w-0 justify-start truncate p-0 text-xs font-normal text-muted-foreground hover:bg-transparent hover:text-foreground';
const ROLE_STYLES: Record<string, string> = {
  system: 'bg-primary/10 text-primary',
  user: 'bg-muted text-muted-foreground',
  assistant: 'bg-border/60 text-muted-foreground',
};

function materialLabel(node: ThoughtNode): string {
  const kind = node.data.stepKind;
  if (kind === 'file') return (node.data.attachments || []).map((a) => a.name).join(', ');
  if (kind === 'link') return node.data.linkTitle || node.data.linkUrl || '';
  return node.data.question;
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-2xs text-muted-foreground/70">{title}</div>
      {children}
    </div>
  );
}

export default function ContextHistory({ nodeId, data, partition, onJump }: {
  nodeId: string;
  data: ThoughtData;
  partition: ContextPartition;
  onJump: (id: string) => void;
}) {
  const t = useT();
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const staleIds = useStore((s) => s.staleIds);
  const getInheritedAttachments = useStore((s) => s.getInheritedAttachments);
  const toggleExcludeAttachment = useStore((s) => s.toggleExcludeAttachment);
  const setEdgeStructural = useStore((s) => s.setEdgeStructural);

  const ctx = useMemo(() => {
    const { messages, layerTokens } = buildContext(nodeId, nodes, edges, undefined, undefined, undefined, staleIds);
    const items = messages.map((m) => ({ role: m.role, head: m.content.replace(/\s+/g, ' ').slice(0, 90), tokens: countTokens(m.content) }));
    const background = layerTokens.material + layerTokens.reference;
    return { items, total: items.reduce((s, m) => s + m.tokens, 0), heavy: background > 1000 && background > layerTokens.chain };
  }, [nodeId, nodes, edges, staleIds]);

  const inherited = getInheritedAttachments(nodeId);
  const ancestors = partition.mainline.slice(0, -1);
  if (ancestors.length === 0 && partition.materials.length === 0 && partition.references.length === 0 && inherited.length === 0) return null;

  const excludeSet = new Set(data.excludedAttachmentIds || []);
  const includeSet = new Set(data.includedAttachmentIds || []);
  const tok = <span className={`tabular-nums ${ctx.heavy ? 'text-warning' : ''}`}>{kTok(ctx.total)}</span>;
  const label = ancestors.length === 0 ? t('transcript.context') : ancestors.length === 1 ? t('transcript.earlierOne') : t('transcript.earlier');
  const [before, after] = fmt(label, { n: ancestors.length, tok: '\u0000' }).split('\u0000');
  const stale = (id: string) => staleIds.includes(id) && <span className="size-1.5 shrink-0 rounded-full bg-warning" title={t('node.staleBadge')} />;

  return (
    <div data-panel-section="context">
      <details className="group/earlier" data-transcript-earlier>
        <summary className={LINE_CLASS} title={t('transcript.earlierTitle')}>
          <span className="truncate">{before}{tok}{after}</span>
          <ChevronRight size={14} strokeWidth={1.75} className="shrink-0 transition-transform group-open/earlier:rotate-90" />
        </summary>
        <div className={`${LINE_BODY_CLASS} flex flex-col gap-3`}>
          {ctx.heavy && <p className="text-xs leading-relaxed text-warning" data-context-heavy>{t('transcript.heavy')}</p>}

          {inherited.length > 0 && (
            <Group title={t('transcript.groupFiles')}>
              {inherited.map(({ attachment: att, sourceNodeId, sourceQuestion, excludedByAncestor }) => {
                const self = excludeSet.has(att.id);
                const overridden = includeSet.has(att.id);
                const off = self || (excludedByAncestor && !overridden);
                return (
                  <div key={att.id} className={ROW} data-context-file={att.id}>
                    <span className={TAG}>{t('transcript.fileTag')}</span>
                    <Button variant="ghost" className={`${NAME} ${off ? 'line-through opacity-60' : ''}`} onClick={() => onJump(sourceNodeId)} title={`← ${sourceQuestion.slice(0, 80)}`}>
                      <span className="truncate">{att.name}</span>
                    </Button>
                    <span className={TOK}>{kTok(countTokens(att.extractedText || (att.type.startsWith('text/') ? att.content : '')) || Math.ceil(att.size / 4))}</span>
                    {isViewerMode ? <span /> : (
                      <Button variant="ghost" size="xs"
                        onClick={() => toggleExcludeAttachment(nodeId, att.id, excludedByAncestor)}
                        className={`h-auto px-1 py-0 text-2xs font-normal ${off ? 'text-warning hover:text-warning' : overridden ? 'text-success hover:text-success' : 'text-muted-foreground'}`}
                        title={excludedByAncestor && !overridden ? t('attach.titleExcludedUpstream') : overridden ? t('attach.titleReIncluded') : self ? t('attach.titleInclude') : t('attach.titleExclude')}
                        data-context-file-toggle
                      >
                        {excludedByAncestor && !overridden && !self ? t('attach.btnUpstream') : overridden ? t('attach.btnReIncluded') : self ? t('attach.btnExcluded') : t('transcript.exclude')}
                      </Button>
                    )}
                  </div>
                );
              })}
            </Group>
          )}

          {(partition.materials.length > 0 || partition.references.length > 0) && (
            <Group title={t('transcript.groupMaterials')}>
              {partition.materials.map((m) => {
                const name = materialLabel(m);
                return (
                  <div key={m.id} className={ROW}>
                    <span className={TAG}>{t('transcript.materialTag')}</span>
                    <Button variant="ghost" className={NAME} onClick={() => onJump(m.id)} title={name}>
                      <span className="truncate">{name.slice(0, 120)}</span>
                    </Button>
                    <span />
                    <span />
                  </div>
                );
              })}
              {partition.references.map((ref) => (
                <div key={ref.edge.id} className={ROW}>
                  <span className={TAG}>{t('transcript.referenceTag')}</span>
                  <Button variant="ghost" className={NAME} onClick={() => onJump(ref.source.id)} title={ref.source.data.question}>
                    <span className="truncate">{ref.source.data.question.slice(0, 120)}</span>
                    {stale(ref.source.id)}
                  </Button>
                  <span className={TOK}>{kTok(countTokens(referenceBlockContent(ref)))}</span>
                  {isViewerMode ? <span /> : (
                    <Button variant="ghost" size="xs" onClick={() => setEdgeStructural(ref.edge.id, true)} title={t('edge.depthToggleTitle')}
                      className="h-auto px-1 py-0 text-2xs font-normal text-muted-foreground">
                      {t('transcript.refFull')}
                    </Button>
                  )}
                </div>
              ))}
            </Group>
          )}

          {ancestors.length > 0 && (
            <Group title={t('transcript.groupConversation')}>
              {ancestors.map((a) => {
                const conclusion = a.data.response ? conclusionOf(a.data.response) : '';
                return (
                  <Button key={a.id} variant="ghost" onClick={() => onJump(a.id)} data-earlier-turn={a.id}
                    className="h-auto w-full flex-col items-stretch gap-1 whitespace-normal rounded-lg px-1.5 py-1.5 text-left font-normal opacity-70 hover:opacity-100">
                    <span className="flex items-center justify-end gap-1.5">
                      {stale(a.id)}
                      <span className="max-w-[86%] rounded-2xl bg-foreground/5 px-3 py-1.5 text-xs text-foreground line-clamp-2 break-words">{a.data.question}</span>
                    </span>
                    {conclusion && <span className="text-xs leading-relaxed text-muted-foreground line-clamp-2 break-words">{conclusion}</span>}
                  </Button>
                );
              })}
            </Group>
          )}

          <details className="group/raw">
            <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-xs text-muted-foreground/70 hover:text-muted-foreground [&::-webkit-details-marker]:hidden" data-context-raw>
              {t('transcript.rawMessages')} · {ctx.items.length}
              <ChevronRight size={12} strokeWidth={1.75} className="transition-transform group-open/raw:rotate-90" />
            </summary>
            <div className="mt-1.5 flex flex-col">
              {ctx.items.map((m, i) => (
                <div key={i} className="flex items-start gap-2 border-b border-border/50 py-1 text-xs last:border-0">
                  <span className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-2xs ${ROLE_STYLES[m.role] ?? 'bg-muted text-muted-foreground'}`}>{m.role}</span>
                  <span className="min-w-0 flex-1 break-words leading-snug text-muted-foreground">{m.head}…</span>
                  <span className={TOK}>{m.tokens}</span>
                </div>
              ))}
            </div>
          </details>
        </div>
      </details>
    </div>
  );
}
