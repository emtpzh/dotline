import { useState, useRef, useEffect, useMemo } from 'react';
import { ChevronUp, GitBranch, Paperclip, Send, X } from 'lucide-react';
import { useStore } from '../../store';
import { isImeComposing } from '../../utils';
import { useUiStore } from '../../lib/ui-store';
import { buildContext } from '../../store/context-builder';
import { processFile, FILE_INPUT_ACCEPT } from '../../lib/attachments';
import SearchToggles from '../app/SearchToggles';
import type { Attachment } from '../../types';
import { countTokens } from '../../utils';
import { useT, fmt } from '../../i18n';
import MentionSurface from '../app/NodeMention';
import { useMentions } from '../../lib/mentions';
import { Button } from '../ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';

const ROLE_STYLES: Record<string, string> = {
  system: 'bg-primary/10 text-primary',
  user: 'bg-muted text-muted-foreground',
  assistant: 'bg-border/60 text-muted-foreground',
};

export default function FollowUpInput({
  nodeId,
  branchContext,
  onClearBranchContext,
}: {
  nodeId: string;
  /** Selected response text staged as context: submitting creates an orange explore branch. */
  branchContext: string;
  onClearBranchContext: () => void;
}) {
  const addQuestion = useStore((s) => s.addQuestion);
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const t = useT();

  // Draft survives node switches (the component remounts per node) and
  // panel close/reopen; cleared on submit.
  const draftKey = `follow:${nodeId}`;
  const [continueInput, setContinueInputState] = useState(() => useUiStore.getState().drafts[draftKey] ?? '');
  const setContinueInput = (v: string) => {
    setContinueInputState(v);
    useUiStore.getState().setDraft(draftKey, v);
  };
  const [continueInheritAttachments, setContinueInheritAttachments] = useState(true);
  const mention = useMentions(nodeId);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState<Attachment[]>([]);
  const continueRef = useRef<HTMLTextAreaElement>(null);
  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };
  const fileRef = useRef<HTMLInputElement>(null);

  const addFiles = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      await processFile(file, {
        add: (att) => setPendingAttachments((prev) => [...prev, att]),
        update: (attId, patch) => setPendingAttachments((prev) => prev.map((a) => (a.id === attId ? { ...a, ...patch } : a))),
      });
    }
  };

  // What would a follow-up from this node actually send? Makes the core
  // "you control the context" promise visible before asking. Messages come
  // out in layer order (materials → references → conversation), so the
  // flat list below reads grouped; the summary line shows the composition.
  const staleIds = useStore((s) => s.staleIds);
  const preview = useMemo(() => {
    const { messages, images, layerTokens } = buildContext(nodeId, nodes, edges, undefined, undefined, undefined, staleIds);
    const items = messages.map((m) => ({
      role: m.role,
      head: m.content.replace(/\s+/g, ' ').slice(0, 90),
      tokens: countTokens(m.content),
    }));
    const background = layerTokens.material + layerTokens.reference;
    return {
      items,
      layerTokens,
      // Background outweighing the live conversation is worth an amber flag
      backgroundHeavy: background > 1000 && background > layerTokens.chain,
      totalTokens: items.reduce((s, m) => s + m.tokens, 0),
      fileCount: messages.filter((m) => /^\[(PDF|File): /.test(m.content)).length + images.length,
    };
  }, [nodeId, nodes, edges, staleIds]);

  // Auto-focus continue input when switching nodes or staging selected text
  useEffect(() => {
    const t = setTimeout(() => {
      if (continueRef.current) {
        continueRef.current.focus();
        autoGrow(continueRef.current); // restored drafts need their height back
      }
    }, 100);
    return () => clearTimeout(t);
     
  }, [nodeId, branchContext]);

  const submit = () => {
    if (!continueInput.trim()) return;
    addQuestion(continueInput.trim(), {
      parentId: nodeId,
      branchContext: branchContext || undefined,
      excludeAllInheritedAttachments: !continueInheritAttachments,
      initialAttachments: pendingAttachments.length > 0 ? pendingAttachments : undefined,
      mentions: mention.mentions.map((x) => x.nodeId),
    });
    mention.clear();
    setContinueInput('');
    setPendingAttachments([]);
    setPreviewOpen(false);
    onClearBranchContext();
  };

  return (
    <div className="relative shrink-0 px-3 pb-3 pt-1">
      <div className="panel-card px-3.5 pt-2 pb-2.5">
      {/* Context summary line — opens what will actually be sent */}
      <Popover open={previewOpen} onOpenChange={setPreviewOpen}>
        <PopoverTrigger
          render={
            <Button variant="ghost" size="xs" className="text-2xs text-muted-foreground hover:text-muted-foreground mb-1.5" title={t('followup.previewTitle')} />
          }
        >
          <ChevronUp size={12} strokeWidth={1.75} className={`transition-transform ${previewOpen ? 'rotate-180' : ''}`} />
          {fmt(t('followup.willSend'), { n: preview.totalTokens, m: preview.items.length })}{preview.fileCount > 0 ? fmt(t('followup.files'), { k: preview.fileCount }) : ''}
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-[22rem] max-w-[90vw] max-h-72 overflow-y-auto gap-0 p-0 py-1.5">
          <div className="px-3 py-1.5 border-b border-border">
            <span className="text-2xs text-muted-foreground font-medium">{t('followup.contextTitle')}</span>
            <span className={`text-2xs ml-2 ${preview.backgroundHeavy ? 'text-warning' : 'text-muted-foreground'}`}>
              {fmt(t('followup.layerSummary'), { a: preview.layerTokens.material, b: preview.layerTokens.reference, c: preview.layerTokens.chain })}
            </span>
            {preview.backgroundHeavy && (
              <p className="text-2xs text-warning mt-0.5">{t('followup.layerWarning')}</p>
            )}
          </div>
          {preview.items.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground italic">{t('followup.empty')}</p>
          ) : (
            preview.items.map((m, i) => (
              <div key={i} className="flex items-start gap-2 px-3 py-1.5 text-xs border-b border-border/50 last:border-0">
                <span className={`shrink-0 px-1.5 py-0.5 rounded font-mono text-2xs ${ROLE_STYLES[m.role] ?? 'bg-muted text-muted-foreground'}`}>
                  {m.role}
                </span>
                <span className="flex-1 text-muted-foreground leading-snug break-words">{m.head}…</span>
                <span className="shrink-0 text-2xs text-muted-foreground font-mono">{m.tokens}</span>
              </div>
            ))
          )}
        </PopoverContent>
      </Popover>

      {/* Selected text staged as branch context — submit explores from it */}
      {branchContext && (
        <div className="text-xs pl-3 py-1.5 pr-2 mb-1.5 border-l-2 border-edge-explore bg-edge-explore/10 rounded-r text-muted-foreground flex items-start gap-1.5">
          <span className="text-edge-explore font-medium shrink-0"><GitBranch size={13} strokeWidth={1.75} className="inline" /> {t('node.exploringFrom')}</span>
          <span className="flex-1 min-w-0 truncate">&ldquo;{branchContext.slice(0, 90)}{branchContext.length > 90 ? '…' : ''}&rdquo;</span>
          <Button variant="ghost" onClick={onClearBranchContext} className="text-muted-foreground hover:text-destructive/90 shrink-0">
            <X strokeWidth={2} />
          </Button>
        </div>
      )}

      {/* Attachments staged for the NEXT follow-up node */}
      {pendingAttachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-1.5">
          {pendingAttachments.map((att) => (
            <span key={att.id} className="inline-flex items-center gap-1 text-2xs bg-muted text-muted-foreground px-2 py-1 rounded-full">
              <Paperclip size={11} strokeWidth={1.75} />
              <span className="max-w-[140px] truncate">{att.name}</span>
              {att.isExtracting && <span className="text-muted-foreground">…</span>}
              <Button variant="ghost" onClick={() => setPendingAttachments((prev) => prev.filter((a) => a.id !== att.id))} className="text-muted-foreground hover:text-destructive/90">
                <X strokeWidth={2} />
              </Button>
            </span>
          ))}
        </div>
      )}

      <MentionSurface m={mention} text={continueInput} setText={setContinueInput} />
      <div
        className="flex items-end gap-2 bg-muted rounded-xl px-4 py-2.5 transition-shadow focus-within:ring-1 focus-within:ring-ring/40"
        onDrop={(e) => { e.preventDefault(); e.stopPropagation(); void addFiles(e.dataTransfer.files); }}
        onDragOver={(e) => e.preventDefault()}
      >
        <textarea
          ref={(el) => { continueRef.current = el; mention.bindAnchor(el); }}
          rows={1}
          value={continueInput}
          onChange={(e) => { setContinueInput(e.target.value); mention.track(e.target.value, e.target.selectionStart ?? e.target.value.length); autoGrow(e.target); }}
          onKeyDown={(e) => {
            if (mention.invokeKey(e)) return; // @-picker owns the key
            // Enter sends, Shift+Enter breaks the line; an IME-confirming
            // Enter (picking a pinyin candidate) never submits.
            if (e.key === 'Enter' && !e.shiftKey && !isImeComposing(e)) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={t('common.followUp')}
          className="flex-1 bg-transparent text-sm text-foreground placeholder-muted-foreground focus:outline-none resize-none leading-relaxed max-h-[160px] overflow-y-auto"
          onPaste={(e) => {
            // TEXT WINS: Office copies carry text plus a bitmap of the
            // selection — only image-only clipboards become attachments.
            if (e.clipboardData?.getData('text/plain').trim()) return;
            const files = Array.from(e.clipboardData?.files ?? []);
            if (files.length > 0) { e.preventDefault(); void addFiles(files); }
          }}
        />
        <input ref={fileRef} type="file" accept={FILE_INPUT_ACCEPT} multiple className="hidden"
          onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ''; }} />
        <SearchToggles />
        <Button variant="ghost" size="icon"
          onClick={() => fileRef.current?.click()}
          title={t('followup.attach')}
          className="text-muted-foreground hover:text-primary shrink-0 hover:bg-border"
        >
          <Paperclip strokeWidth={1.75} />
        </Button>
        <Button variant="ghost" size="icon-sm"
          onClick={submit}
          disabled={!continueInput.trim()}
          className="text-muted-foreground hover:text-primary shrink-0 hover:bg-border"
        >
          <Send strokeWidth={1.75} />
        </Button>
      </div>
      <div className="flex gap-4 mt-1.5 px-1">
        <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
          <input type="checkbox" checked={continueInheritAttachments} onChange={(e) => setContinueInheritAttachments(e.target.checked)} className="rounded border-border text-primary focus:ring-ring w-3 h-3" />
          {t('followup.inheritAttachments')}
        </label>
      </div>
      </div>
    </div>
  );
}
