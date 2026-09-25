import { useEffect, useRef, useState } from 'react';
import { Handle, NodeResizeControl, Position, useReactFlow, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { BookOpen, ExternalLink, FileText, Link2, Link2Off, Loader2, MoveDiagonal2, Paperclip, RefreshCw, StickyNote, Trash2, X } from 'lucide-react';
import type { ThoughtNode as ThoughtNodeType } from '../types';
import { useStore } from '../store';
import { useZoomTier } from '../lib/use-map-mode';
import { useUiStore } from '../lib/ui-store';
import { useEntranceFade } from '../lib/use-entrance-fade';
import { triggerParadigmCascade } from '../store/streaming';
import { extractImage, fetchLinkIntoNode, ingestFiles } from '../lib/content';
import { FILE_INPUT_ACCEPT } from '../lib/attachments';
import { Markdown } from './Markdown';
import { countTokens } from '../utils';
import { useT, fmt } from '../i18n';
import { isViewerMode } from '../lib/viewer';
import { Button } from './ui/button';
import { FaceBody, FaceName, FarMark } from './app/NodeFace';
import { farPriority, type FaceTone } from '../lib/node-face';
import { Textarea } from './ui/textarea';

// Content nodes: canvas material, not turns. A note (markdown), a file
// (attachments) or a link (stamped web snapshot) that never generates — it
// feeds downstream context ONLY via its outgoing edge (the One Rule), so it
// has no target handle: nothing flows INTO material. autoLayout never moves
// them. In a paradigm, an empty content node is a MATERIAL SLOT: the
// cascade waits until the human fills it, like a human turn.

export default function ContentNode({ id, data, selected }: NodeProps<ThoughtNodeType>) {
  const t = useT();
  const deleteNode = useStore((s) => s.deleteNode);
  const removeAttachment = useStore((s) => s.removeAttachment);
  const selectedNodeId = useStore((s) => s.selectedNodeId);
  const setSelectedNodeId = useStore((s) => s.setSelectedNodeId);
  // Blindspot #8: on-canvas ≠ in-context — unlinked material is decoration
  const isLinked = useStore((s) => s.edges.some((e) => e.source === id));
  // Wiring material happens mostly from the overview — grow the handle there
  const zoomTier = useZoomTier();
  const zoomedOut = zoomTier !== 'work';
  const rf = useReactFlow();
  const nodePos = useStore((s) => { const n = s.nodes.find((x) => x.id === id); return n ? n.position : null; });
  // Does this material actually reach any context? Unwired is the silent
  // trap a card must confess to (One Rule's honest face). Every wire out of
  // a material carries its whole text, whatever an old canvas drew it as.
  const wireCount = useStore((s) => s.edges.filter((e) => e.source === id).length);
  const glyphTier = zoomTier === 'glyph';
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => { updateNodeInternals(id); }, [glyphTier, id, updateNodeInternals]);
  // entrance, played once — the selected glow shares the `animation`
  // property, and handing it back and forth replayed the fade
  const entrance = useEntranceFade();

  const kind = data.stepKind === 'file' ? 'file' : data.stepKind === 'link' ? 'link' : 'note';
  const [editing, setEditing] = useState(!isViewerMode && kind === 'note' && !data.question);
  const [draft, setDraft] = useState(data.question);
  const [openExtract, setOpenExtract] = useState<string | null>(null); // attId whose extraction panel is open
  const setAttachmentData = useStore((s) => s.setAttachmentData);
  const fileRef = useRef<HTMLInputElement>(null);

  // Blindspot #2: undo history is a full-graph snapshot — commit the note
  // ONCE on blur, never per keystroke.
  const commit = () => {
    setEditing(false);
    const text = draft.trim() === '' ? '' : draft;
    if (text === data.question) return;
    useStore.getState().pushHistory();
    useStore.setState((s) => ({
      nodes: s.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, question: text, tokenCount: countTokens(text) } } : n)),
    }));
    // Filling a material slot advances a waiting paradigm run (idempotent)
    triggerParadigmCascade(useStore.getState, id);
  };

  const attachments = data.attachments || [];
  const linkLoading = kind === 'link' && !data.question && !data.linkTitle?.startsWith('⚠');

  // Clip provenance: an edge-less clip finds its source through anchor.attId
  const clipAnchor = data.anchor?.attId ? data.anchor : undefined;
  const clipSource = useStore((s) => {
    if (!clipAnchor) return null;
    const src = s.nodes.find((n) => n.data.attachments?.some((a) => a.id === clipAnchor.attId));
    if (!src) {
      // link-snapshot clips carry the link NODE's id (snapshots aren't attachments)
      const link = s.nodes.find((n) => n.id === clipAnchor.attId && n.data.stepKind === 'link');
      return link ? [link.id, link.data.linkTitle || link.data.linkUrl || ''].join(String.fromCharCode(0)) : null;
    }
    const att = src.data.attachments!.find((a) => a.id === clipAnchor.attId)!;
    return `${src.id}\u0000${att.name}`;
  });
  const [clipSourceId, clipSourceName] = clipSource ? clipSource.split('\u0000') : [null, null];
  const openClipSource = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!clipAnchor || !clipSourceId) return;
    useUiStore.getState().setReaderNodeId(clipSourceId, { page: clipAnchor.page });
  };
  const linkDomain = (() => { try { return new URL(data.linkUrl ?? '').hostname; } catch { return data.linkUrl ?? ''; } })();

  const headerIcon = kind === 'note'
    ? <StickyNote size={14} strokeWidth={1.75} className="text-warning shrink-0" />
    : kind === 'link'
      ? <Link2 size={14} strokeWidth={1.75} className="text-primary shrink-0" />
      : <Paperclip size={14} strokeWidth={1.75} className="text-muted-foreground shrink-0" />;

  // The face grammar every card shares (lib/node-face): a square shape,
  // the material's name, what it is, and — its conclusion — whether it
  // reaches any context at all.
  const tone: FaceTone = kind === 'note' ? 'warning' : kind === 'link' ? 'primary' : 'muted';
  const materialName = kind === 'file'
    ? (attachments[0]?.name ?? t('glyph.file'))
    : kind === 'link'
      ? (data.linkTitle && !data.linkTitle.startsWith('⚠') ? data.linkTitle : linkDomain || t('glyph.link'))
      : (data.summaryTopics?.[0] ?? t('glyph.note'));
  const fileKind = (a: (typeof attachments)[number]) => {
    const ext = a.name.includes('.') ? a.name.split('.').pop()!.toUpperCase() : a.type;
    return a.numPages != null ? `${ext} · ${a.numPages}p` : ext;
  };
  const materialLine = kind === 'file'
    ? (data.summaries?.[0] ?? (attachments.length === 1 ? fileKind(attachments[0]) : attachments.map((a) => a.name).join(' · ')))
    : (kind === 'link' ? (data.summaries?.[0] ?? data.question) : data.question).replace(/^#+\s*/gm, '');
  const wireLine = wireCount === 0 ? t('content.wireNone') : fmt(t('content.wireFull'), { n: wireCount });
  const openMaterial = (e: React.MouseEvent) => {
    e.stopPropagation();
    // documents open where they are read; notes fly to working scale
    if (kind === 'file' || kind === 'link') useUiStore.getState().setReaderNodeId(id);
    else rf.setCenter((nodePos?.x ?? 0) + 200, (nodePos?.y ?? 0) + 120, { zoom: 1, duration: 300 });
  };

  if (glyphTier) {
    // Far: the name row's square grown into a dot, the name beside it — in
    // the same fixed box a conversation node uses at this tier (a box with
    // no height leaves React Flow measuring its anchors off the old size).
    return (
      <div className={`drag-handle cursor-grab active:cursor-grabbing relative w-full h-32 min-w-[340px] ${selectedNodeId === id ? 'glyph-selected' : ''}`}
        onClick={() => setSelectedNodeId(id)} data-glyph-node
        onDoubleClick={openMaterial}
        title={`${t(kind === 'file' ? 'glyph.file' : kind === 'link' ? 'glyph.link' : 'glyph.note')}\n${materialName}`}>
        <FarMark shape="square" tone={tone} name={materialName} state={null}
          priority={farPriority({ selected: selectedNodeId === id, state: null, material: true })} />
        <Handle type="source" position={Position.Bottom} id="continue" className="!bg-muted-foreground !border-2 !border-white tdag-handle !w-6 !h-6 tdag-handle-lg" style={{ left: '50%', top: '50%', bottom: 'auto' }} />
        {/* reader-grown branches leave through this handle — without it,
            React Flow drops those edges entirely at far zoom */}
        <Handle type="source" position={Position.Right} id="branch" isConnectable={false} className="!bg-transparent !w-0 !h-0 !border-0 !pointer-events-none" style={{ top: '50%', left: '50%', right: 'auto' }} />
      </div>
    );
  }

  if (zoomedOut) {
    // Map: the same face as a folded card, drawn larger. A document keeps
    // its cover under the face — a page reads as a page at any distance.
    const cover = kind === 'file' ? attachments.find((a) => a.type.startsWith('image/') || a.pageImages?.[0]) : undefined;
    const coverSrc = cover && (cover.type.startsWith('image/') ? `data:${cover.type};base64,${cover.content}` : `data:image/png;base64,${cover.pageImages![0]}`);
    return (
      <div
        className={`content-card map-node relative w-full h-full min-w-[340px] flex flex-col overflow-hidden rounded-xl shadow-sm border-2 ${
          kind === 'note' ? 'bg-warning/10 border-warning/30' : 'bg-card border-border'
        } ${selectedNodeId === id ? 'ring-2 ring-primary selected-glow' : ''}`}
        style={{ '--k': 1.75 } as React.CSSProperties}
        onClick={() => setSelectedNodeId(id)}
        onDoubleClick={openMaterial}
      >
        <div className="tdag-face drag-handle cursor-grab active:cursor-grabbing shrink-0 animate-in fade-in-0 duration-150">
          <FaceName shape="square" tone={tone} name={materialName} marks={[]} state={null} />
          <FaceBody question={materialLine} placeholder={t('content.notePlaceholder')} conclusion={wireLine} />
        </div>
        {coverSrc && <img src={coverSrc} alt={cover!.name} className="flex-1 min-h-0 w-full object-cover object-top border-t border-border/60" />}
        <Handle type="source" position={Position.Bottom} id="continue" className="!bg-muted-foreground !border-2 !border-white tdag-handle !w-6 !h-6 tdag-handle-lg" />
        <Handle type="source" position={Position.Right} id="branch" isConnectable={false} className="!bg-transparent !w-0 !h-0 !border-0 !pointer-events-none" style={{ top: '50%' }} />
      </div>
    );
  }

  return (
    <div
      className={`content-card w-full h-full min-w-[340px] flex flex-col rounded-xl shadow-sm border-2 ${entrance} transition-colors duration-200 ${
        kind === 'note' ? 'bg-warning/10 border-warning/30' : 'bg-card border-border'
      } ${selectedNodeId === id ? 'ring-2 ring-primary selected-glow' : ''}`}
      onClick={() => setSelectedNodeId(id)}
      onDoubleClick={() => {
        // notes keep dblclick=edit (on the body); files and links open the reader
        if (kind !== 'note') useUiStore.getState().setReaderNodeId(id);
      }}
      onDrop={async (e) => {
        if (kind !== 'file' || isViewerMode) return;
        e.preventDefault();
        e.stopPropagation();
        await ingestFiles(id, e.dataTransfer.files);
      }}
      onDragOver={(e) => { if (kind === 'file') { e.preventDefault(); e.stopPropagation(); } }}
    >
      {/* Pure source: material feeds context, nothing flows INTO it — hence no target handle. */}

      {/* header: drag handle + identity + linked state + delete */}
      <div className={`flex items-center justify-between px-4 py-2 border-b cursor-grab active:cursor-grabbing drag-handle shrink-0 ${kind === 'note' ? 'border-warning/30' : 'border-border/70'}`}>
        <div className="flex items-center gap-2 min-w-0">
          {headerIcon}
          {kind === 'link'
            ? <span className="text-2xs text-muted-foreground truncate">{linkDomain}</span>
            : <span className="text-2xs text-muted-foreground font-mono">{kind === 'note' ? `${data.tokenCount} tok` : `${attachments.length}`}</span>}
          {clipSourceName && (
            <Button variant="ghost" size="xs"
              onClick={openClipSource}
              title={t('content.clipSourceTitle')}
              data-clip-source
              className="text-2xs font-mono text-edge-explore bg-edge-explore/10 hover:bg-edge-explore/20 truncate max-w-[180px] shrink"
            >
              {clipSourceName} &middot; p.{clipAnchor!.page}
            </Button>
          )}
          {!isLinked && (
            <span className="text-2xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full flex items-center gap-1 shrink-0" title={t('content.unlinkedTitle')}>
              <Link2Off size={11} strokeWidth={1.75} /> {t('content.unlinked')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button variant="ghost" size="icon-sm"
            onClick={(e) => { e.stopPropagation(); useUiStore.getState().setReaderNodeId(id); }}
            title={t('reader.open')}
            className="text-muted-foreground hover:text-primary"
          >
            <BookOpen strokeWidth={1.75} />
          </Button>
          {kind === 'link' && data.linkUrl && (
            <a
              href={data.linkUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              title={t('content.linkOpen')}
              className="text-muted-foreground hover:text-primary rounded-full w-6 h-6 flex items-center justify-center transition-colors"
            >
              <ExternalLink size={13} strokeWidth={1.75} />
            </a>
          )}
          {!isViewerMode && <Button variant="ghost" size="icon-sm"
            onClick={(e) => { e.stopPropagation(); deleteNode(id); }}
            className="text-muted-foreground hover:text-destructive/90"
          >
            <Trash2 strokeWidth={1.75} />
          </Button>}
        </div>
      </div>

      {/* Body: grows with content by default; when the card is resized the
          body becomes the scroll region (wheel scrolls text, not zoom) */}
      <div className="px-4 py-3 nodrag flex-1 min-h-0 overflow-y-auto nowheel">
        {kind === 'note' && (
          editing ? (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => { if (e.key === 'Escape') commit(); }}
              placeholder={t('content.notePlaceholder')}
              rows={5}
              autoFocus
              className="w-full h-full min-h-[7rem] bg-transparent text-sm text-foreground resize-none focus:outline-none placeholder-muted-foreground leading-relaxed nopan nowheel"
            />
          ) : (
            <div
              onDoubleClick={() => { if (isViewerMode) return; setDraft(data.question); setEditing(true); }}
              className="markdown-body text-sm text-foreground leading-relaxed cursor-text nopan"
              title={t('content.noteEditTitle')}
            >
              {data.question
                ? <Markdown>{data.question}</Markdown>
                : <span className="text-muted-foreground italic text-xs">{t('content.notePlaceholder')}</span>}
            </div>
          )
        )}

        {kind === 'link' && (
          linkLoading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-2">
              <Loader2 size={14} strokeWidth={1.75} className="animate-spin text-primary" /> {t('content.linkFetching')}
            </div>
          ) : (
            <div className="space-y-1.5">
              {data.linkTitle && (
                <div className={`text-sm font-semibold leading-snug ${data.linkTitle.startsWith('⚠') ? 'text-destructive' : 'text-foreground'}`}>{data.linkTitle}</div>
              )}
              {data.linkTitle?.startsWith('⚠') && data.linkUrl && (
                <Button variant="ghost" size="sm"
                  onClick={(e) => { e.stopPropagation(); void fetchLinkIntoNode(id, data.linkUrl!); }}
                  className="text-xs bg-muted hover:bg-border text-muted-foreground"
                >
                  <RefreshCw strokeWidth={1.75} /> {t('common.retry')}
                </Button>
              )}
              {data.question && (
                <div className="text-xs text-muted-foreground leading-relaxed max-h-[200px] overflow-y-auto nopan nowheel whitespace-pre-wrap">
                  {data.question.slice(0, 1200)}{data.question.length > 1200 ? '…' : ''}
                </div>
              )}
              {data.linkFetchedAt && (
                <div className="text-2xs text-muted-foreground font-mono">
                  {fmt(t('content.linkStamp'), { date: data.linkFetchedAt.slice(0, 10) })} · {data.tokenCount} tok
                </div>
              )}
            </div>
          )
        )}

        {kind === 'file' && (
          <div className="space-y-1.5">
            {attachments.map((att) => (
              att.type.startsWith('image/') ? (
                // Pasted images live on the canvas as the image itself —
                // resize the card (right edge) to scale it
                <div key={att.id} className="relative group">
                  <img
                    src={`data:${att.type};base64,${att.content}`}
                    alt={att.name}
                    title={att.extractedText ? att.extractedText.slice(0, 400) : undefined}
                    className="w-full rounded-lg border border-border/60"
                  />
                  {att.isExtracting ? (
                    <span className="absolute bottom-1.5 left-1.5 text-2xs bg-foreground/60 text-white px-2 py-0.5 rounded-full flex items-center gap-1">
                      <Loader2 size={11} strokeWidth={1.75} className="animate-spin" /> {t('content.extracting')}
                    </span>
                  ) : att.extractedText ? (
                    <Button variant="ghost" size="xs"
                      onClick={(e) => { e.stopPropagation(); setOpenExtract(openExtract === att.id ? null : att.id); }}
                      title={t('content.editExtractTitle')}
                      className="absolute bottom-1.5 left-1.5 text-2xs bg-foreground/60 hover:bg-foreground/80 text-white"
                    >
                      {t('content.extracted')}{att.extractedBy ? ` · ${att.extractedBy}` : ''} ▾
                    </Button>
                  ) : (
                    <Button variant="ghost" size="xs"
                      onClick={(e) => { e.stopPropagation(); void extractImage(id, att.id); }}
                      title={t('content.reExtractTitle')}
                      className="absolute bottom-1.5 left-1.5 text-2xs bg-foreground/60 hover:bg-foreground/80 text-white opacity-0 group-hover:opacity-100"
                    >
                      <RefreshCw strokeWidth={1.75} /> {t('content.reExtract')}
                    </Button>
                  )}
                  <Button variant="ghost" size="icon-sm"
                    onClick={(e) => { e.stopPropagation(); removeAttachment(id, att.id); }}
                    className="absolute top-1.5 right-1.5 bg-foreground/60 text-white opacity-0 group-hover:opacity-100"
                  >
                    <X strokeWidth={2} />
                  </Button>
                  {/* Extraction panel: SEE what the model read, fix it, or redo it —
                      this text is what downstream context receives as the image's index */}
                  {openExtract === att.id && (
                    <div className="mt-1.5 space-y-1.5" onClick={(e) => e.stopPropagation()}>
                      <Textarea
                        defaultValue={att.extractedText}
                        onBlur={(e) => {
                          if (e.target.value !== att.extractedText) {
                            useStore.getState().pushHistory();
                            setAttachmentData(id, att.id, { extractedText: e.target.value });
                          }
                        }}
                        rows={7}
                        className="w-full resize-y leading-relaxed nopan nowheel"
                      />
                      <div className="flex items-center justify-between">
                        <span className="text-2xs text-muted-foreground font-mono">{att.extractedBy}</span>
                        <Button variant="ghost" size="xs"
                          onClick={() => { setOpenExtract(null); void extractImage(id, att.id); }}
                          className="text-2xs bg-muted hover:bg-border text-muted-foreground"
                        >
                          <RefreshCw strokeWidth={1.75} /> {t('content.reExtractAgain')}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ) : att.type === 'application/pdf' && att.pageImages?.[0] ? (
                // PDF wears its first page as a cover — same form as pasted
                // images, so material reads as material at a glance
                <div key={att.id} className="relative group">
                  <img
                    src={`data:image/png;base64,${att.pageImages[0]}`}
                    alt={att.name}
                    className="w-full rounded-lg border border-border/60"
                  />
                  <span className="absolute bottom-1.5 left-1.5 max-w-[85%] text-2xs bg-foreground/60 text-white px-2 py-0.5 rounded-full flex items-center gap-1">
                    <FileText size={11} strokeWidth={1.75} className="shrink-0" />
                    <span className="truncate">{att.name}</span>
                    {att.numPages != null && <span className="shrink-0 opacity-80">· {att.numPages}p</span>}
                  </span>
                  <Button variant="ghost" size="icon-sm"
                    onClick={(e) => { e.stopPropagation(); removeAttachment(id, att.id); }}
                    className="absolute top-1.5 right-1.5 bg-foreground/60 text-white opacity-0 group-hover:opacity-100"
                  >
                    <X strokeWidth={2} />
                  </Button>
                </div>
              ) : (
                <div key={att.id} className="flex items-center gap-2 bg-muted rounded-lg px-2.5 py-2 group">
                  <FileText size={16} strokeWidth={1.75} className="text-muted-foreground shrink-0" />
                  <span className="text-xs text-foreground flex-1 truncate">{att.name}</span>
                  {att.isExtracting && <span className="text-2xs text-primary shrink-0">{t('attach.extracting')}</span>}
                  {att.numPages != null && <span className="text-2xs text-muted-foreground shrink-0">{att.numPages}p</span>}
                  <Button variant="ghost"
                    onClick={(e) => { e.stopPropagation(); removeAttachment(id, att.id); }}
                    className="text-muted-foreground hover:text-destructive/90 opacity-0 group-hover:opacity-100 shrink-0"
                  >
                    <X strokeWidth={1.75} />
                  </Button>
                </div>
              )
            ))}
            <Button variant="ghost"
              onClick={() => fileRef.current?.click()}
              className={`w-full border-2 border-dashed border-border hover:border-primary/40 hover:bg-primary/5 rounded-lg text-xs text-muted-foreground hover:text-muted-foreground transition-colors ${attachments.length === 0 ? 'py-6' : 'py-2'}`}
            >
              {t('attach.upload')}
              {attachments.length === 0 && <span className="block text-2xs mt-1">{t('attach.types')}</span>}
            </Button>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept={FILE_INPUT_ACCEPT}
              className="hidden"
              onChange={(e) => { if (e.target.files) void ingestFiles(id, e.target.files); e.target.value = ''; }}
            />
          </div>
        )}
        {(
          <div className="px-1 pt-2" data-wire-status>
            {wireCount === 0 ? (
              <p className="text-2xs text-warning leading-snug">{t('content.wireNone')}</p>
            ) : (
              <p className="text-2xs text-muted-foreground leading-snug">{fmt(t('content.wireFull'), { n: wireCount })}</p>
            )}
          </div>
        )}
      </div>

      {/* Corner resize: width scales images, height turns the body into a
          scroll region for long material */}
      {selected && (
        <NodeResizeControl
          position="bottom-right"
          minWidth={320}
          maxWidth={860}
          minHeight={120}
          style={{ background: 'transparent', border: 'none', width: 18, height: 18 }}
        >
          <MoveDiagonal2 size={13} strokeWidth={1.75} className="text-muted-foreground absolute bottom-0.5 right-0.5" />
        </NodeResizeControl>
      )}

      <Handle type="source" position={Position.Bottom} id="continue" className={`!bg-muted-foreground !border-2 !border-white tdag-handle ${zoomedOut ? '!w-6 !h-6 tdag-handle-lg' : '!w-3.5 !h-3.5'}`} />
      {/* Invisible side anchor so material references can exit sideways */}
      <Handle type="source" position={Position.Right} id="branch" isConnectable={false} className="!bg-transparent !w-0 !h-0 !border-0 !pointer-events-none" style={{ top: '50%' }} />
    </div>
  );
}
