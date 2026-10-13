import type { StoreApi } from 'zustand';
import { walkUpAncestors } from '../lib/graph';
import { upstreamFingerprint } from './context-builder';
import { pruneHighlights } from '../lib/highlight-match';
import { llmCall, llmCallStream, type ContextMessage, type ImageAttachment } from '../lib/api';
import { agentOutbound, syncAgentTurn, type AgentRoute } from '../lib/agents/agent-runtime';
import { abortAgentRun, awaitSettle, clearOverlay, runAgentTurn, patchBinding } from '../lib/agents/runs';
import { noticeTurnEnded } from '../lib/agents/offscreen';
import { lineModel } from '../lib/run-intent';
import { countTokens, activeSummary } from '../utils';
import { toast, useUiStore } from '../lib/ui-store';
import { modelsWith, reconcileModelId } from '../lib/use-models';
import { contextLengthFor } from '../lib/runtime-providers';
import { memoryContextBlock, judgeMemory } from '../lib/memory';
import { t, fmt } from '../i18n';
import { isViewerMode } from '../lib/viewer';
import type { AgentRuntime, Reference } from '../types';
import { markNaming, unmarkNaming } from '../lib/batch-naming';
import { isAutoRerun } from '../lib/edge-look';
import { continuity, linkOf } from '../lib/agents/continuity';
import { runtimeOf } from '../lib/agents/runtimes';
import type { StoreState } from './types';

// Background summary generation — fire and forget. Display channel ONLY:
// the human reads it on the card, the model always reads the full text.
// One call yields the node's name (topic) and its conclusion (takeaway).
// Every finished answer gets it, short ones included: the name is the only
// text the far view shows, so no node may go without one.
// The judge sees the MAP itself as context: the takeaway lines already on
// the ancestor path (with their tags). That keeps terminology aligned
// across plaques and classifications aware of what the thinking already
// ruled out or decided — the lines read as one progression, not islands.
export function generateSummary(nodeId: string, question: string, response: string, setSummary: (id: string, summary: string, forResponse: string, type?: string, topic?: string) => void, mapLines?: string[]) {
  if (!response.trim()) return;
  markNaming(nodeId);
  const mapBlock = mapLines && mapLines.length > 0
    ? `Takeaway lines already on the map, along this node's ancestor path (oldest first):\n${mapLines.join('\n')}\n\nUse those lines ONLY to align terminology and avoid repeating them. Classify this exchange's epistemic move on its own merits, independent of the lines above.\n\n`
    : '';
  llmCall([
    { role: 'user', content: question },
    { role: 'assistant', content: response },
    { role: 'user', content: `${mapBlock}Compress the above exchange for a map plaque. Output exactly ONE line in the format: TAG | topic | takeaway\n\nTAG classifies the epistemic move: INSIGHT (learned or confirmed something), RULEOUT (killed a hypothesis or option), DECISION (chose among options), PIVOT (reframed the question or direction), OPEN (raised a new unresolved question). Most exchanges are INSIGHT.\n\ntopic: the subject as a bare noun phrase. Hard limit: 6 characters for CJK languages, 14 characters otherwise.\n\ntakeaway: the conclusion, stated first and plainly, as one clause. Hard limit: 18 characters for CJK languages, 40 characters otherwise — it must fit whole on a small plaque, never truncated. A reader scanning many such lines should see how the thinking progressed.\n\nBoth in the same language as the question. Never use dash characters (—, –, -) inside topic or takeaway; use commas or colons instead. Output only that one line.` },
  ]).then((raw) => {
    // "TAG | topic | takeaway" — older models or drift may still answer
    // "TAG: text"; unknown/missing tags degrade to the unmarked default
    const line = raw.trim().split('\n')[0].trim();
    const three = line.match(/^(INSIGHT|RULEOUT|DECISION|PIVOT|OPEN)\s*[|｜:：]\s*([^|｜]+?)\s*[|｜]\s*(.+)$/is);
    const two = three ? null : line.match(/^(INSIGHT|RULEOUT|DECISION|PIVOT|OPEN)[:：|｜]\s*(.+)$/is);
    const type = (three?.[1] ?? two?.[1])?.toLowerCase() ?? 'insight';
    const topic = three ? three[2].trim() : undefined;
    const text = three ? three[3].trim() : (two ? two[2].trim() : line);
    // target the version this summary was computed FOR, not whichever
    // version the user has navigated to since
    setSummary(nodeId, text, response, type, topic);
  }).catch(() => {}).finally(() => unmarkNaming(nodeId));
}

/** The map lines a fresh takeaway should align with: the ancestor path's
    tagged takeaways (nearest 8), prefixed by the map's opening question. */
export function collectMapLines(nodeId: string, nodes: StoreState['nodes'], edges: StoreState['edges']): string[] {
  const { ordered } = walkUpAncestors(nodeId, nodes, edges);
  const TAG: Record<string, string> = { ruleout: 'RULEOUT', decision: 'DECISION', pivot: 'PIVOT', open: 'OPEN' };
  const lines = ordered
    .filter((n) => n.id !== nodeId)
    .map((n) => {
      const s = activeSummary(n.data);
      if (!s) return null;
      const type = n.data.summaryTypes?.[n.data.responseIndex];
      return `- ${type && TAG[type] ? `${TAG[type]}: ` : ''}${s}`;
    })
    .filter((l): l is string => !!l)
    .slice(-8);
  const root = ordered.find((n) => n.data.isRoot && n.id !== nodeId);
  if (root?.data.question) lines.unshift(`Opening question of the map: ${root.data.question.slice(0, 200)}`);
  return lines;
}

// Track active AbortControllers per node
export const activeAbortControllers = new Map<string, AbortController>();

// Generation sequence per node: a new generation SUPERSEDES any in-flight
// one (its stream is aborted and every late write it still attempts is
// dropped). Without this, edit-question + rerun raced two streams into the
// same node — alternating reasoning, clobbered answers.
const generationSeq = new Map<string, number>();

/**
 * Before the canvas is swapped out, its streams stop. Agent runs are not
 * among them: a run belongs to the page (lib/agents/runs) and goes on, and
 * its turn lands on its node from the session file when its canvas is in
 * view again.
 */
export function releaseGenerations(): void {
  for (const controller of activeAbortControllers.values()) controller.abort();
}

// How long a finished agent turn waits for its session file before the page
// says the turn is late (it lands when the file has it), and how long before
// the run's own text stands in for it.
const ADOPT_WAIT_MS = 6000;
const ADOPT_GIVE_UP_MS = 10 * 60_000;

// Auto-chain budget: how many times each autoRerun node has fired since the
// last MANUAL action. A fresh user action resets all counters, so budgets
// mean "auto rounds per user action" — and loops (writer->critic->writer)
// terminate deterministically when every node exhausts its rounds.
export const autoRunCounts = new Map<string, number>();

type Set = StoreApi<StoreState>['setState'];
type Get = StoreApi<StoreState>['getState'];

/**
 * The one streaming pipeline for filling a node's response:
 * register an AbortController (Stop button) → stream chunks into
 * `data.response` → on completion write response/versions/tokenCount and
 * collapse → pushHistory → kick off the background summary.
 * On abort or error, whatever streamed so far is kept.
 */
export async function runNodeGeneration(
  set: Set,
  get: Get,
  nodeId: string,
  opts: {
    question: string;
    messages: ContextMessage[];
    images?: ImageAttachment[];
    /** append = keep earlier responses as versions (evaluator critique history). */
    versionMode?: 'replace' | 'append';
    /** True when fired by the auto-refresh chain; manual generations reset all budgets. */
    autoChain?: boolean;
    /** Extra work after the final state write, before pushHistory (e.g. re-layout). */
    onSuccess?: (response: string) => void;
  },
): Promise<void> {
  // Read-only viewer: no generation whatsoever — belt-and-braces behind the
  // hidden UI (a missed button must still be inert).
  if (isViewerMode) return;
  const { question, images, onSuccess, versionMode = 'replace' } = opts;
  let { messages } = opts;
  if (!opts.autoChain) autoRunCounts.clear(); // a fresh user action starts a new wave
  // Supersede: abort any generation already running on this node; its late
  // callbacks are dropped via the sequence check below.
  activeAbortControllers.get(nodeId)?.abort();
  abortAgentRun(nodeId);
  const myGen = (generationSeq.get(nodeId) ?? 0) + 1;
  generationSeq.set(nodeId, myGen);
  const isCurrent = () => generationSeq.get(nodeId) === myGen;
  const abortController = new AbortController();
  activeAbortControllers.set(nodeId, abortController);
  const finished = () => { activeAbortControllers.delete(nodeId); };

  // A retry is starting — clear any previous failure flag and reasoning
  // buffer, and mark the old response as awaiting replacement (the canvas
  // shows the live thinking instead of the stale text while it streams).
  set((state) => ({
    nodes: state.nodes.map((n) =>
      n.id === nodeId
        ? { ...n, data: { ...n.data, generationFailed: undefined, reasoning: undefined, restreaming: n.data.response ? true : undefined } }
        : n
    ),
  }));

  let references: Reference[] | undefined;

  // Model provenance: the node's intent (lib/run-intent — written when it
  // was asked; a node from before intents reads its record), else the
  // global pick, else the server default. A model that isn't reachable here (imported canvas,
  // revoked key) reconciles to the same family locally, or falls back to
  // the global pick — SAID OUT LOUD and recorded as what actually ran,
  // never silently mismatched between execution and provenance.
  const pinnedRaw = lineModel(get().nodes.find((n) => n.id === nodeId)?.data);
  let pinnedModel = pinnedRaw;
  const modelData = await modelsWith(pinnedRaw);
  const serverDefaultModel: string | null = modelData?.default ?? null;
  if (pinnedRaw && modelData && modelData.models.length > 0) {
    const r = reconcileModelId(pinnedRaw, modelData.models);
    if (r !== pinnedRaw) {
      pinnedModel = r ?? undefined;
      toast('info', fmt(t(r ? 'node.pinnedModelRemapped' : 'node.pinnedModelUnavailable'), r ? { m: pinnedRaw, r } : { m: pinnedRaw }), 7000);
    }
  }

  // Vision reroute / image fallback report who actually answered — that is
  // what generatedBy must record (execution and provenance never diverge).
  let actualModel: string | undefined;
  let gatewaySearched = false;
  // An agent turn (a runtime on this machine, or the harness's own loop)
  // continues, forks or opens a session; the node becomes that turn's mirror
  const requestedModel = pinnedModel ?? useUiStore.getState().selectedModel ?? serverDefaultModel ?? undefined;
  const agentRoute = await agentOutbound(requestedModel, nodeId);
  const agentRuntime = agentRoute ? runtimeOf(requestedModel) : null;
  // the run's binding: the turn it writes lands on this node from the session
  // file (lib/sessions/sync). A continued session is known now, before the
  // file can show the turn; a fresh one names itself in its first event.
  if (agentRoute && agentRuntime) {
    const run = {
      runtime: agentRuntime, question, startedAt: new Date().toISOString(),
      ...(requestedModel ? { model: requestedModel } : {}),
      ...(versionMode === 'append' ? { append: true } : {}),
      ...(agentRoute.continue && agentRoute.sessionId ? { sessionId: agentRoute.sessionId, ...(agentRoute.afterTurnId ? { afterTurnId: agentRoute.afterTurnId } : {}) } : {}),
    };
    set((state) => ({ nodes: state.nodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, run } } : n)) }));
  }
  // What became of the agent session above, kept on the node: its card and
  // its wire say "new session · why" (or "from turn N") long after the
  // send. An ordinary model under an agent turn leaves that session too.
  {
    const link = agentRoute
      ? agentRoute.link
      : runtimeOf(requestedModel) ? undefined : linkOf(continuity(nodeId, get().nodes, get().edges, null, undefined));
    set((state) => ({ nodes: state.nodes.map((n) => (n.id === nodeId && (n.data.sessionLink || link) ? { ...n, data: { ...n.data, sessionLink: link } } : n)) }));
  }

  const writeFinal = (response: string, failed = false) => {
    if (!isCurrent()) return; // superseded: a newer generation owns this node
    const tokenCount = countTokens(question + response);
    const modelUsed = actualModel ?? pinnedModel ?? useUiStore.getState().selectedModel ?? serverDefaultModel ?? undefined;
    get().logEvent('generate', nodeId, { chars: response.length, ...(modelUsed ? { model: modelUsed } : {}), ...(failed ? { failed: true } : {}) });
    // Provenance: fingerprint what this answer depended on, AT completion —
    // the staleness pass compares this against the live upstream fingerprint.
    const contextHash = upstreamFingerprint(nodeId, get().nodes, get().edges);
    set((state) => ({
      nodes: state.nodes.map((n) => {
        if (n.id !== nodeId) return n;
        // keep (response, generatedBy, reasoning, generatedAt, editedAt) tuples aligned through the empty-filter.
        // A FAILED replace also keeps them: the failure placeholder must not
        // wipe real earlier versions (the failure banner offers switching
        // back). Stale placeholders from earlier failed rounds are dropped
        // so repeated retries don't stack failure entries.
        const failText = new Set([t('node.failedPlaceholder'), t('node.emptyResponse')]);
        const kept = versionMode === 'append' || failed
          ? n.data.responses.map((r, i) => ({ r, q: n.data.questions?.[i], by: n.data.generatedBy?.[i], rs: n.data.reasonings?.[i], at: n.data.generatedAts?.[i], ed: n.data.editedAts?.[i], gw: n.data.gatewaySearches?.[i], ef: n.data.generatedEfforts?.[i] })).filter(({ r }) => r && !(failed && failText.has(r)))
          : [];
        const now = new Date().toISOString();
        const responses = [...kept.map(({ r }) => r), response];
        // the (question, answer) pair rail: editQuestion pinned old wordings
        // already; anything still absent shared the current wording
        const questions = [...kept.map(({ q }) => q ?? n.data.question), n.data.question];
        const generatedBy = [...kept.map(({ by }) => by), modelUsed];
        const gatewaySearches = [...kept.map(({ gw }) => gw), gatewaySearched || undefined];
        // the effort this version ran at: only an agent turn has one, from the run's own record
        // an agent turn's effort is its session file's to say (lib/sessions/sync); a run written here has none on record
        const generatedEfforts = [...kept.map(({ ef }) => ef), undefined];
        const reasonings = [...kept.map(({ rs }) => rs), n.data.reasoning || undefined];
        const generatedAts = [...kept.map(({ at }) => at), now];
        const editedAts = [...kept.map(({ ed }) => ed), undefined];
        return { ...n, data: { ...n.data, response, responses, questions, generatedBy, gatewaySearches, generatedEfforts, reasonings, generatedAts, editedAts, reasoning: undefined, restreaming: undefined, pendingApprovals: undefined, agentTrace: undefined, responseIndex: responses.length - 1, isLoading: false, tokenCount, generationFailed: failed || undefined, references, highlights: pruneHighlights(n.data.highlights, response), lastContextHash: contextHash, lastGeneratedAt: now } };
      }),
    }));
    // the answer has its final length: what hangs below re-hangs from it
    get().settleFrom([nodeId]);
  };

  // Ambient memory rides the system layer of ordinary generations only —
  // paradigm machine steps stay memory-free (experimental control), digests
  // must stay faithful to the material (no personalization), and
  // fingerprints never see this block (memory edits must not mark answers
  // stale; the block is assembled at generation time, after buildContext).
  const selfData = get().nodes.find((n) => n.id === nodeId)?.data;
  const memBlock = !selfData?.stepKind && !selfData?.digestOf ? memoryContextBlock() : null;
  if (memBlock) {
    // Insert AFTER the last assistant turn: the material+chain prefix stays
    // byte-stable across turns, so provider prompt caches keep hitting.
    // Memory entries change often — at the front they would invalidate the
    // cached prefix on every write.
    let insertAt = messages.length - 1; // no upstream yet → before the question
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'assistant') { insertAt = i + 1; break; }
    }
    messages = [...messages.slice(0, insertAt), memBlock, ...messages.slice(insertAt)];
  }

  // what a finished answer sets going: its plaque, memory, the reruns and
  // paradigm steps waiting on it
  const afterAnswer = (response: string) => {
    onSuccess?.(response);
    get().pushHistory();
    generateSummary(nodeId, question, response, get().setSummary, collectMapLines(nodeId, get().nodes, get().edges));
    if (!selfData?.stepKind && !selfData?.digestOf) judgeMemory(question, response);
    triggerAutoReruns(set, get, nodeId);
    triggerParadigmCascade(get, nodeId);
  };

  if (agentRoute && agentRuntime && requestedModel) {
    // an agent turn is the run manager's to run and the session sync's to
    // write: nothing here streams into the node
    finished();
    await runAgentGeneration(set, get, nodeId, { question, messages, images, model: requestedModel, route: agentRoute, runtime: agentRuntime, isCurrent, writeFinal, afterAnswer });
    return;
  }

  try {
    // Context budget: browser-configured models carry their probed window.
    // When the wired context alone clearly exceeds it, fail fast with the
    // reason (and no spend) instead of a guaranteed upstream 400. countTokens
    // errs high on CJK, and an input hugging the window leaves no room for
    // the answer anyway — so a plain >= is the honest cutoff.
    const effectiveModel = pinnedModel ?? useUiStore.getState().selectedModel ?? serverDefaultModel;
    const windowLimit = effectiveModel ? contextLengthFor(effectiveModel) : undefined;
    if (windowLimit) {
      const est = countTokens(messages.map((m) => m.content).join('\n'));
      if (est >= windowLimit) {
        throw new Error(fmt(t('toast.contextOverWindow'), { est: est.toLocaleString(), model: effectiveModel!, limit: windowLimit.toLocaleString() }));
      }
    }
    // Stream frames arrive at 100+/s on the direct lane (DeepSeek flash
    // thinking most of all). Committing every frame re-renders the whole
    // canvas and locks the tab; buffer the latest text and commit at most
    // every ~100ms (leading + trailing), with a final flush after the await.
    let streamLatest: { response?: string; reasoning?: string } | null = null;
    let streamTimer: number | null = null;
    const commitStream = () => {
      if (!streamLatest || !isCurrent()) { streamLatest = null; return; }
      const patch = streamLatest;
      streamLatest = null;
      set((state) => ({
        nodes: state.nodes.map((n) =>
          n.id === nodeId
            ? { ...n, data: { ...n.data,
                ...(patch.response !== undefined ? { response: patch.response, restreaming: undefined } : {}),
                ...(patch.reasoning !== undefined ? { reasoning: patch.reasoning } : {}) } }
            : n
        ),
      }));
    };
    const pushStream = (patch: { response?: string; reasoning?: string }) => {
      streamLatest = { ...(streamLatest ?? {}), ...patch };
      if (streamTimer == null) {
        commitStream();
        streamTimer = window.setTimeout(() => { streamTimer = null; commitStream(); }, 100);
      }
    };
    const flushStream = () => {
      if (streamTimer != null) { clearTimeout(streamTimer); streamTimer = null; }
      commitStream();
    };

    const response = await llmCallStream(messages, (_chunk, fullSoFar) => {
      pushStream({ response: fullSoFar });
    }, abortController.signal, images, {
      onToolCall: (name, query) => {
        if (!isCurrent()) return;
        // Show what's being searched while the answer hasn't started streaming
        const icon = name === 'arxiv_search' ? '📚' : name === 'semantic_scholar' ? '🎓' : name.startsWith('mcp:') ? '🔧' : '🔍';
        set((state) => ({
          nodes: state.nodes.map((n) =>
            n.id === nodeId && !n.data.response
              ? { ...n, data: { ...n.data, response: `${icon} ${query}…` } }
              : n
          ),
        }));
      },
      onGatewaySearch: () => {
        if (!isCurrent()) return;
        gatewaySearched = true;
        // Same pattern as tool pings: a placeholder line while the answer
        // has not started streaming — the gateway searches in silence.
        set((state) => ({
          nodes: state.nodes.map((n) =>
            n.id === nodeId && !n.data.response
              ? { ...n, data: { ...n.data, response: `🌐 ${t('node.gatewaySearching')}` } }
              : n
          ),
        }));
      },
      onSources: (sources) => { references = sources; },

      onRerouted: (_from, to) => { actualModel = to; },
      onImageFallback: (model) => { actualModel = model; },
      onReasoning: (_chunk, fullSoFar) => {
        pushStream({ reasoning: fullSoFar });
      },
    }, (() => {
      // Search permissions live on the node (snapshotted at ask time);
      // legacy nodes without flags follow the current shared defaults
      const selfData = get().nodes.find((n) => n.id === nodeId)?.data;
      return {
        web: selfData?.webSearch ?? useUiStore.getState().webSearchEnabled,
        scholar: selfData?.scholarSearch ?? useUiStore.getState().scholarSearchEnabled,
        mcp: useUiStore.getState().mcpEnabled,
      };
    })(), pinnedModel);
    flushStream();
    if (!isCurrent()) return; // superseded while finishing: drop everything
    finished();
    if (!response.trim()) {
      // The stream closed cleanly but the model sent nothing (upstream
      // hiccup, tool-only turn) — silent emptiness reads as a hang, so
      // surface it as a retryable failure instead.
      finished();
      writeFinal(t('node.emptyResponse'), true);
      return;
    }
    writeFinal(response);
    afterAnswer(response);
  } catch (err) {
    if (!isCurrent()) return; // superseded: the abort was ours to swallow
    finished();
    const partial = get().nodes.find((n) => n.id === nodeId)?.data.response || '';
    const isAbort = err instanceof DOMException && err.name === 'AbortError';
    if (isAbort) {
      // User pressed Stop — keep whatever streamed, no error surfacing
      writeFinal(partial || t('node.stoppedPlaceholder'));
    } else {
      // Real failure: details go to a toast, the node gets a Retry affordance
      const message = err instanceof Error ? err.message : t('toast.unknownError');
      if (/no model configured/i.test(message)) {
        // The one failure with an obvious remedy: summon the key dialog
        // right here, with a localized line instead of the raw server text.
        toast('info', t('toast.noModelYet'));
        useUiStore.getState().setApiKeyModalOpen(true);
      } else if (/429|too many requests|rate.?limit|quota/i.test(message)) {
        // Free tiers meter requests per minute — a pause fixes it, and the
        // raw provider text reads like a failure of the app rather than a
        // property of the free key. Say what it actually is.
        toast('info', t('toast.rateLimited'));
      } else {
        toast('error', fmt(t('toast.generationFailed'), { message }));
      }
      writeFinal(partial || t('node.failedPlaceholder'), true);
    }
    get().pushHistory();
  }
}

/**
 * An agent turn: the run manager runs it (its overlay is what the node shows
 * meanwhile), and the session sync writes the turn into the node from the
 * session file — by the node's binding, once the file has the whole turn.
 * Only a run with no session file to read (a host without the sessions
 * bridge, a run that never named a session) has its own text written here,
 * and a stopped or failed run says so here; its binding stays, so a turn
 * the file holds after all still lands on the node.
 */
async function runAgentGeneration(set: Set, get: Get, nodeId: string, o: {
  question: string; messages: ContextMessage[]; images?: ImageAttachment[];
  model: string; route: AgentRoute; runtime: AgentRuntime;
  isCurrent: () => boolean;
  writeFinal: (response: string, failed?: boolean) => void;
  afterAnswer: (response: string) => void;
}): Promise<void> {
  const { useProjects } = await import('./projects');
  const canvasId = useProjects.getState().activeId;
  if (!canvasId) return;
  /** the node is on the canvas in view, and still this run's */
  const here = () => o.isCurrent() && useProjects.getState().activeId === canvasId && !useProjects.getState().switching && get().nodes.some((n) => n.id === nodeId);
  let sessionId = o.route.continue ? o.route.sessionId : undefined;
  const end = await runAgentTurn({
    nodeId, canvasId, runtime: o.runtime, question: o.question, messages: o.messages, images: o.images, model: o.model, route: o.route,
    onSession: (session) => {
      if (!session.sessionId) return;
      sessionId = session.sessionId;
      void patchBinding(canvasId, nodeId, (run) => (run.sessionId ? run : { ...run, sessionId: session.sessionId! }));
      // a session the run opened: the canvas follows it from now on — turns
      // added to it later, from a terminal or a chat, grow here
      if (!o.route.continue) void import('../lib/sessions/subscribe').then((m) => m.followRunSession(session.runtime, session.sessionId!, canvasId)).catch(() => {});
    },
  });
  if (!o.isCurrent()) return; // a newer generation took the node

  const fileToRead = !!sessionId && !!window.desktopSessions;
  if (end.how !== 'end' || !fileToRead) {
    // stopped, failed, or nothing to read the turn from: the run's own account
    if (end.how === 'error') {
      const message = end.error ?? t('toast.unknownError');
      if (here()) toast('error', fmt(t('toast.generationFailed'), { message }));
    }
    const text = end.text.trim() ? end.text : end.how === 'aborted' ? t('node.stoppedPlaceholder') : end.how === 'error' ? t('node.failedPlaceholder') : t('node.emptyResponse');
    const failed = end.how === 'error' || !end.text.trim() && end.how === 'end';
    if (here()) {
      o.writeFinal(text, failed);
      clearOverlay(nodeId);
      // nothing will ever bind a run without a session file
      if (!fileToRead) set((state) => ({ nodes: state.nodes.map((n) => (n.id === nodeId && n.data.run ? { ...n, data: { ...n.data, run: undefined } } : n)) }));
      get().pushHistory();
      if (!failed && end.how === 'end') o.afterAnswer(text);
    } else if (!fileToRead) {
      const { patchNodeOn } = await import('../lib/agents/runs');
      await patchNodeOn(canvasId, nodeId, (d) => ({ response: text, responses: [text], questions: [d.question], generatedBy: [o.model], responseIndex: 0, isLoading: false, generationFailed: failed || undefined, run: undefined }));
      clearOverlay(nodeId);
    }
    return;
  }

  // the turn is in the file: the sync writes it (now, if the canvas is in
  // view; when it is in view again, if not)
  if (here()) void syncAgentTurn(nodeId, o.runtime, sessionId!).catch(() => false);
  let settled = await awaitSettle(nodeId, ADOPT_WAIT_MS);
  if (!settled) {
    if (here()) toast('info', t('agent.adoptLate'), 8000);
    settled = await awaitSettle(nodeId, ADOPT_GIVE_UP_MS);
  }
  if (!here()) return;
  const node = get().nodes.find((n) => n.id === nodeId);
  if (!settled) {
    // the file never showed the turn: the run's text stands in
    o.writeFinal(end.text.trim() ? end.text : t('node.emptyResponse'), !end.text.trim());
    clearOverlay(nodeId);
    set((state) => ({ nodes: state.nodes.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, run: undefined } } : n)) }));
    if (end.text.trim()) o.afterAnswer(end.text);
    return;
  }
  noticeTurnEnded(nodeId);
  o.afterAnswer(node?.data.response ?? end.text);
}

/**
 * Two generic primitives fire after any node finishes generating:
 *
 * 1. followsTip edges slide forward — an edge marked followsTip keeps
 *    pointing at the newest node of the thread it grew from, so whatever
 *    consumes it (a reviewer, a live summary) always sees the tip.
 * 2. autoRerun nodes regenerate — any node with autoRerun whose ancestor
 *    set (standard context walk, after edges slid) contains the completed
 *    node reruns itself in place. Chains of autoRerun nodes cascade
 *    naturally; the DAG has no cycles to worry about.
 */
/**
 * Paradigm cascade: an instantiated paradigm executes itself forward. When a
 * node completes, every STRUCTURAL child tagged stepKind 'prompt' that has
 * never produced a response starts automatically — but only once ALL of its
 * structural parents are complete (a human parent counts as complete when its
 * question is filled; failed parents block until retried). Human nodes are
 * never auto-run, so the run pauses wherever the paradigm put a person.
 * Each prompt node is filled at most once (only empty nodes fire) — no loops.
 * Ordinary canvases are untouched: nothing there carries stepKind 'prompt'.
 */
export function triggerParadigmCascade(get: Get, completedNodeId: string): void {
  if (useUiStore.getState().autoRefreshPaused) return; // same global brake
  const { nodes, edges } = get();
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const isComplete = (id: string): boolean => {
    const n = byId.get(id);
    if (!n || n.data.isLoading) return false;
    if (n.data.stepKind === 'human') return !!n.data.question.trim();
    // Content nodes: complete when they hold material. An EMPTY note/file/
    // link in a paradigm is a material slot — the cascade waits for the
    // human to fill it, same pause semantics as a human turn.
    if (n.data.stepKind === 'note' || n.data.stepKind === 'link') return !!n.data.question.trim();
    if (n.data.stepKind === 'file') return (n.data.attachments?.length ?? 0) > 0;
    return !!n.data.response && !n.data.generationFailed;
  };
  for (const edge of edges) {
    if (edge.source !== completedNodeId || edge.data?.isCrossLink) continue;
    const child = byId.get(edge.target);
    if (!child || child.data.stepKind !== 'prompt') continue;
    if (child.data.response || child.data.isLoading || child.data.generationFailed) continue;
    const parentIds = edges.filter((e) => e.target === child.id && !e.data?.isCrossLink).map((e) => e.source);
    if (!parentIds.every(isComplete)) continue; // fan-in: wait for all parents
    // rerunNode sets isLoading synchronously before awaiting, so a sibling
    // completion arriving next tick sees the child as busy — no double fire.
    void get().rerunNode(child.id, { auto: true });
  }
}

function triggerAutoReruns(set: Set, get: Get, completedNodeId: string): void {
  if (useUiStore.getState().autoRefreshPaused) return; // global kill switch
  // 1) slide followsTip edges whose source thread just grew: the completed
  //    node's STRUCTURAL ancestor chain reaching an edge's source means
  //    that edge's thread extended past its current anchor.
  const chain = new Set<string>([completedNodeId]);
  const queue = [completedNodeId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const e of get().edges) {
      if (e.target === current && !e.data?.isCrossLink && !chain.has(e.source)) {
        chain.add(e.source);
        queue.push(e.source);
      }
    }
  }
  const needsSlide = get().edges.some(
    (e) => e.data?.followsTip && e.source !== completedNodeId && chain.has(e.source)
  );
  if (needsSlide) {
    set((state) => ({
      edges: state.edges.map((e) =>
        e.data?.followsTip && e.source !== completedNodeId && chain.has(e.source)
          ? { ...e, id: `watch-${completedNodeId}-${e.target}`, source: completedNodeId }
          : e
      ),
    }));
  }

  // 2) rerun any autoRerun node that (now) has the completed node upstream,
  //    within its per-wave budget (autoRerunRounds, default 1)
  const { nodes, edges } = get();
  for (const n of nodes) {
    if (!isAutoRerun(n.data) || n.id === completedNodeId) continue;
    if (n.data.isLoading || activeAbortControllers.has(n.id)) continue;
    const spent = autoRunCounts.get(n.id) ?? 0;
    if (spent >= (n.data.autoRerunRounds ?? 1)) continue; // budget exhausted this wave
    const { ordered } = walkUpAncestors(n.id, nodes, edges);
    if (ordered.some((a) => a.id === completedNodeId)) {
      autoRunCounts.set(n.id, spent + 1);
      void get().rerunNode(n.id, { auto: true });
    }
  }
}
