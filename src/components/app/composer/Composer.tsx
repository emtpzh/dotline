import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronUp, FileText, GitBranch, Loader2, Paperclip, X } from 'lucide-react';
import { useStore } from '../../../store';
import { useUiStore } from '../../../lib/ui-store';
import { buildContext } from '../../../store/context-builder';
import { processFile, FILE_INPUT_ACCEPT } from '../../../lib/attachments';
import { countTokens, isImeComposing } from '../../../utils';
import { useT, fmt } from '../../../i18n';
import { useMentions } from '../../../lib/mentions';
import { useContinuity } from '../../../lib/use-continuity';
import { offersAccess, runtimeOf } from '../../../lib/agents/runtimes';
import { describeModel } from '../../../lib/use-models';
import { cn } from '../../../lib/utils';
import type { Attachment } from '../../../types';
import type { RunIntent } from '../../../lib/run-intent';
import SearchToggles from '../SearchToggles';
import MentionSurface from '../NodeMention';
import { Button } from '../../ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover';
import { ModelMenu, AccessMenu, SendButton, RunStatus } from './RunControls';
import { useAskThisIntent, useFollowUpIntent, useRootIntent, type IntentPatch } from './run-intent-hooks';

// The one box a question is written in. Every surface that asks something
// new (the landing, the focus panel, the answer viewer, the reader) is this
// component; what differs is where the question lands (`target`) and how
// much of the box shows (`density`). Revising an asked question, answering
// an agent mid-turn and writing a role are not asks — they keep their own
// editors (see QuestionSection, ApprovalCard, RoleEditor).
//
//   root      a new line on the canvas
//   ask-this  the question of a card still waiting for one (typed into it)
//   child     a new card under `parentId`, optionally about a passage
//
//   full      attachments, @-mentions, the context preview, run controls
//   compact   the text, the passage, one line saying what it runs on

export type ComposerTarget =
  | { kind: 'root' }
  | { kind: 'ask-this'; nodeId: string }
  | { kind: 'child'; parentId: string };

const ROLE_STYLES: Record<string, string> = {
  system: 'bg-primary/10 text-primary',
  user: 'bg-muted text-muted-foreground',
  assistant: 'bg-border/60 text-muted-foreground',
};

/** The passage a question is about: the same quiet bar everywhere. */
export function PassageQuote({ text, onClear, className = '' }: { text: string; onClear?: () => void; className?: string }) {
  const t = useT();
  return (
    <div className={`flex items-start gap-1.5 border-l-2 border-edge-explore bg-edge-explore/10 rounded-r py-1.5 pl-3 pr-1.5 text-xs text-muted-foreground ${className}`}
      title={`${t('node.exploringFrom')}\n“${text}”`} data-passage>
      <GitBranch size={13} strokeWidth={1.75} className="mt-px shrink-0 text-edge-explore" />
      <span className="flex-1 min-w-0 line-clamp-2 break-words">{text}</span>
      {onClear && (
        <Button variant="ghost" size="icon-xs" onClick={onClear} title={t('common.cancel')} aria-label={t('common.cancel')}
          className="shrink-0 text-muted-foreground hover:text-foreground">
          <X strokeWidth={2} />
        </Button>
      )}
    </div>
  );
}

function defaultDraftKey(target: ComposerTarget): string {
  if (target.kind === 'root') return 'root';
  if (target.kind === 'ask-this') return `ask:${target.nodeId}`;
  return `follow:${target.parentId}`;
}

export default function Composer({
  target,
  density = 'full',
  placeholder,
  passage,
  onClearPassage,
  draftKey,
  focusKey,
  autoFocus = true,
  minRows = 1,
  blocked,
  onSent,
  onFocusNode,
  className = '',
  boxClassName = '',
}: {
  target: ComposerTarget;
  density?: 'full' | 'compact';
  placeholder?: string;
  /** The passage the question is about (branchContext). With `onClearPassage`
      it can be taken off; without, it belongs to the node (an explore card). */
  passage?: string;
  onClearPassage?: () => void;
  /** Where the draft is kept so it survives remounts; `null` keeps it local.
      Defaults per target (`ask:<id>` is shared with the canvas card). */
  draftKey?: string | null;
  /** Focus the box on mount and whenever this changes. */
  focusKey?: unknown;
  autoFocus?: boolean;
  minRows?: number;
  /** Sending is held (the line above is still generating, say). */
  blocked?: boolean;
  /** After a send: the card the question went into. */
  onSent?: (nodeId: string | null) => void;
  onFocusNode?: (id: string) => void;
  className?: string;
  boxClassName?: string;
}) {
  const t = useT();
  const full = density === 'full';
  const askThisId = target.kind === 'ask-this' ? target.nodeId : null;
  const parentId = target.kind === 'child' ? target.parentId : null;
  const node = useStore((s) => (askThisId ? s.nodes.find((n) => n.id === askThisId) : undefined));
  const isHuman = node?.data.stepKind === 'human';
  const converge = node?.data.converge;
  // a human turn records words, a merge / weave runs its own prompt: neither
  // picks a model here (the card hides the same)
  const runControls = !isHuman && !converge;
  const canAttach = full && runControls;
  const canMention = full && target.kind !== 'root' && runControls;
  // an unasked merge / weave may go with nothing typed: the default run
  const emptyOk = !!converge;
  const fixedPassage = askThisId ? node?.data.branchContext : undefined;
  const shownPassage = fixedPassage || passage || '';

  // ── draft ──
  const key = draftKey === undefined ? defaultDraftKey(target) : draftKey;
  const stored = useUiStore((s) => (key ? s.drafts[key] : undefined));
  const [local, setLocal] = useState(() => (key ? useUiStore.getState().drafts[key] ?? '' : ''));
  const text = key ? stored ?? '' : local;
  const setText = (v: string) => {
    if (key) useUiStore.getState().setDraft(key, v);
    else setLocal(v);
  };

  // ── what it runs on ──
  const root = useRootIntent();
  const follow = useFollowUpIntent(parentId);
  const askThis = useAskThisIntent(askThisId ?? '');
  const run: { intent: RunIntent; onIntent: (p: IntentPatch) => void; changed: string[] } =
    target.kind === 'child' ? { intent: follow.intent, onIntent: follow.onIntent, changed: follow.changed }
    : target.kind === 'ask-this' ? { intent: askThis.intent, onIntent: askThis.onIntent, changed: [] }
    : { intent: root.intent, onIntent: root.onIntent, changed: [] };

  // ── attachments staged for the send ──
  const [pending, setPending] = useState<Attachment[]>([]);
  const [inheritAttachments, setInheritAttachments] = useState(true);
  const fileRef = useRef<HTMLInputElement>(null);
  const addFiles = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      await processFile(file, {
        add: (att) => setPending((prev) => [...prev, att]),
        update: (attId, patch) => setPending((prev) => prev.map((a) => (a.id === attId ? { ...a, ...patch } : a))),
      });
    }
  };
  const extracting = pending.some((a) => a.isExtracting);

  const mention = useMentions(askThisId ?? parentId ?? undefined);
  const mentionIds = mention.mentions.map((x) => x.nodeId);

  // Whether a child goes on in the agent session above — decided the way
  // the send will decide it, said while it can still be changed
  const session = useContinuity(parentId, { model: run.intent.model, branchContext: passage || undefined, attachments: pending, mentions: mentionIds });

  // ── what the send will carry (full, off a node) ──
  const nodes = useStore((s) => s.nodes);
  const edges = useStore((s) => s.edges);
  const staleIds = useStore((s) => s.staleIds);
  const contextOf = askThisId ?? parentId;
  const [previewOpen, setPreviewOpen] = useState(false);
  const preview = useMemo(() => {
    if (!full || !contextOf) return null;
    const { messages, images, layerTokens } = buildContext(contextOf, nodes, edges, shownPassage || undefined, undefined, undefined, staleIds);
    const items = messages.map((m) => ({ role: m.role, head: m.content.replace(/\s+/g, ' ').slice(0, 90), tokens: countTokens(m.content) }));
    const background = layerTokens.material + layerTokens.reference;
    return {
      items, layerTokens,
      // background outweighing the live conversation is worth an amber flag
      backgroundHeavy: background > 1000 && background > layerTokens.chain,
      totalTokens: items.reduce((s, m) => s + m.tokens, 0),
      fileCount: messages.filter((m) => /^\[(PDF|File): /.test(m.content)).length + images.length,
    };
  }, [full, contextOf, nodes, edges, staleIds, shownPassage]);

  // ── focus ──
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const autoGrow = (el: HTMLTextAreaElement) => {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, full ? 200 : 160)}px`;
  };
  useEffect(() => {
    if (!autoFocus) return;
    const timer = setTimeout(() => {
      const el = taRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
      autoGrow(el); // restored drafts need their height back
    }, 100);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refocus on the key, not on every render
  }, [focusKey, autoFocus]);

  const canSend = !blocked && !extracting && (!!text.trim() || emptyOk);

  const send = () => {
    if (!canSend) return;
    const q = text.trim();
    const store = useStore.getState();
    const before = new Set(store.nodes.map((n) => n.id));
    let landed: string | null = null;
    if (target.kind === 'ask-this') {
      if (isHuman) {
        store.submitHumanTurn(target.nodeId, q);
      } else {
        askThis.commit();
        for (const att of pending) store.addAttachment(target.nodeId, att);
        store.editQuestion(target.nodeId, q, { mentions: mentionIds });
      }
      landed = target.nodeId;
    } else {
      store.addQuestion(q, {
        parentId: parentId ?? undefined,
        branchContext: passage || undefined,
        initialAttachments: pending.length > 0 ? pending : undefined,
        ...(target.kind === 'child' ? {
          excludeAllInheritedAttachments: !inheritAttachments,
          mentions: mentionIds,
          intent: run.intent,
        } : {}),
      });
      landed = useStore.getState().nodes.find((n) => !before.has(n.id))?.id ?? null;
    }
    mention.clear();
    setText('');
    setPending([]);
    follow.reset();
    setPreviewOpen(false);
    onClearPassage?.();
    if (taRef.current) taRef.current.style.height = 'auto';
    onSent?.(landed);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (canMention && mention.invokeKey(e)) return; // the @-picker owns the key
    // Enter sends, Shift+Enter breaks the line; an IME-confirming Enter
    // (picking a pinyin candidate) never sends
    if (e.key === 'Enter' && !e.shiftKey && !isImeComposing(e)) {
      e.preventDefault();
      send();
    }
  };

  // compact: what it runs on, one quiet line; the menus on request
  const [settingsOpen, setSettingsOpen] = useState(false);
  const webOn = useUiStore((s) => s.webSearchEnabled);
  const summary = [
    describeModel(run.intent.model, run.intent.effort, { compact: true }),
    offersAccess(run.intent.model) ? t(run.intent.access === 'write' ? 'access.write' : 'access.read')
      : !runtimeOf(run.intent.model) && webOn ? t('paradigm.webSearch') : null,
  ].filter(Boolean).join(' · ') || t('ask.settingsTitle');

  const accessOrSearch = offersAccess(run.intent.model)
    ? <AccessMenu value={run.intent.access ?? 'read'} onChange={(access) => run.onIntent({ access })} changed={run.changed.includes('access')} />
    : !runtimeOf(run.intent.model) && <SearchToggles size={full ? 15 : 14} model={run.intent.model} />;
  const modelMenu = (
    <ModelMenu intent={run.intent} onIntent={run.onIntent}
      changed={run.changed.includes('model') || run.changed.includes('effort')}
      offerRuntimes={target.kind === 'child'} session={target.kind === 'child' ? session : undefined} />
  );

  return (
    <div className={`relative ${className}`} data-composer-target={target.kind}>
      {/* Context summary line — opens what will actually be sent */}
      {preview && runControls && (
        <Popover open={previewOpen} onOpenChange={setPreviewOpen}>
          <PopoverTrigger
            render={<Button variant="ghost" size="xs" className="text-2xs text-muted-foreground hover:text-muted-foreground mb-1" title={t('followup.previewTitle')} />}
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
              {preview.backgroundHeavy && <p className="text-2xs text-warning mt-0.5">{t('followup.layerWarning')}</p>}
            </div>
            {preview.items.length === 0 ? (
              <p className="px-3 py-2 text-xs text-muted-foreground italic">{t('followup.empty')}</p>
            ) : (
              preview.items.map((m, i) => (
                <div key={i} className="flex items-start gap-2 px-3 py-1.5 text-xs border-b border-border/50 last:border-0">
                  <span className={`shrink-0 px-1.5 py-0.5 rounded font-mono text-2xs ${ROLE_STYLES[m.role] ?? 'bg-muted text-muted-foreground'}`}>{m.role}</span>
                  <span className="flex-1 text-muted-foreground leading-snug break-words">{m.head}…</span>
                  <span className="shrink-0 text-2xs text-muted-foreground font-mono">{m.tokens}</span>
                </div>
              ))
            )}
          </PopoverContent>
        </Popover>
      )}

      {/* Typed into a card that waits: say so — the same box asks on once it has an answer */}
      {askThisId && full && (
        <p className="mb-1 flex items-center gap-1.5 px-1 text-2xs font-medium text-primary" data-composer-lands="this">
          <span className="size-1.5 rounded-full bg-primary" aria-hidden />
          {t('composer.landsHere')}
        </p>
      )}

      {shownPassage && <PassageQuote text={shownPassage} onClear={fixedPassage ? undefined : onClearPassage} className="mb-1.5" />}

      {pending.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-1.5">
          {pending.map((att) => (
            <span key={att.id} className="inline-flex items-center gap-1 text-2xs bg-muted text-muted-foreground pl-1.5 pr-0.5 py-0.5 rounded-full">
              {att.thumbnailUrl
                ? <img src={att.thumbnailUrl} className="size-4 rounded-sm object-cover" alt="" />
                : <FileText size={11} strokeWidth={1.75} />}
              <span className="max-w-[140px] truncate">{att.name}</span>
              {att.isExtracting && <Loader2 size={11} className="animate-spin text-primary" />}
              <Button variant="ghost" size="icon-xs" onClick={() => setPending((prev) => prev.filter((a) => a.id !== att.id))}
                aria-label={t('common.delete')} className="text-muted-foreground hover:text-destructive/90">
                <X strokeWidth={2} />
              </Button>
            </span>
          ))}
        </div>
      )}

      {canMention && <MentionSurface m={mention} text={text} setText={setText} />}
      <div
        className={cn('rounded-xl border border-border bg-card px-3 pt-2.5 pb-1.5 transition-shadow focus-within:border-primary/50 focus-within:ring-1 focus-within:ring-ring/30', boxClassName)}
        onDrop={canAttach ? (e) => { e.preventDefault(); e.stopPropagation(); void addFiles(e.dataTransfer.files); } : undefined}
        onDragOver={canAttach ? (e) => e.preventDefault() : undefined}
        data-composer={target.kind === 'root' ? 'landing' : target.kind === 'ask-this' ? 'ask' : 'panel'}
      >
        <textarea
          ref={(el) => { taRef.current = el; if (canMention) mention.bindAnchor(el); }}
          rows={minRows}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (canMention) mention.track(e.target.value, e.target.selectionStart ?? e.target.value.length);
            autoGrow(e.target);
          }}
          onKeyDown={onKeyDown}
          onPaste={canAttach ? (e) => {
            // TEXT WINS: office copies carry text plus a bitmap of the
            // selection — only image-only clipboards become attachments
            if (e.clipboardData?.getData('text/plain').trim()) return;
            const files = Array.from(e.clipboardData?.files ?? []);
            if (files.length > 0) { e.preventDefault(); void addFiles(files); }
          } : undefined}
          placeholder={placeholder ?? t('common.followUp')}
          className={`w-full bg-transparent text-sm text-foreground placeholder-muted-foreground focus:outline-none resize-none leading-relaxed overflow-y-auto ${full ? 'max-h-[200px]' : 'max-h-[160px]'}`}
          data-question-input={askThisId ? '' : undefined}
        />
        {canAttach && (
          <input ref={fileRef} type="file" accept={FILE_INPUT_ACCEPT} multiple className="hidden"
            onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ''; }} />
        )}
        <div className="mt-1 flex items-center gap-0.5 min-w-0">
          {canAttach && (
            <Button variant="ghost" size="icon-sm"
              onClick={() => fileRef.current?.click()}
              title={t('followup.attach')}
              className="rounded-full text-muted-foreground hover:text-primary shrink-0"
            >
              <Paperclip strokeWidth={1.75} />
            </Button>
          )}
          {runControls && full && accessOrSearch}
          {runControls && !full && (settingsOpen ? (
            <>
              {accessOrSearch}
              {modelMenu}
            </>
          ) : (
            <Button variant="ghost" size="xs"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setSettingsOpen(true)}
              title={t('ask.settingsTitle')}
              className="-ml-1 min-w-0 max-w-[75%] font-normal text-muted-foreground hover:text-foreground"
              data-ask-settings
            >
              <span className="truncate">{summary}</span>
            </Button>
          ))}
          <span className="flex-1" />
          {!full && <span className="shrink-0 text-2xs text-muted-foreground mr-1.5">{t('ask.enterToSend')}</span>}
          {runControls && full && modelMenu}
          <SendButton onClick={send} disabled={!canSend} session={target.kind === 'child' ? session : undefined}
            title={extracting ? t('landing.extracting') : undefined} />
        </div>
      </div>
      {full && target.kind === 'child' && (
        <>
          <div className="mt-1.5">
            <RunStatus session={session} intent={run.intent} base={follow.base} onIntent={run.onIntent} onLocate={onFocusNode} />
          </div>
          <label className="mt-1.5 flex items-center gap-2 px-1 text-xs text-muted-foreground cursor-pointer select-none w-fit">
            <input type="checkbox" checked={inheritAttachments} onChange={(e) => setInheritAttachments(e.target.checked)} className="rounded border-border text-primary focus:ring-ring w-3 h-3" />
            {t('followup.inheritAttachments')}
          </label>
        </>
      )}
    </div>
  );
}
