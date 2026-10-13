import { useRef, useState } from 'react';
import { Archive, ChevronDown, Dna, FolderOpen, Loader2, Map as MapIcon, Pencil, Plus, RefreshCw, Trash2, Upload } from 'lucide-react';
import SessionAtlas from './SessionAtlas';
import { knownSessionIds } from '../lib/atlas/discover';
import { useProjects, switchProject, createProject, renameProject, deleteProject, setProjectArchived, mainSubscription } from '../store/projects';
import { useI18n } from '../i18n';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { parseImportFile } from '../lib/export';
import ImportChatModal from './ImportChatModal';
import type { ImportableConversation } from '../lib/import-chat';
import { confirmDialog, toast } from '../lib/ui-store';
import { isImeComposing } from '../utils';
import { useT, t as ti, fmt } from '../i18n';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Command, CommandGroup, CommandItem, CommandList, CommandSeparator, CommandShortcut } from './ui/command';

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return ti('switcher.justNow');
  if (min < 60) return fmt(ti('switcher.minAgo'), { n: min });
  const h = Math.floor(min / 60);
  if (h < 24) return fmt(ti('switcher.hourAgo'), { n: h });
  const d = Math.floor(h / 24);
  if (d < 30) return fmt(ti('switcher.dayAgo'), { n: d });
  return new Date(ts).toLocaleDateString(useI18n.getState().lang === 'zh' ? 'zh-CN' : 'en-US');
}

/** iconOnly: the top bar's last resort for room — the canvas name moves to the tooltip */
export default function ProjectSwitcher({ onSwitched, iconOnly = false }: { onSwitched: () => void; iconOnly?: boolean }) {
  const t = useT();
  const projects = useProjects((s) => s.projects);
  const activeId = useProjects((s) => s.activeId);
  const switching = useProjects((s) => s.switching);
  const activeIsParadigm = projects.find((p) => p.id === activeId)?.kind === 'paradigm';
  const [open, setOpen] = useState(false);
  const [chatImport, setChatImport] = useState<ImportableConversation[] | null>(null);
  const [atlasOpen, setAtlasOpen] = useState(false);
  const [atlasFocus, setAtlasFocus] = useState<string | undefined>(undefined);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const importFileRef = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // the menu opens focused on the LIST, not on the first row's hover action
  // (Base UI hands focus to the first tabbable element otherwise)
  const listRef = useRef<HTMLDivElement>(null);

  const active = projects.find((p) => p.id === activeId);
  // the dropdown is a time machine, not a library: recent few only,
  // archived canvases invisible, the atlas owns browsing and management
  const sorted = projects.filter((p) => !p.archived).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 7);

  // tidy vs destroy are different verbs — and the delete confirm is a
  // uniqueness detector: it says exactly what would be lost
  const confirmDelete = async (p: (typeof projects)[number]) => {
    const { canvasUniqueness } = await import('../lib/atlas/canonical');
    const u = await canvasUniqueness(p.id);
    const msgKey = u === 'native' ? 'confirm.deleteNative' : u === 'diverged-mirror' ? 'confirm.deleteDiverged' : 'confirm.deletePristine';
    const ok = await confirmDialog({
      title: ti('confirm.deleteCanvasTitle'),
      message: fmt(ti(msgKey), { name: p.name }),
      confirmLabel: ti('common.delete'),
      danger: u !== 'pristine-mirror',
    });
    if (ok) void deleteProject(p.id).then(onSwitched);
  };

  const doSwitch = async (id: string) => {
    setOpen(false);
    await switchProject(id);
    onSwitched();
    // arrival reconciliation: heal the ledger, then close the mirror gap
    // (the live watcher only follows the ACTIVE canvas — this one may
    // have missed its sessions' growth while another was open)
    void import('../lib/atlas/canonical').then((m) => m.unsubscribeOrphanedSessions());
    void import('../lib/atlas/live-mirror').then((m) => m.sweepRecentSessions());
  };

  return (
    // in flow: the top bar's left cluster places it (and gives it z-20 over
    // the content palette); it is the cluster's one shrinkable part, so a
    // tight row truncates the canvas name before anything overlaps
    <div ref={rootRef} className="relative min-w-0">
      <Popover open={open} onOpenChange={setOpen}>
      <div className="flex min-w-0 items-center gap-1.5">
        <PopoverTrigger
          disabled={switching}
          render={<Button variant="chrome" className={iconOnly ? 'gap-1 px-2 text-xs text-foreground' : 'gap-2 px-3 text-xs text-foreground min-w-36 max-w-[220px] shrink'} />}
          title={iconOnly ? active?.name : undefined}
        >
          {switching
            ? <Loader2 strokeWidth={1.75} className="animate-spin text-primary" />
            : activeIsParadigm
              ? <Dna strokeWidth={1.75} className="text-primary" />
              : <FolderOpen strokeWidth={1.75} className="text-muted-foreground" />}
          {!iconOnly && <span className="truncate font-medium">{active?.name ?? '…'}</span>}
          <ChevronDown strokeWidth={1.75} className="text-muted-foreground" />
        </PopoverTrigger>
        {/* the twin badge: this canvas is one face of a session — the
            other face is one click away on the map */}
        {!!mainSubscription(active) && (() => {
          const main = mainSubscription(active)!;
          // three states, honest about the source: reachable (live),
          // unreachable on this machine (grey — the ledger holds only
          // UUIDs, so the moment the source appears anywhere in a
          // scanned root, listening resumes on its own), or no scan yet
          // (assume live: never a false alarm)
          const unreachable = knownSessionIds.size > 0 && !knownSessionIds.has(main.sessionId);
          return (
            <Button variant="chrome"
              title={unreachable
                ? ti('switcher.mirrorBadgeGone')
                : fmt(ti('switcher.mirrorBadge'), { runner: main.runner })}
              onClick={() => { setAtlasFocus(main.sessionId); setAtlasOpen(true); }}
              className={`gap-1 px-2 text-2xs font-mono ${unreachable ? 'text-muted-foreground/50 line-through decoration-1' : 'hover:text-primary'}`}
              data-twin-badge={unreachable ? 'unreachable' : 'live'}
            >
              ⇄ {main.runner}
            </Button>
          );
        })()}
      </div>

      <PopoverContent align="start" sideOffset={6} className="w-[300px] gap-0 p-0" initialFocus={listRef}>
        {/* a menu, not a hand-built list: cmdk owns the row metrics,
            hover/keyboard highlight and the tick on the open canvas */}
        <Command ref={listRef} shouldFilter={false} className="bg-transparent">
          <CommandList className="max-h-[320px]">
            <CommandGroup>
              {sorted.map((p) => (
                // rename takes the whole row: an input inside a menu item
                // would fight the item for the pointer and the keys
                renamingId === p.id ? (
                  <div key={p.id} className="px-1 py-1">
                    <Input
                      autoFocus
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => {
                        // the list listens for Enter/arrows; while renaming, the field owns them
                        e.stopPropagation();
                        if (e.key === 'Enter' && !isImeComposing(e) && renameValue.trim()) {
                          void renameProject(p.id, renameValue.trim());
                          setRenamingId(null);
                        }
                        if (e.key === 'Escape') setRenamingId(null);
                      }}
                      onBlur={() => setRenamingId(null)}
                      className="border-primary/40"
                    />
                  </div>
                ) : (
                  // the row actions ride ON the item, not inside it — nested
                  // buttons would swallow the item's own click target
                  <div key={p.id} className="group/row relative">
                    <CommandItem
                      value={p.id}
                      onSelect={() => { if (p.id !== activeId) void doSwitch(p.id); }}
                      data-checked={p.id === activeId}
                      className="pr-24"
                    >
                      <span className="flex-1 min-w-0">
                        {/* the name owns its line; provenance rides below with the time */}
                        <span className={`block truncate text-xs ${p.id === activeId ? 'text-primary font-medium' : 'text-foreground'}`}>
                          {p.name}
                        </span>
                        <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
                          <span>{relativeTime(p.updatedAt)}</span>
                          {!!mainSubscription(p) && (
                            <span className="truncate rounded border border-border px-1 font-mono" data-mirror-mark>
                              {mainSubscription(p)!.runner}
                            </span>
                          )}
                        </span>
                      </span>
                    </CommandItem>
                    <div className="absolute inset-y-0 right-2 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
                      <Button variant="ghost" size="icon-xs" tabIndex={-1}
                        title={t('switcher.rename')}
                        className="text-muted-foreground hover:text-foreground"
                        onClick={() => { setRenamingId(p.id); setRenameValue(p.name); }}
                      >
                        <Pencil strokeWidth={1.75} />
                      </Button>
                      <Button variant="ghost" size="icon-xs" tabIndex={-1}
                        title={t('common.delete')}
                        className="text-muted-foreground hover:text-destructive/90"
                        onClick={() => void confirmDelete(p)}
                      >
                        <Trash2 strokeWidth={1.75} />
                      </Button>
                      <Button variant="ghost" size="icon-xs" tabIndex={-1}
                        title={t('switcher.archive')}
                        className="text-muted-foreground hover:text-warning/90"
                        onClick={() => void setProjectArchived(p.id, true).then(onSwitched)}
                        data-archive-canvas
                      >
                        <Archive strokeWidth={1.75} />
                      </Button>
                    </div>
                  </div>
                )
              ))}
            </CommandGroup>

            <CommandSeparator />

            <CommandGroup>
              <CommandItem
                onSelect={() => { setOpen(false); void createProject().then(onSwitched); }}
                className="text-primary"
              >
                <Plus strokeWidth={1.75} /> {t('switcher.newCanvas')}
              </CommandItem>
              <CommandItem
                onSelect={() => importFileRef.current?.click()}
                className="text-muted-foreground"
              >
                <Upload strokeWidth={1.75} /> {t('switcher.importBackup')}
              </CommandItem>
              <CommandItem
                onSelect={() => { setOpen(false); setAtlasOpen(true); }}
                className="text-muted-foreground"
                data-open-atlas
              >
                <MapIcon strokeWidth={1.75} /> {t('switcher.allCanvases')}
              </CommandItem>
              {window.desktop && (
                <CommandItem
                  onSelect={() => { setOpen(false); void window.desktop!.checkForUpdates(); }}
                  className="text-muted-foreground"
                  data-check-updates
                >
                  <RefreshCw strokeWidth={1.75} /> {t('update.checkMenu')}
                  {/* the one place that answers "which version am I on" at a glance */}
                  <CommandShortcut className="tracking-normal">
                    v{new URLSearchParams(window.location.search).get('dv')}
                  </CommandShortcut>
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>

        <input
          ref={importFileRef}
          type="file"
          accept=".json,.jsonl,application/json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) {
              // Every failure path must surface — a silently swallowed
              // rejection here reads as "the import does nothing".
              void parseImportFile(f).then((r) => {
                if (r.kind === 'own' && r.ok) { setOpen(false); onSwitched(); }
                else if (r.kind === 'chat') { setOpen(false); setChatImport(r.conversations); }
              }).catch((err) => {
                toast('error', fmt(ti('toast.importFailedGeneric'), { msg: err instanceof Error ? err.message : String(err) }));
              });
            }
            e.target.value = '';
          }}
        />
      </PopoverContent>
      </Popover>
      {chatImport && (
        <ImportChatModal
          conversations={chatImport}
          onClose={() => setChatImport(null)}
          onDone={() => { setChatImport(null); onSwitched(); }}
        />
      )}
      {atlasOpen && <SessionAtlas onClose={() => { setAtlasOpen(false); setAtlasFocus(undefined); }} onSwitched={onSwitched} focusSessionId={atlasFocus} />}
    </div>
  );
}
