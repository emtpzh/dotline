// The pieces of an ask box that say how the question will run, laid out the
// way the agent tools' own chat boxes are: above the box, where a new line
// runs (directory and runtime — only where a line starts); under the text,
// what the turn may do (access level, or search for a chat model) and what
// it runs on (model and effort), then the send; under the box, one status
// line saying whether the question goes on in the agent session above.

import { ArrowUp, ChevronDown, Cloud, CornerDownRight, Eye, PencilLine, SquareTerminal } from 'lucide-react';
import { useT, fmt } from '../../../i18n';
import { useStore } from '../../../store';
import { useUiStore } from '../../../lib/ui-store';
import { useModels, ensureAgentsFresh, type ModelInfo } from '../../../lib/use-models';
import { AGENT_RUNTIMES, LIVE_RUNTIMES, runtimeOf } from '../../../lib/agents/runtimes';
import { sessionWhy } from '../../../lib/session-why';
import { shortName } from '../../../lib/node-face';
import type { Continuity } from '../../../lib/agents/continuity';
import type { AgentAccess, AgentRuntime } from '../../../types';
import type { RunIntent } from '../../../lib/run-intent';
import type { IntentPatch } from './run-intent-hooks';
import { Button } from '../../ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuSub,
  DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger,
} from '../../ui/dropdown-menu';

/** A line runs on an agent runtime, or on a chat model (no session, no directory). */
export type Engine = AgentRuntime | 'chat';
const engineOf = (id: string | undefined): Engine => runtimeOf(id) ?? 'chat';

/** The engines the installation offers, in a fixed order, each with its models. */
function enginesOf(models: ModelInfo[]): { engine: Engine; models: ModelInfo[] }[] {
  const out: { engine: Engine; models: ModelInfo[] }[] = [];
  for (const rt of LIVE_RUNTIMES) {
    const ms = models.filter((m) => runtimeOf(m.id) === rt);
    if (ms.length) out.push({ engine: rt, models: ms });
  }
  const chat = models.filter((m) => !runtimeOf(m.id));
  if (chat.length) out.push({ engine: 'chat', models: chat });
  return out;
}

/** "Claude Code · Opus" → "Opus": the runtime is said elsewhere. */
function modelLabel(m: ModelInfo | undefined, id: string | undefined): string {
  if (!m) return id ? id.split('/').pop() ?? id : '';
  const rt = runtimeOf(m.id);
  const prefix = rt ? `${AGENT_RUNTIMES[rt].label} · ` : '';
  return m.name.startsWith(prefix) ? m.name.slice(prefix.length) : m.name;
}

/** The first model of an engine: where picking that engine lands. */
function firstModel(engines: { engine: Engine; models: ModelInfo[] }[], engine: Engine, preferred?: string | null): string | undefined {
  const group = engines.find((e) => e.engine === engine);
  if (!group) return undefined;
  return preferred && group.models.some((m) => m.id === preferred) ? preferred : group.models[0].id;
}

// a control in the box: borderless text with a caret, like the agent tools' own boxes
const pill = 'gap-1.5 rounded-md px-2 text-xs font-normal text-foreground hover:bg-muted aria-expanded:bg-muted';
const changedPill = 'text-primary [&_svg]:text-primary';

function EngineIcon({ engine }: { engine: Engine }) {
  return engine === 'chat' ? <Cloud strokeWidth={1.75} /> : <SquareTerminal strokeWidth={1.75} />;
}

/** Above a box that starts a line: the runtime the line runs on. Picking one
 *  lands on its first model (the canvas's default, when that is one of them). */
export function RuntimeMenu({ intent, onIntent }: { intent: RunIntent; onIntent: (p: IntentPatch) => void }) {
  const t = useT();
  const data = useModels();
  const engines = enginesOf(data?.models ?? []);
  const engine = engineOf(intent.model);
  const label = engine === 'chat' ? t('composer.chatModels') : AGENT_RUNTIMES[engine].label;
  return (
    <DropdownMenu onOpenChange={(open) => { if (open) ensureAgentsFresh(); }}>
      <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className={pill} data-composer-runtime={engine} />}>
        <EngineIcon engine={engine} /> {label} <ChevronDown strokeWidth={1.75} className="opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t('composer.runtime')}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={engine} onValueChange={(v) => {
            const next = v as Engine;
            if (next === engine) return;
            const model = firstModel(engines, next, data?.default);
            if (model) onIntent({ model, effort: '' });
          }}>
            {engines.map(({ engine: e }) => (
              <DropdownMenuRadioItem closeOnClick key={e} value={e} data-composer-runtime-option={e}>
                <EngineIcon engine={e} />
                <span className="flex-1 min-w-0">
                  <span className="block">{e === 'chat' ? t('composer.chatModels') : AGENT_RUNTIMES[e].label}</span>
                  <span className="block text-2xs text-muted-foreground">{e === 'chat' ? t('composer.chatHint') : t('composer.agentHint')}</span>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {data?.agentsPending && <p className="px-1.5 py-1 text-2xs text-muted-foreground">{t('model.agentGroupLoading')}</p>}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => useUiStore.getState().setApiKeyModalOpen(true)} data-composer-connect>
          {t('composer.connect')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Under the text, right: the model and its effort. In a box that asks off a
 *  node, the other runtimes are offered too — picking one opens a new session. */
export function ModelMenu({ intent, onIntent, changed, offerRuntimes }: {
  intent: RunIntent; onIntent: (p: IntentPatch) => void; changed?: boolean; offerRuntimes?: boolean;
}) {
  const t = useT();
  const data = useModels();
  const engines = enginesOf(data?.models ?? []);
  const engine = engineOf(intent.model);
  const group = engines.find((e) => e.engine === engine)?.models ?? [];
  const current = data?.models.find((m) => m.id === intent.model);
  const efforts = engine !== 'chat' ? current?.efforts ?? [] : [];
  const effortWord = intent.effort || current?.defaultEffort || '';
  const others = offerRuntimes ? engines.filter((e) => e.engine !== engine) : [];
  return (
    <DropdownMenu onOpenChange={(open) => { if (open) ensureAgentsFresh(); }}>
      <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className={`${pill} max-w-[220px] ${changed ? changedPill : ''}`} data-composer-model />}>
        <span className="truncate">{modelLabel(current, intent.model) || t('composer.defaultModel')}</span>
        {effortWord && <span className="text-muted-foreground shrink-0">{effortWord}</span>}
        <ChevronDown strokeWidth={1.75} className="opacity-60 shrink-0" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <span className="flex-1">{t('composer.model')}</span>
            <span className="text-muted-foreground truncate max-w-[110px]">{modelLabel(current, intent.model)}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-60 max-h-[60vh] overflow-y-auto">
            <DropdownMenuRadioGroup value={intent.model ?? ''} onValueChange={(v) => onIntent({ model: v as string, effort: '' })}>
              {group.map((m) => <DropdownMenuRadioItem closeOnClick key={m.id} value={m.id}>{modelLabel(m, m.id)}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        {efforts.length > 0 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <span className="flex-1">{t('composer.effort')}</span>
              <span className="text-muted-foreground">{effortWord || t('composer.effortDefault')}</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-44">
              <DropdownMenuRadioGroup value={intent.effort ?? ''} onValueChange={(v) => onIntent({ effort: v as string })}>
                <DropdownMenuRadioItem closeOnClick value="">{t('composer.effortDefault')}{current?.defaultEffort ? ` · ${current.defaultEffort}` : ''}</DropdownMenuRadioItem>
                {efforts.map((e) => <DropdownMenuRadioItem closeOnClick key={e} value={e}>{e}</DropdownMenuRadioItem>)}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {others.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>{t('composer.switchRuntime')}</DropdownMenuLabel>
              {others.map(({ engine: e, models }) => (
                <DropdownMenuSub key={e}>
                  <DropdownMenuSubTrigger><EngineIcon engine={e} /> {e === 'chat' ? t('composer.chatModels') : AGENT_RUNTIMES[e].label}</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="w-60 max-h-[60vh] overflow-y-auto">
                    {models.map((m) => <DropdownMenuItem key={m.id} onClick={() => onIntent({ model: m.id, effort: '' })}>{modelLabel(m, m.id)}</DropdownMenuItem>)}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              ))}
            </DropdownMenuGroup>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Under the text, left: how far an agent turn may go. Two levels; more is
 *  the terminal's to give. */
export function AccessMenu({ value, onChange, changed }: { value: AgentAccess; onChange: (a: AgentAccess) => void; changed?: boolean }) {
  const t = useT();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="sm" className={`${pill} ${changed ? changedPill : ''}`} data-composer-access={value} />}>
        {value === 'write' ? <PencilLine strokeWidth={1.75} /> : <Eye strokeWidth={1.75} />}
        {value === 'write' ? t('access.write') : t('access.read')}
        <ChevronDown strokeWidth={1.75} className="opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuRadioGroup value={value} onValueChange={(v) => onChange(v as AgentAccess)}>
          <DropdownMenuRadioItem closeOnClick value="read" data-composer-access-option="read">
            <Eye strokeWidth={1.75} />
            <span className="flex-1"><span className="block">{t('access.read')}</span><span className="block text-2xs text-muted-foreground">{t('access.readHint')}</span></span>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem closeOnClick value="write" data-composer-access-option="write">
            <PencilLine strokeWidth={1.75} />
            <span className="flex-1"><span className="block">{t('access.write')}</span><span className="block text-2xs text-muted-foreground">{t('access.writeHint')}</span></span>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <p className="px-1.5 py-1 text-2xs leading-snug text-muted-foreground">{t('access.more')}</p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The round send button; its colour says where the question goes. */
export function SendButton({ onClick, disabled, session, title }: { onClick: () => void; disabled?: boolean; session?: Continuity | null; title?: string }) {
  const t = useT();
  const tone = session?.kind === 'new' ? 'bg-warning hover:bg-warning/90' : session?.kind === 'fork' ? 'bg-edge-explore hover:bg-edge-explore/90' : 'bg-primary hover:bg-primary/90';
  return (
    <Button size="icon-sm"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      disabled={disabled}
      title={title ?? (session?.kind === 'new' ? t('session.sendNew') : t('composer.send'))}
      aria-label={t('composer.send')}
      className={`shrink-0 rounded-full text-primary-foreground disabled:opacity-40 ${tone}`}
      data-composer-send={session?.kind ?? 'plain'}
    >
      <ArrowUp strokeWidth={2.25} />
    </Button>
  );
}

/** Under a box that asks off a node: whether the question goes on in the
 *  agent session above, opens a new one (and why — with the way back when
 *  the box itself caused it), or branches from an earlier turn. Nothing for
 *  a chat line with no session above. */
export function RunStatus({ session, intent, base, onIntent, onLocate }: {
  session: Continuity | null; intent: RunIntent; base?: RunIntent;
  onIntent?: (p: IntentPatch) => void; onLocate?: (nodeId: string) => void;
}) {
  const t = useT();
  const nodes = useStore((s) => s.nodes);
  const runtime = runtimeOf(intent.model);
  if (!session) {
    return runtime ? <p className="px-1 text-2xs text-muted-foreground" data-composer-status="new-line">{t('composer.newSession')} · {AGENT_RUNTIMES[runtime].label}</p> : null;
  }
  if (session.kind === 'continue') {
    const parent = nodes.find((n) => n.id === session.parentId);
    const cwd = parent?.data.agentSession?.cwd ?? parent?.data.importSource?.cwd ?? '';
    return (
      <p className="flex flex-wrap items-center gap-x-3 px-1 text-2xs text-muted-foreground" data-composer-status="continue">
        <span className="inline-flex items-center gap-1"><CornerDownRight size={11} strokeWidth={1.75} /> {fmt(t('composer.continue'), { n: session.turn })}</span>
        <span className="truncate">{AGENT_RUNTIMES[session.runtime].label}{cwd ? ` · ${cwd.split('/').filter(Boolean).pop()}` : ''}</span>
      </p>
    );
  }
  if (session.kind === 'fork') {
    return <p className="rounded-md bg-edge-explore/10 px-2 py-1 text-2xs text-edge-explore" data-composer-status="fork">{fmt(t('session.forkLine'), { n: session.turn })}</p>;
  }
  // a new session: the model picked in this box is the one cause the box can take back
  const undoRuntime = session.reason === 'runtime' && base?.model && base.model !== intent.model && runtimeOf(base.model) && onIntent;
  const about = session.about ? nodes.find((n) => n.id === session.about) : undefined;
  const locatable = !!about && !!onLocate && (session.reason === 'material' || session.reason === 'reference' || session.reason === 'edited');
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-warning/10 px-2 py-1 text-2xs" role="status" data-composer-status="new">
      <span className="font-medium text-warning">{fmt(t('session.newTitle'), { why: sessionWhy(session, nodes, t) })}</span>
      <span className="text-muted-foreground">{t('composer.newCost')}</span>
      {undoRuntime && (
        <Button variant="outline" size="xs" className="h-5 px-1.5 text-2xs" onClick={(e) => { e.stopPropagation(); onIntent!({ model: base!.model, effort: base!.effort ?? '' }); }} data-composer-undo>
          {fmt(t('composer.undoRuntime'), { x: AGENT_RUNTIMES[runtimeOf(base!.model)!].label })}
        </Button>
      )}
      {locatable && (
        <Button variant="link" size="xs" className="h-auto px-0 text-2xs" onClick={(e) => { e.stopPropagation(); onLocate!(about!.id); }}>
          {fmt(t('session.locate'), { x: shortName(about!.data) })}
        </Button>
      )}
    </div>
  );
}
