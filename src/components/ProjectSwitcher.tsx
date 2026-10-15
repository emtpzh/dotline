import { useRef, useState } from 'react';
import { Archive, ArchiveRestore, ChevronDown, Dna, FolderOpen, Loader2, Map as MapIcon, MoreHorizontal, Pencil, Plus, RefreshCw, SquareTerminal, Trash2, Upload } from 'lucide-react';
import SessionAtlas from './SessionAtlas';
import { knownSessionIds, runnerLabel } from '../lib/atlas/discover';
import { useProjects, switchProject, createProject, renameProject, deleteProject, setProjectArchived, mainSubscription, type ProjectMeta } from '../store/projects';
import { useI18n } from '../i18n';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut } from './ui/dropdown-menu';
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from './ui/command';
import { parseImportFile } from '../lib/export';
import ImportChatModal from './ImportChatModal';
import type { ImportableConversation } from '../lib/import-chat';
import { confirmDialog, toast } from '../lib/ui-store';
import { isImeComposing } from '../utils';
import { useT, t as ti, fmt } from '../i18n';
import { Button } from './ui/button';
import { Input } from './ui/input';


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
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const importFileRef = useRef<HTMLInputElement>(null);
  // the row being renamed, for its menu: read when the menu closes
  const renaming = useRef<string | null>(null);
  const startRename = (p: ProjectMeta) => { renaming.current = p.id; setRenamingId(p.id); setRenameValue(p.name); };
  const endRename = () => { renaming.current = null; setRenamingId(null); };

  const active = projects.find((p) => p.id === activeId);
  // a switcher first: the most recent canvas on top, the search narrows
  // by name, and archived canvases stay out of the way until asked for
  // (a search reaches them too — "where did that canvas go" has an answer)
  const q = query.trim().toLowerCase();
  const byRecent = (a: ProjectMeta, b: ProjectMeta) => b.updatedAt - a.updatedAt;
  const matches = (p: ProjectMeta) => !q || p.name.toLowerCase().includes(q);
  const live = projects.filter((p) => !p.archived && matches(p)).sort(byRecent);
  const archived = projects.filter((p) => p.archived && matches(p)).sort(byRecent);
  const archivedTotal = projects.filter((p) => p.archived).length;
  const archivedShown = (showArchived || !!q) && archived.length > 0;

  // tidy vs destroy are different verbs — and the delete confirm is a
  // uniqueness detector: it says exactly what would be lost
  const confirmDelete = async (p: ProjectMeta) => {
    setOpen(false);
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

  // archiving loses nothing, so it asks nothing — the toast carries the way back
  const archive = async (p: ProjectMeta) => {
    await setProjectArchived(p.id, true);
    onSwitched();
    toast('success', fmt(ti('switcher.archived'), { name: p.name }), 6000, {
      label: ti('common.undo'),
      run: () => void setProjectArchived(p.id, false),
    });
  };

  const doSwitch = async (id: string) => {
    setOpen(false);
    if (id === activeId) return;
    await switchProject(id);
    onSwitched();
    // arrival reconciliation: heal the subscriptions, then close the mirror gap
    // (the live watcher only follows the ACTIVE canvas — this one may
    // have missed its sessions' growth while another was open)
    void import('../lib/atlas/canonical').then((m) => m.unsubscribeOrphanedSessions());
    void import('../lib/atlas/live-mirror').then((m) => m.sweepRecentSessions());
  };

  // an archived canvas comes back where it was asked for: restored and opened
  const restore = async (p: ProjectMeta) => {
    await setProjectArchived(p.id, false);
    await doSwitch(p.id);
  };

  const row = (p: ProjectMeta) => {
    // rename takes the whole row: an input inside a menu item would fight
    // the item for the pointer and the keys
    if (renamingId === p.id) return (
      <div key={p.id} className="p-1">
        <Input
          autoFocus
          aria-label={t('switcher.rename')}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={(e) => {
            // the list listens for Enter/arrows; while renaming, the field owns them
            e.stopPropagation();
            if (e.key === 'Enter' && !isImeComposing(e) && renameValue.trim()) {
              void renameProject(p.id, renameValue.trim());
              endRename();
            }
            if (e.key === 'Escape') endRename();
          }}
          onBlur={endRename}
        />
      </div>
    );
    const main = mainSubscription(p);
    return (
      // the row menu rides beside the item, not inside it — a nested
      // button would swallow the item's own click target
      // one line per canvas: a long list still fits a glance. What kind of
      // canvas it is rides the icon (a session's mirror wears a terminal),
      // and the row menu shows on the row under the pointer or the keys
      <div key={p.id} className="group/row relative">
        <CommandItem
          value={p.id}
          onSelect={() => void (p.archived ? restore(p) : doSwitch(p.id))}
          data-checked={p.id === activeId}
          className="pr-9"
          data-canvas-row={p.id}
        >
          {p.kind === 'paradigm'
            ? <Dna className="text-primary" />
            : main
              ? <SquareTerminal className="text-muted-foreground" aria-label={runnerLabel(main.runner)} data-mirror-mark />
              : <FolderOpen className="text-muted-foreground" />}
          <span className="min-w-0 flex-1 truncate" title={main ? `${p.name} · ${runnerLabel(main.runner)}` : p.name}>{p.name}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{relativeTime(p.updatedAt)}</span>
        </CommandItem>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="icon-xs" className="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground opacity-0 group-hover/row:opacity-100 group-has-data-selected/row:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100" aria-label={t('atlas.more')} />}>
            <MoreHorizontal />
          </DropdownMenuTrigger>
          {/* the field replaces the row, menu and all: a menu closing hands
              focus back to where it was before it opened (the search box),
              which would take it from the field and end the rename at once */}
          <DropdownMenuContent align="end" finalFocus={() => renaming.current !== p.id}>
            <DropdownMenuItem onClick={() => startRename(p)}><Pencil />{t('switcher.rename')}</DropdownMenuItem>
            {p.archived
              ? <DropdownMenuItem onClick={() => void restore(p)}><ArchiveRestore />{t('switcher.restore')}</DropdownMenuItem>
              : <DropdownMenuItem title={t('switcher.archiveHint')} onClick={() => void archive(p)} data-archive-canvas><Archive />{t('switcher.archive')}</DropdownMenuItem>}
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => void confirmDelete(p)}><Trash2 />{t('common.delete')}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  };

  // a canvas that mirrors a session says so on its own name — the icon its
  // row wears in the list, and a hint with the source. Three states, honest
  // about the source: reachable (live), unreachable on this machine (faded —
  // a subscription holds only UUIDs, so the moment the source appears in a
  // scanned root, listening resumes on its own), or no scan yet (assume
  // live: never a false alarm)
  const mirror = mainSubscription(active);
  const unreachable = !!mirror && knownSessionIds.size > 0 && !knownSessionIds.has(mirror.sessionId);
  const mirrorHint = mirror && (unreachable ? ti('switcher.mirrorBadgeGone') : fmt(ti('switcher.mirrorBadge'), { runner: runnerLabel(mirror.runner) }));
  const triggerTitle = [iconOnly ? active?.name : null, mirrorHint].filter(Boolean).join('\n') || undefined;

  return (
    // in flow: the top bar's left cluster places it (and gives it z-20 over
    // the content palette); it is the cluster's one shrinkable part, so a
    // tight row truncates the canvas name before anything overlaps
    <div className="relative min-w-0">
      <Popover open={open} onOpenChange={(next) => { setOpen(next); if (next) { setQuery(''); setShowArchived(false); } else endRename(); }}>
        <div className="flex min-w-0 items-center gap-1.5">
          <PopoverTrigger
            disabled={switching}
            render={<Button variant="chrome" className={iconOnly ? 'gap-1 px-2 text-xs text-foreground' : 'gap-2 px-3 text-xs text-foreground min-w-36 max-w-[220px] shrink'} />}
            title={triggerTitle}
            data-mirror={mirror ? (unreachable ? 'unreachable' : 'live') : undefined}
          >
            {switching
              ? <Loader2 strokeWidth={1.75} className="animate-spin text-primary" />
              : activeIsParadigm
                ? <Dna strokeWidth={1.75} className="text-primary" />
                : mirror
                  ? <SquareTerminal strokeWidth={1.75} className={unreachable ? 'text-muted-foreground/40' : 'text-muted-foreground'} />
                  : <FolderOpen strokeWidth={1.75} className="text-muted-foreground" />}
            {!iconOnly && <span className="truncate font-medium">{active?.name ?? '…'}</span>}
            <ChevronDown strokeWidth={1.75} className="text-muted-foreground" />
          </PopoverTrigger>
          {/* on a mirror canvas the map opens on the session it mirrors —
              the other face of this canvas, one click away */}
          <Button
            variant="chrome"
            size={iconOnly ? 'icon' : 'default'}
            className={iconOnly ? undefined : 'px-3 text-xs'}
            aria-label={t('switcher.sessionAtlas')}
            title={t('switcher.sessionAtlas')}
            onClick={() => { setAtlasFocus(mirror?.sessionId); setAtlasOpen(true); }}>
            <MapIcon strokeWidth={1.75} />
            {!iconOnly && t('switcher.sessionAtlas')}
          </Button>
        </div>

        <PopoverContent align="start" sideOffset={6} className="w-[320px] gap-0 p-0" data-canvas-manager>
          {/* a menu, not a hand-built list: cmdk owns the row metrics,
              hover/keyboard highlight and the tick on the open canvas */}
          <Command shouldFilter={false} className="bg-transparent">
            <CommandInput autoFocus placeholder={t('switcher.search')} value={query} onValueChange={setQuery} />
            <CommandList className="max-h-[min(420px,60dvh)]">
              <CommandGroup>
                {live.map(row)}
                {!live.length && !archivedShown && <p className="px-2 py-4 text-center text-xs text-muted-foreground">{t('switcher.noResults')}</p>}
              </CommandGroup>
              {archivedShown && (
                <CommandGroup heading={fmt(t('atlas.archivedGroup'), { n: archived.length })} data-archived-group>
                  {archived.map(row)}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
          {/* pinned under the list: however many canvases there are, the
              way to make a new one never scrolls away. The session map has
              its own button in the top bar, so it is not repeated here */}
          <div className="flex items-center gap-1 border-t border-border p-1">
            <Button variant="ghost" size="sm" className="flex-1 justify-start" disabled={switching} onClick={() => { setOpen(false); void createProject().then(onSwitched); }}>
              <Plus />
              {t('switcher.newCanvas')}
            </Button>
            {archivedTotal > 0 && (
              <Button variant="ghost" size="sm" className="text-muted-foreground" aria-pressed={showArchived} onClick={() => setShowArchived((v) => !v)} data-toggle-archived>
                <Archive />
                {showArchived ? t('switcher.hideArchived') : fmt(t('switcher.showArchived'), { n: archivedTotal })}
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={t('atlas.more')} />}>
                <MoreHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => importFileRef.current?.click()}><Upload />{t('switcher.importBackup')}</DropdownMenuItem>
                {window.desktop && (
                  <DropdownMenuItem onClick={() => { setOpen(false); void window.desktop!.checkForUpdates(); }} data-check-updates>
                    <RefreshCw />
                    {t('update.checkMenu')}
                    {/* the one place that answers "which version am I on" at a glance */}
                    <DropdownMenuShortcut>v{new URLSearchParams(window.location.search).get('dv')}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
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
