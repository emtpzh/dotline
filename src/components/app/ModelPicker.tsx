import { useEffect, useRef, useState } from 'react';
import { ChevronDown, Cpu, KeyRound, RefreshCw, Info, Loader2 } from 'lucide-react';
import { toast, useUiStore } from '../../lib/ui-store';
import { useModels, setModelsCache, ensureAgentsFresh, type ModelInfo } from '../../lib/use-models';
import { AGENT_PROVIDER, isAgentModel } from '../../lib/agents/agent-runtime';
import { refreshStoredProviders, pushProviders, storedProviders } from '../../lib/runtime-providers';
import { fmt } from '../../i18n';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '../ui/command';

// same reason as CondenseDialog: "" reads as unset to the select
const RUNTIME_DEFAULT = '__default__';
import { useT } from '../../i18n';
import { Button } from '../ui/button';
import { Input } from '../ui/input';

interface PickerProps {
  /** Node mode: the node's intent (what it runs on next) + change handler. */
  value?: string;
  onChange?: (id: string) => void;
  /** Node mode: the node's agent effort ('' = the runtime's default) + its handler. */
  effort?: string;
  onEffortChange?: (level: string) => void;
  /** Node mode: a caution about where the value came from (shown as the tooltip). */
  hint?: string;
  /** Compact styling for embedding in panel rows. */
  compact?: boolean;
  /** canvas top bar out of room: the icon stays, the name moves to the tooltip */
  iconOnly?: boolean;
}

// Dropdown listing every model the server registered (driven by which API
// keys exist in .env), grouped by provider. Without props it edits the
// GLOBAL selection (where a new root starts); with value/onChange it edits
// one node's intent — model and effort — and nothing else.
export default function ModelPicker({ value, onChange, effort, onEffortChange, hint, compact, iconOnly }: PickerProps) {
  const t = useT();
  const nodeMode = !!onChange;
  const selectedModel = useUiStore((s) => s.selectedModel);
  const setSelectedModel = useUiStore((s) => s.setSelectedModel);
  const data = useModels();
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // the effort step unfolded under a just-picked agent model (see pick); closes with the menu
  const [effortStepFor, setEffortStepFor] = useState<string | null>(null);
  const agentEffort = useUiStore((s) => s.agentEffort);
  const rootRef = useRef<HTMLDivElement>(null);

  // the runtimes are asked for their catalogs the first time a picker
  // opens, not at launch: a CLI to start is seconds and memory the launch
  // should not pay for
  useEffect(() => { if (open) ensureAgentsFresh(); }, [open]);

  // A successful connect pings the GLOBAL picker open: the user lands on
  // their fresh model list instead of wondering whether anything happened.
  // (adjust-during-render, same pattern as FocusPanel's node switch)
  const ping = useUiStore((s) => s.modelPickerPing);
  const [pingSeen, setPingSeen] = useState(ping);
  if (ping !== pingSeen) {
    setPingSeen(ping);
    if (!nodeMode) setOpen(true);
  }

  const models = data?.models ?? [];
  // Node mode: with one model there is nothing to pin. The GLOBAL picker
  // stays even when the list fetch failed outright (proxy not running) —
  // its empty state IS the connect-a-model door, and a vanished picker
  // would leave the canvas with no way into model setup at all.
  if (nodeMode && models.length < 2) return null;

  // Empty install: the picker IS the call to action. A grey "no model"
  // label reads as a dead control; a keyed accent button reads as the door.
  const noModels = !nodeMode && models.length === 0;

  const globalId = selectedModel && models.some((m) => m.id === selectedModel) ? selectedModel : data?.default;
  const activeId = nodeMode ? (value ?? null) : globalId;
  const active = activeId ? models.find((m) => m.id === activeId) : null;
  const providers = [...new Set(models.map((m) => m.provider))];
  // the agent group is listed while the runtimes are still answering, so the
  // picker has somewhere to say so
  if (data?.agentsPending && !providers.includes(AGENT_PROVIDER)) providers.push(AGENT_PROVIDER);


  // Picking an agent model that reports effort levels keeps the menu open and
  // unfolds the effort step right under the entry: the level is a decision the
  // person should see being made, not a row to discover later. OK closes.
  const pick = (id: string) => {
    if (nodeMode) onChange!(id);
    else setSelectedModel(id === data?.default ? null : id);
    const m = id ? models.find((x) => x.id === id) : null;
    if (m && isAgentModel(m.id) && (m.efforts?.length ?? 0) > 0) { setEffortStepFor(m.id); return; }
    setOpen(false);
  };
  // the level the next turn will run at, as far as the runtime told us
  const effortWord = (m: ModelInfo | null | undefined): string => {
    if (!m || !isAgentModel(m.id) || !m.efforts?.length) return '';
    const level = nodeMode ? (effort ?? '') : agentEffort;
    return m.efforts.includes(level) ? level : (m.defaultEffort ?? '');
  };
  const withEffort = (m: ModelInfo) => (effortWord(m) ? `${m.name} · ${effortWord(m)}` : m.name);

  // a node's model not in the list (a revoked key, another machine's
  // runtime) still names itself; the run reconciles it out loud
  const globalActive = globalId ? models.find((m) => m.id === globalId) : null;
  const label = nodeMode
    ? (active ? withEffort(active) : (value ?? (globalActive ? withEffort(globalActive) : t('model.none'))))
    : (active ? withEffort(active) : (activeId ?? (models.length === 0 ? t('model.none') : null)));

  return (
    <div ref={rootRef} className="relative">
      <Popover
        open={open}
        onOpenChange={(next) => {
          // with no model connected the button is a door to the key dialog,
          // not a menu
          if (noModels) { useUiStore.getState().setApiKeyModalOpen(true); return; }
          setEffortStepFor(null);
          setOpen(next);
        }}
      >
      <PopoverTrigger
        render={
          // in the panel header it is a tinted chip in a row of controls;
          // on the canvas it is chrome, and with nothing connected the
          // chrome wears the accent, because then it IS the way in
          compact
            ? <Button variant="ghost" size="sm" className={`max-w-[200px] ${hint ? 'bg-warning/10 text-warning ring-1 ring-warning/40 hover:bg-warning/20' : 'bg-primary/10 text-primary hover:bg-primary/20'}`} />
            : <Button variant="chrome" className={`max-w-[190px] ${noModels ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/20' : ''}`} />
        }
        title={noModels ? t('apikey.entryTitle') : nodeMode ? (hint ?? t('model.nodeTitle')) : iconOnly && label ? `${t('toolbar.model')} · ${label}` : t('toolbar.model')}
        data-apikey-entry={noModels || undefined}
      >
        {noModels
          ? <KeyRound strokeWidth={1.75} />
          : <Cpu strokeWidth={1.75} className={compact && hint ? '' : 'text-primary'} />}
        {!iconOnly && <span className="text-xs truncate font-medium">{noModels ? t('model.connectCta') : label}</span>}
        {!noModels && <ChevronDown strokeWidth={1.75} className="opacity-70" />}
      </PopoverTrigger>

      {/* Both placements drop DOWN: the compact picker lives in the panel
          header now (an upward menu would fly off the viewport top) */}
      <PopoverContent align="end" sideOffset={6} className="w-64 max-h-[70vh] overflow-y-auto gap-0 p-0">
        <Command className="bg-transparent">
          {/* past a handful of models, naming one beats scrolling for it */}
          {models.length > 7 && <CommandInput placeholder={t('model.search')} />}
          <CommandList className="max-h-[46vh]">
            <CommandEmpty>{t('model.noMatch')}</CommandEmpty>
            {providers.map((provider) => (
              <CommandGroup
                key={provider}
                heading={
                  <span className="flex items-center gap-1.5" title={provider === AGENT_PROVIDER ? t('model.agentGroupHint') : undefined}>
                    {provider === AGENT_PROVIDER ? t('model.agentGroup') : provider}
                    {provider === AGENT_PROVIDER && <Info size={11} strokeWidth={1.75} className="text-muted-foreground/70" data-agent-group-hint />}
                    {provider === AGENT_PROVIDER && data?.agentsPending && <Loader2 size={11} className="animate-spin text-muted-foreground" data-agent-group-pending />}
                  </span>
                }
              >
                {provider === AGENT_PROVIDER && data?.agentsPending && models.filter((m) => m.provider === AGENT_PROVIDER).length === 0 && (
                  <p className="text-2xs text-muted-foreground px-2 pb-1.5">{t('model.agentGroupLoading')}</p>
                )}
                {models.filter((m) => m.provider === provider).map((m) => (
                  <div key={m.id}>
                    <CommandItem
                      value={`${m.name} ${m.id}`}
                      onSelect={() => pick(m.id)}
                      data-checked={m.id === activeId}
                      className={m.id === activeId ? 'text-primary font-medium' : ''}
                    >
                      <span className="truncate flex-1">{m.name.replace(` (${m.provider})`, '')}</span>
                      {m.vision && <span className="text-2xs text-muted-foreground shrink-0">{t('model.vision')}</span>}
                    </CommandItem>
                    {effortStepFor === m.id && <EffortStep model={m} {...(nodeMode ? { level: effort ?? '', onChange: onEffortChange } : {})} onDone={() => { setEffortStepFor(null); setOpen(false); }} />}
                  </div>
                ))}
              </CommandGroup>
            ))}
            {!nodeMode && (
              <CommandGroup>
                <CommandItem
                  onSelect={() => { setOpen(false); useUiStore.getState().setApiKeyModalOpen(true); }}
                  className={models.length === 0 ? 'text-primary font-medium' : 'text-muted-foreground'}
                  data-picker-apikey
                >
                  <KeyRound size={13} strokeWidth={1.75} /> {t('apikey.entryTitle')}
                </CommandItem>
                <CommandItem
                  onSelect={() => {
                    setRefreshing(true);
                    void refreshStoredProviders()
                      .then((d) => { if (d) setModelsCache(d); })
                      .finally(() => setRefreshing(false));
                  }}
                  disabled={refreshing}
                  title={t('model.refreshList')}
                  className="text-muted-foreground"
                  data-model-refresh
                >
                  <RefreshCw size={12} strokeWidth={1.75} className={refreshing ? 'animate-spin' : ''} /> {t('model.refresh')}
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
        {!nodeMode && <GlobalCapabilities />}
      </PopoverContent>
      </Popover>
    </div>
  );
}

// ── Effort step: unfolds under the agent model just picked ──
// The runtime's own levels, in its own words (read from the CLI, never
// translated). The first option is its default, named when it says. Global
// like the model choice, or the node's when a node's picker opened it; OK
// closes the menu.
function EffortStep({ model, level, onChange, onDone }: { model: ModelInfo; level?: string; onChange?: (level: string) => void; onDone: () => void }) {
  const t = useT();
  const globalEffort = useUiStore((s) => s.agentEffort);
  const setGlobalEffort = useUiStore((s) => s.setAgentEffort);
  const effort = onChange ? (level ?? '') : globalEffort;
  const setEffort = onChange ?? setGlobalEffort;
  const levels = model.efforts ?? [];
  const value = levels.includes(effort) ? effort : '';
  return (
    <div className="mx-3 mb-1.5 mt-0.5 rounded-lg bg-muted/70 border border-border px-2 py-1.5 flex items-center gap-2" title={t('model.effortHint')} data-agent-effort>
      <span className="text-2xs text-muted-foreground uppercase tracking-wider font-medium shrink-0">{t('model.effort')}</span>
      <Select
        value={value || RUNTIME_DEFAULT}
        onValueChange={(v) => setEffort(v === RUNTIME_DEFAULT ? '' : (v as string))}
        items={{
          [RUNTIME_DEFAULT]: model.defaultEffort ? fmt(t('model.effortDefaultKnown'), { level: model.defaultEffort }) : t('model.effortDefault'),
          ...Object.fromEntries(levels.map((l) => [l, l])),
        }}
      >
        <SelectTrigger size="sm" className="flex-1 min-w-0" data-agent-effort-select onClick={(e) => e.stopPropagation()}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={RUNTIME_DEFAULT}>{model.defaultEffort ? fmt(t('model.effortDefaultKnown'), { level: model.defaultEffort }) : t('model.effortDefault')}</SelectItem>
          {levels.map((l) => <SelectItem key={l} value={l}>{l}</SelectItem>)}
        </SelectContent>
      </Select>
      <Button size="xs" onClick={(e) => { e.stopPropagation(); onDone(); }} className="shrink-0" data-agent-effort-ok>{t('model.effortConfirm')}</Button>
    </div>
  );
}

// ── Capabilities: the engine-room report at the picker's foot ──
// What this installation can do, what is missing (the ONLY place that
// hints at hidden features), and the one extra model choice: which
// vision model reads images and recognizes scanned pages.
function GlobalCapabilities() {
  const t = useT();
  const data = useModels();
  const visionModelPref = useUiStore((s) => s.visionModelPref);
  const setVisionModelPref = useUiStore((s) => s.setVisionModelPref);
  const searchEnginePref = useUiStore((s) => s.searchEnginePref);
  const setSearchEnginePref = useUiStore((s) => s.setSearchEnginePref);
  const anysearchKey = useUiStore((s) => s.anysearchKey);
  const [anysearchDraft, setAnysearchDraft] = useState(anysearchKey);
  const saveAnysearchKey = async () => {
    const k = anysearchDraft.trim();
    if (k === anysearchKey) return;
    useUiStore.getState().setAnysearchKey(k);
    toast('success', t(k ? 'caps.anysearchSaved' : 'caps.anysearchCleared'));
    // capability refresh so the hosted worker re-reports the engine
    if (storedProviders().length > 0) {
      try { setModelsCache(await pushProviders(storedProviders())); } catch { /* best-effort */ }
    }
  };
  const caps = data?.capabilities;
  const visionModels = (data?.models ?? []).filter((m) => m.vision);
  // an old proxy / offline fetch reports nothing — say nothing, not "missing"
  if (!caps) return null;
  const hasVision = visionModels.length > 0;
  const dot = (on: boolean) => (
    <span className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1.5 ${on ? 'bg-success' : 'bg-input'}`} />
  );
  const anysearchKeyRow = (hintKey: 'caps.anysearchHintQuota' | 'caps.anysearchHintEnable') => (
    <div className="mt-1">
      <Input
        type="password"
        value={anysearchDraft}
        onChange={(e) => setAnysearchDraft(e.target.value)}
        onBlur={() => void saveAnysearchKey()}
        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
        onClick={(e) => e.stopPropagation()}
        placeholder={t('caps.anysearchKeyPlaceholder')}
        data-anysearch-key
        className="w-full text-2xs text-muted-foreground font-mono"
      />
      <p className="text-2xs text-muted-foreground leading-relaxed mt-0.5">
        {t(hintKey)}{' '}
        <a href="https://www.anysearch.com" target="_blank" rel="noreferrer" className="text-primary hover:underline" onClick={(e) => e.stopPropagation()}>anysearch.com</a>
      </p>
    </div>
  );
  return (
    <div className="border-t border-border mt-1.5 pt-1 pb-1">
      <p className="text-2xs text-muted-foreground uppercase tracking-wider font-medium px-3 pt-1 pb-1">{t('caps.title')}</p>
      <div className="px-3 py-1 flex items-start gap-2">
        {dot(!!caps?.webSearch)}
        <div className="flex-1 min-w-0">
          <p className="text-2xs text-muted-foreground font-medium">{t('caps.webSearch')}</p>
          {caps?.webSearch ? (
            <Select
              value={searchEnginePref}
              onValueChange={(v) => setSearchEnginePref(v as string)}
              items={{
                server: fmt(t('caps.engineServer'), { engine: caps.searchEngine }),
                search_std: t('caps.engineStd'),
                search_pro: t('caps.enginePro'),
                anysearch: t('caps.engineAnysearch'),
              }}
            >
              <SelectTrigger size="sm" className="mt-1 w-full" title={t('caps.enginePickTitle')} onClick={(e) => e.stopPropagation()}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="server">{fmt(t('caps.engineServer'), { engine: caps.searchEngine })}</SelectItem>
                <SelectItem value="search_std">{t('caps.engineStd')}</SelectItem>
                <SelectItem value="search_pro">{t('caps.enginePro')}</SelectItem>
                {(caps.anysearch || anysearchKey) && <SelectItem value="anysearch">{t('caps.engineAnysearch')}</SelectItem>}
              </SelectContent>
            </Select>
          ) : (
            <p className="text-2xs text-muted-foreground leading-relaxed mt-0.5">{t('caps.webSearchOff')}</p>
          )}
          {caps?.webSearch && searchEnginePref === 'anysearch' && anysearchKeyRow('caps.anysearchHintQuota')}
          {!caps?.webSearch && anysearchKeyRow('caps.anysearchHintEnable')}
        </div>
      </div>
      <div className="px-3 py-1 flex items-start gap-2">
        {dot(true)}
        <p className="text-2xs text-muted-foreground leading-relaxed flex-1">
          <span className="text-muted-foreground font-medium">{t('caps.scholar')}</span>{' · '}{t('caps.scholarDesc')}
        </p>
      </div>
      <div className="px-3 py-1 flex items-start gap-2">
        {dot(hasVision)}
        <div className="flex-1 min-w-0">
          <p className="text-2xs text-muted-foreground font-medium">{t('caps.vision')}</p>
          {hasVision ? (
            <Select
              value={visionModels.some((m) => m.id === visionModelPref) ? visionModelPref : 'auto'}
              onValueChange={(v) => setVisionModelPref(v as string)}
              items={{
                auto: t('caps.visionAuto'),
                ...Object.fromEntries(visionModels.map((m) => [m.id, m.id.split('/').pop()!])),
              }}
            >
              <SelectTrigger size="sm" className="mt-1 w-full" title={t('caps.visionPickTitle')} onClick={(e) => e.stopPropagation()}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t('caps.visionAuto')}</SelectItem>
                {visionModels.map((m) => (
                  <SelectItem key={m.id} value={m.id}>{m.id.split('/').pop()}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <p className="text-2xs text-muted-foreground leading-relaxed mt-0.5">{t('caps.visionOff')}</p>
          )}
        </div>
      </div>
    </div>
  );
}
