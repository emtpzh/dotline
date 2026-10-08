import { useEffect, useRef, useState } from 'react';
import { Handle, NodeResizeControl, Position, useReactFlow, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { BookOpen, ExternalLink, FileText, Loader2, MoveDiagonal2, Plus, RefreshCw, X } from 'lucide-react';
import type { ThoughtNode as ThoughtNodeType } from '../types';
import { useStore } from '../store';
import { useZoomTier } from '../lib/use-map-mode';
import { useUiStore, toast } from '../lib/ui-store';
import { useEntranceFade } from '../lib/use-entrance-fade';
import { flyTo } from '../lib/motion';
import { triggerParadigmCascade } from '../store/streaming';
import { fetchLinkIntoNode, ingestFiles } from '../lib/content';
import { FILE_INPUT_ACCEPT } from '../lib/attachments';
import { Markdown } from './Markdown';
import { countTokens, isImeComposing } from '../utils';
import { useT, fmt } from '../i18n';
import { isViewerMode } from '../lib/viewer';
import { Button } from './ui/button';
import { FaceBody, FaceName, FarMark } from './app/NodeFace';
import { farPriority, type FaceTone } from '../lib/node-face';

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
  const glyphTier = zoomTier === 'glyph';
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => { updateNodeInternals(id); }, [glyphTier, id, updateNodeInternals]);
  // entrance, played once — the selected glow shares the `animation`
  // property, and handing it back and forth replayed the fade
  const entrance = useEntranceFade();

  const kind = data.stepKind === 'file' ? 'file' : data.stepKind === 'link' ? 'link' : 'note';
  const [editing, setEditing] = useState(!isViewerMode && kind === 'note' && !data.question);
  const [draft, setDraft] = useState(data.question);
  const fileRef = useRef<HTMLInputElement>(null);
  const [isDropTarget, setIsDropTarget] = useState(false);
  // A link card made from the toolbar starts empty: its name slot is the
  // address box, and Enter fetches the page — written in place, like an
  // empty question card
  const linkDraft = kind === 'link' && !data.linkUrl;
  const [urlDraft, setUrlDraft] = useState('');
  const urlRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!linkDraft || isViewerMode) return;
    // React Flow mounts nodes hidden until measured: autoFocus is dropped
    const timer = setTimeout(() => urlRef.current?.focus(), 80);
    return () => clearTimeout(timer);
    // mount-only: a link card is empty exactly once, at creation
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const submitUrl = () => {
    let url = urlDraft.trim();
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    try { new URL(url); } catch { toast('info', t('content.linkUrlInvalid')); return; }
    useStore.getState().pushHistory();
    useStore.setState((st) => ({ nodes: st.nodes.map((n) => (n.id === id ? { ...n, data: { ...n.data, linkUrl: url } } : n)) }));
    void fetchLinkIntoNode(id, url);
  };

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
  const linkLoading = kind === 'link' && !!data.linkUrl && !data.question && !data.linkTitle?.startsWith('⚠');

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

  // The face grammar every card shares (lib/node-face): a square shape in
  // the material's color, its name, a few plain words after it, and — the
  // one state material has — that no wire takes it anywhere.
  const tone: FaceTone = kind === 'note' ? 'warning' : kind === 'link' ? 'primary' : 'muted';
  const linkTitleOk = !!data.linkTitle && !data.linkTitle.startsWith('⚠');
  const materialName = kind === 'file'
    ? (attachments[0]?.name ?? t('glyph.file'))
    : kind === 'link'
      ? (linkTitleOk ? data.linkTitle! : linkDomain || t('glyph.link'))
      : (data.summaryTopics?.[0] ?? t('glyph.note'));
  const fileKind = (a: (typeof attachments)[number]) => (a.name.includes('.') ? a.name.split('.').pop()!.toUpperCase() : a.type);
  const materialLine = kind === 'file'
    ? (data.summaries?.[0] ?? (attachments.length === 1 ? fileKind(attachments[0]) : attachments.map((a) => a.name).join(' · ')))
    : (kind === 'link' ? (data.summaries?.[0] ?? data.question) : data.question).replace(/^#+\s*/gm, '');
  const placeholder = t(kind === 'link' ? 'content.linkUrlPlaceholder' : kind === 'file' ? 'attach.upload' : 'content.notePlaceholder');
  const extracting = attachments.some((a) => a.isExtracting);
  // words after the name: how many files, a lone document's kind and pages,
  // a link's site, a reading still running
  const tagText = kind === 'file'
    ? (attachments.length > 1
      ? fmt(t('content.fileCount'), { n: attachments.length })
      : attachments[0]?.numPages != null ? fmt(t('content.pages'), { ext: fileKind(attachments[0]), n: attachments[0].numPages }) : null)
    : kind === 'link' && linkTitleOk ? linkDomain : null;
  const tags = (tagText || extracting) ? (
    <>
      {tagText && <span className="tdag-tag" data-material-tag>{tagText}</span>}
      {extracting && <span className="tdag-tag">{t('content.extracting')}</span>}
    </>
  ) : null;
  const state = !isLinked && !linkDraft ? 'unlinked' as const : null;
  const openMaterial = (e: React.MouseEvent) => {
    e.stopPropagation();
    // documents open where they are read; notes fly to working scale
    if (kind === 'file' || kind === 'link') useUiStore.getState().setReaderNodeId(id);
    else void flyTo(rf, (nodePos?.x ?? 0) + 200, (nodePos?.y ?? 0) + 120, 1);
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
        className={`content-card map-node relative w-full h-full min-w-[340px] flex flex-col overflow-hidden rounded-xl shadow-sm border border-border bg-card ${selectedNodeId === id ? 'tdag-selected ring-2 ring-primary selected-glow' : ''}`}
        style={{ '--k': 1.75 } as React.CSSProperties}
        onClick={() => setSelectedNodeId(id)}
        onDoubleClick={openMaterial}
      >
        <div className="tdag-face drag-handle cursor-grab active:cursor-grabbing shrink-0 animate-in fade-in-0 duration-150">
          <FaceName shape="square" tone={tone} name={materialName} marks={[]} state={state} tags={tags} />
          <FaceBody question={materialLine} placeholder={placeholder} conclusion={null} />
        </div>
        {coverSrc && <img src={coverSrc} alt={cover!.name} className="flex-1 min-h-0 w-full object-cover object-top border-t border-border/60" />}
        <Handle type="source" position={Position.Bottom} id="continue" className="!bg-muted-foreground !border-2 !border-white tdag-handle !w-6 !h-6 tdag-handle-lg" />
        <Handle type="source" position={Position.Right} id="branch" isConnectable={false} className="!bg-transparent !w-0 !h-0 !border-0 !pointer-events-none" style={{ top: '50%' }} />
      </div>
    );
  }

  // Working-distance controls, on intent (canvas.css .tdag-hover): add a
  // file, read, open the page, delete
  const controls = (
    <span className="tdag-hover flex items-center gap-0.5 -my-1 -mr-2 shrink-0">
      {kind === 'file' && !isViewerMode && (
        <Button variant="ghost" size="icon-sm"
          onClick={(e) => { e.stopPropagation(); fileRef.current?.click(); }}
          title={t('content.addFile')}
          className="text-muted-foreground hover:text-foreground"
          data-add-file
        >
          <Plus strokeWidth={1.75} />
        </Button>
      )}
      {!linkDraft && (
        <Button variant="ghost" size="icon-sm"
          onClick={(e) => { e.stopPropagation(); useUiStore.getState().setReaderNodeId(id); }}
          title={t('reader.open')}
          className="text-muted-foreground hover:text-foreground"
        >
          <BookOpen strokeWidth={1.75} />
        </Button>
      )}
      {kind === 'link' && data.linkUrl && (
        <a
          href={data.linkUrl}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          title={t('content.linkOpen')}
          className="text-muted-foreground hover:text-foreground hover:bg-accent rounded-md size-7 flex items-center justify-center transition-colors"
        >
          <ExternalLink size={14} strokeWidth={1.75} />
        </a>
      )}
      {!isViewerMode && (
        <Button variant="ghost" size="icon-sm"
          onClick={(e) => { e.stopPropagation(); deleteNode(id); }}
          title={t('common.delete')}
          className="text-muted-foreground hover:text-destructive/90 hover:bg-destructive/10"
        >
          <X strokeWidth={1.75} />
        </Button>
      )}
    </span>
  );
  // one file of several can go on its own; a lone file goes with its card
  const removeOne = (attId: string) => attachments.length > 1 && (
    <Button variant="ghost" size="icon-sm"
      onClick={(e) => { e.stopPropagation(); removeAttachment(id, attId); }}
      title={t('common.delete')}
      className="absolute top-1.5 right-1.5 bg-foreground/60 text-white hover:bg-foreground/80 opacity-0 group-hover:opacity-100"
    >
      <X strokeWidth={2} />
    </Button>
  );

  return (
    <div
      className={`content-card relative w-full h-full min-w-[340px] flex flex-col rounded-xl shadow-sm border border-border bg-card ${entrance} transition-colors duration-200 ${
        selectedNodeId === id ? 'tdag-selected ring-2 ring-primary selected-glow' : ''} ${isDropTarget ? 'ring-2 ring-primary/50' : ''}`}
      onClick={() => setSelectedNodeId(id)}
      onDoubleClick={() => {
        // notes keep dblclick=edit (on the body); files and links open the reader
        if (kind !== 'note' && !linkDraft) useUiStore.getState().setReaderNodeId(id);
      }}
      onDrop={async (e) => {
        if (kind !== 'file' || isViewerMode) return;
        e.preventDefault();
        e.stopPropagation();
        setIsDropTarget(false);
        await ingestFiles(id, e.dataTransfer.files);
      }}
      onDragOver={(e) => { if (kind === 'file' && !isViewerMode) { e.preventDefault(); e.stopPropagation(); setIsDropTarget(true); } }}
      onDragLeave={() => setIsDropTarget(false)}
    >
      {/* Pure source: material feeds context, nothing flows INTO it — hence no target handle. */}

      {/* Name row: the same layer every card opens with */}
      {linkDraft ? (
        <div className="tdag-face tdag-l1 drag-handle cursor-grab active:cursor-grabbing shrink-0" data-tone={tone}>
          <span className="tdag-shape" data-shape="square" />
          <input
            ref={urlRef}
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !isImeComposing(e)) { e.preventDefault(); submitUrl(); } }}
            placeholder={t('content.linkUrlPlaceholder')}
            disabled={isViewerMode}
            className="flex-1 min-w-0 bg-transparent text-sm font-medium text-foreground placeholder:text-muted-foreground focus:outline-none nodrag nopan cursor-text"
            data-link-url-input
          />
          {controls}
        </div>
      ) : (
        <FaceName className="tdag-face drag-handle cursor-grab active:cursor-grabbing shrink-0"
          shape="square" tone={tone} name={materialName} marks={[]} state={state} tags={tags}
          stateMark={state ? <span className="tdag-state" data-state="unlinked" title={t('content.unlinkedTitle')}>{t('content.unlinked')}</span> : undefined}
          trailing={controls} />
      )}

      {/* Body: grows with content by default; when the card is resized the
          body becomes the scroll region (wheel scrolls text, not zoom) */}
      <div className="px-4 pt-2 pb-3 nodrag flex-1 min-h-0 overflow-y-auto nowheel">
        {/* where a clip was cut from: one quiet line, the page one click away */}
        {clipSourceName && (
          <div className="mb-2 flex items-center gap-2 min-w-0 border-l-2 border-edge-explore pl-2.5 text-xs text-muted-foreground" title={t('content.clipSourceTitle')} data-clip-source>
            <span className="truncate min-w-0">{clipSourceName}</span>
            <Button variant="ghost" size="xs"
              onClick={openClipSource}
              title={t('content.clipSourceTitle')}
              className="ml-auto h-5 shrink-0 px-1 text-2xs font-mono font-normal text-muted-foreground hover:text-foreground"
            >
              p.{clipAnchor!.page}
            </Button>
          </div>
        )}

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

        {kind === 'link' && !linkDraft && (
          linkLoading ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-1">
              <Loader2 size={14} strokeWidth={1.75} className="animate-spin text-primary" /> {t('content.linkFetching')}
            </div>
          ) : data.linkTitle?.startsWith('⚠') ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-destructive leading-snug flex-1 min-w-0">{data.linkTitle}</span>
              {data.linkUrl && !isViewerMode && (
                <Button variant="ghost" size="xs"
                  onClick={(e) => { e.stopPropagation(); void fetchLinkIntoNode(id, data.linkUrl!); }}
                  className="shrink-0 text-muted-foreground"
                >
                  <RefreshCw strokeWidth={1.75} /> {t('common.retry')}
                </Button>
              )}
            </div>
          ) : materialLine ? (
            // what the page says, four lines; the whole page is in the reader
            <div className="text-sm text-muted-foreground leading-relaxed line-clamp-4" data-link-excerpt>{materialLine}</div>
          ) : null
        )}

        {kind === 'file' && (
          <div className="space-y-1.5">
            {attachments.map((att) => (
              att.type.startsWith('image/') ? (
                // Pasted images live on the canvas as the image itself —
                // resize the card (right edge) to scale it; what was read
                // off it is the reader's (text view)
                <div key={att.id} className="relative group">
                  <img
                    src={`data:${att.type};base64,${att.content}`}
                    alt={att.name}
                    className="w-full rounded-lg border border-border/60"
                  />
                  {removeOne(att.id)}
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
                  {removeOne(att.id)}
                </div>
              ) : (
                <div key={att.id} className="relative flex items-center gap-2 bg-muted rounded-lg px-2.5 py-2 group">
                  <FileText size={16} strokeWidth={1.75} className="text-muted-foreground shrink-0" />
                  <span className="text-xs text-foreground flex-1 truncate">{att.name}</span>
                  {att.isExtracting && <span className="text-2xs text-primary shrink-0">{t('attach.extracting')}</span>}
                  {att.numPages != null && <span className="text-2xs text-muted-foreground shrink-0">{att.numPages}p</span>}
                  {attachments.length > 1 && (
                    <Button variant="ghost"
                      onClick={(e) => { e.stopPropagation(); removeAttachment(id, att.id); }}
                      title={t('common.delete')}
                      className="text-muted-foreground hover:text-destructive/90 opacity-0 group-hover:opacity-100 shrink-0"
                    >
                      <X strokeWidth={1.75} />
                    </Button>
                  )}
                </div>
              )
            ))}
            {/* the drop box only while the card is empty; after that, the
                name row's + and dropping onto the card add more */}
            {attachments.length === 0 && (
              <Button variant="ghost"
                onClick={() => fileRef.current?.click()}
                className="w-full h-auto py-6 flex-col border-2 border-dashed border-border hover:border-primary/40 hover:bg-primary/5 rounded-lg text-xs text-muted-foreground transition-colors"
              >
                {t('attach.upload')}
                <span className="block text-2xs">{t('attach.types')}</span>
              </Button>
            )}
          </div>
        )}
        {kind === 'file' && (
          <input
            ref={fileRef}
            type="file"
            multiple
            accept={FILE_INPUT_ACCEPT}
            className="hidden"
            onChange={(e) => { if (e.target.files) void ingestFiles(id, e.target.files); e.target.value = ''; }}
          />
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

      <Handle type="source" position={Position.Bottom} id="continue" className="!bg-muted-foreground !border-2 !border-white tdag-handle !w-3.5 !h-3.5" />
      {/* Invisible side anchor so material references can exit sideways */}
      <Handle type="source" position={Position.Right} id="branch" isConnectable={false} className="!bg-transparent !w-0 !h-0 !border-0 !pointer-events-none" style={{ top: '50%' }} />
    </div>
  );
}
