import { useState } from 'react';
import { ShieldAlert, MessageCircleQuestion, ChevronDown, ChevronRight } from 'lucide-react';
import { useT } from '../../i18n';
import { useStore } from '../../store';
import { answerApproval, type QuestionAnswer } from '../../lib/api';
import { allowLocation } from '../../lib/agents/agent-runtime';
import type { ApprovalRequest, ApprovalRecord } from '../../types';

// What an agent asks the person mid-turn, answered where the turn is shown:
// on the node. A node is one exchange with the agent, and the agent's
// questions are part of that exchange — so they map onto the node too.
// Four shapes, one card: a yes/no (an approval; the guard's questions add
// "allow this location"), a pick, a line, a text. The click is optimistic —
// controls lock at once; the runtime's answered frame moves the question
// into the node's record. `compact` is the canvas card; the focus panel
// shows the same with the full arguments available.

export function ApprovalCard({ nodeId, request, compact }: { nodeId: string; request: ApprovalRequest; compact?: boolean }) {
  const t = useT();
  const [showArgs, setShowArgs] = useState(false);
  const [text, setText] = useState(request.prefill ?? '');
  const busy = !!request.answered;
  const kind = request.kind ?? 'confirm';
  const isApproval = kind === 'confirm';

  const send = async (answer: QuestionAnswer, mark: ApprovalRequest['answered'], allowDir?: string) => {
    if (busy) return;
    if (allowDir) await allowLocation(allowDir);
    useStore.setState((s) => ({
      nodes: s.nodes.map((n) => n.id === nodeId
        ? { ...n, data: { ...n.data, pendingApprovals: (n.data.pendingApprovals ?? []).map((p) => p.id === request.id ? { ...p, answered: mark } : p) } }
        : n),
    }));
    const ok = await answerApproval(request, answer);
    if (!ok) {
      // nothing was waiting: the runtime withdrew the question or the turn ended
      useStore.setState((s) => ({
        nodes: s.nodes.map((n) => {
          if (n.id !== nodeId) return n;
          const rest = (n.data.pendingApprovals ?? []).filter((p) => p.id !== request.id);
          return { ...n, data: { ...n.data, pendingApprovals: rest.length ? rest : undefined } };
        }),
      }));
    }
  };

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  const btn = compact ? 'text-2xs px-2.5 py-1' : 'text-xs px-3 py-1.5';
  const primary = `${btn} text-white rounded-lg bg-accent hover:bg-accent-strong transition-colors disabled:opacity-50 whitespace-nowrap`;
  const secondary = `${btn} text-ink rounded-lg border border-line hover:bg-wash transition-colors disabled:opacity-50 whitespace-nowrap`;

  return (
    <div
      className={`rounded-xl border border-amber-400/60 bg-amber-50/80 dark:bg-amber-500/10 ${compact ? 'px-3 py-2.5' : 'px-4 py-3'}`}
      onClick={stop}
      onMouseDown={stop}
      onPointerDown={stop}
      data-approval-card={request.id}
      data-question-kind={kind}
    >
      <div className="flex items-center gap-2 text-xs font-semibold text-amber-800 dark:text-amber-300">
        {isApproval ? <ShieldAlert size={14} strokeWidth={1.75} className="shrink-0" /> : <MessageCircleQuestion size={14} strokeWidth={1.75} className="shrink-0" />}
        <span>{isApproval ? t('approval.title') : t('approval.askTitle')}</span>
        <span className="ml-auto font-mono font-normal text-2xs text-ink-faint truncate max-w-[40%]">{request.name}</span>
      </div>
      {(request.query || (isApproval && request.toolName)) && (
        <div className={`mt-1.5 ${isApproval ? 'font-mono' : ''} text-ink bg-card/70 rounded-md px-2 py-1.5 border border-line/60 whitespace-pre-wrap break-words ${compact ? 'text-2xs max-h-[72px] overflow-hidden' : 'text-xs'}`}>
          {showArgs && request.arguments ? request.arguments : (request.query || request.toolName)}
        </div>
      )}
      {request.reason && (
        <p className={`mt-1.5 text-ink-muted leading-relaxed [overflow-wrap:anywhere] ${compact ? 'text-2xs line-clamp-2' : 'text-xs'}`}>
          <span className="text-ink-faint">{t('approval.reason')} · </span>{request.reason}
        </p>
      )}

      {kind === 'select' && (
        <div className={`mt-2.5 flex flex-wrap items-center ${compact ? 'gap-1.5' : 'gap-2'}`}>
          {(request.options ?? []).map((o) => (
            <button key={o} onClick={() => void send({ value: o }, 'answered')} disabled={busy} className={secondary} data-question-option={o}>{o}</button>
          ))}
          <button onClick={() => void send({ cancelled: true }, 'cancelled')} disabled={busy} className={`${btn} text-ink-faint hover:text-ink hover:underline disabled:opacity-50`}>{t('approval.skip')}</button>
        </div>
      )}

      {(kind === 'input' || kind === 'editor') && (
        <div className="mt-2.5">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { e.stopPropagation(); if (kind === 'input' && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send({ value: text }, 'answered'); } }}
            placeholder={request.placeholder ?? t('approval.inputPlaceholder')}
            rows={kind === 'editor' ? (compact ? 3 : 6) : (compact ? 1 : 2)}
            disabled={busy}
            className="w-full text-xs text-ink bg-card border border-line rounded-md px-2 py-1.5 resize-y focus:outline-none focus:border-accent/60 disabled:opacity-50"
            data-question-input
          />
          <div className={`mt-1.5 flex flex-wrap items-center ${compact ? 'gap-1.5' : 'gap-2'}`}>
            <button onClick={() => void send({ value: text }, 'answered')} disabled={busy} className={primary} data-question-submit>{t('approval.answer')}</button>
            <button onClick={() => void send({ cancelled: true }, 'cancelled')} disabled={busy} className={secondary}>{t('approval.skip')}</button>
          </div>
        </div>
      )}

      {isApproval && (
        <div className={`mt-2.5 flex flex-wrap items-center ${compact ? 'gap-1.5' : 'gap-2'}`}>
          <button onClick={() => void send({ confirmed: true }, 'allowed-once')} disabled={busy} className={primary} data-approval-allow>{t('approval.allowOnce')}</button>
          {request.rule && request.channel && (
            <button onClick={() => void send({ confirmed: true, scope: 'session' }, 'allowed-session')} disabled={busy} className={`${btn} text-accent rounded-lg border border-accent/40 hover:bg-accent/10 transition-colors disabled:opacity-50 whitespace-nowrap`} title={t('approval.allowSessionTitle')} data-approval-allow-session>{t('approval.allowSession')}</button>
          )}
          {request.suggest && request.channel && (
            <button
              onClick={() => void send({ confirmed: true }, 'allowed-once', request.suggest!)}
              disabled={busy}
              className={`${btn} text-accent rounded-lg border border-accent/40 hover:bg-accent/10 transition-colors disabled:opacity-50 truncate ${compact ? 'max-w-[150px]' : 'max-w-[240px]'}`}
              title={`${t('approval.allowLocationTitle')} ${request.suggest}`}
              data-approval-allow-location
            >
              {t('approval.allowLocation')} {request.suggest.split('/').filter(Boolean).pop()}
            </button>
          )}
          <button onClick={() => void send({ confirmed: false }, 'rejected')} disabled={busy} className={secondary} data-approval-reject>{t('approval.reject')}</button>
          {!compact && request.arguments && request.arguments !== request.query && (
            <button onClick={() => setShowArgs((v) => !v)} className="text-2xs text-ink-faint hover:text-ink hover:underline ml-1">{t('approval.showArgs')}</button>
          )}
        </div>
      )}
      <div className="mt-1.5 text-2xs text-ink-faint">{busy ? t('approval.sending') : t('approval.waiting')}</div>
    </div>
  );
}

/** The decided questions of a turn, one line each — the record the canvas keeps. */
export function ApprovalRecords({ records }: { records: ApprovalRecord[] }) {
  const t = useT();
  if (records.length === 0) return null;
  const label = (r: ApprovalRecord) => r.outcome === 'allowed-once' ? t('approval.allowed') : r.outcome === 'allowed-session' ? (r.auto ? t('approval.autoAllowed') : t('approval.allowedSession')) : r.outcome === 'rejected' ? t('approval.rejected') : r.outcome === 'answered' ? t('approval.answered') : r.outcome === 'cancelled' ? t('approval.cancelled') : t('approval.unavailable');
  return (
    <ul className="mt-2 space-y-1" data-approval-records>
      {records.map((r) => (
        <li key={r.id} className="text-2xs text-ink-faint flex items-baseline gap-1.5 min-w-0">
          <span className="shrink-0">{r.outcome === 'allowed-once' || r.outcome === 'allowed-session' || r.outcome === 'answered' ? '✅' : '⛔'}</span>
          <span className="shrink-0">{label(r)}</span>
          <span className="font-mono text-ink-muted truncate">{r.name}{r.value ? ` → ${r.value}` : r.query ? ` · ${r.query}` : ''}</span>
        </li>
      ))}
    </ul>
  );
}

/** The turn's decisions behind a toggle, beside the reasoning: the card's
 *  face is the answer; what was allowed, refused or replied is backstage. */
export function DecisionsDisclosure({ records }: { records: ApprovalRecord[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const good = records.filter((r) => r.outcome === 'allowed-once' || r.outcome === 'allowed-session' || r.outcome === 'answered').length;
  return (
    <div className="mb-2 nopan">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className="flex items-center gap-1 text-2xs text-ink-faint hover:text-ink-muted transition-colors"
        data-decisions-toggle
      >
        {open ? <ChevronDown size={12} strokeWidth={1.75} /> : <ChevronRight size={12} strokeWidth={1.75} />}
        <span>🛡 {t('approval.decisions')} · {good}/{records.length}</span>
      </button>
      {open && <div className="mt-1 px-3 py-1.5 bg-wash/70 rounded-xl"><ApprovalRecords records={records} /></div>}
    </div>
  );
}
