import { useRef, useState } from 'react';
import { Archive, ArchiveRestore, ChevronDown, Layers, LayoutGrid, Map as MapIcon, MoreHorizontal, Pencil, Plus, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import SessionAtlas from './SessionAtlas';
import CanvasOrganizer from './CanvasOrganizer';
import CanvasTabs from './CanvasTabs';
import CanvasIcon from './CanvasIcon';
import { runnerLabel } from '../lib/atlas/discover';
import { useProjects, createProject, renameProject, deleteProject, setProjectArchived, stashProject, mainSubscription, type ProjectMeta } from '../store/projects';
import { openCanvas } from '../lib/open-canvas';
import { useI18n } from '../i18n';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut } from './ui/dropdown-menu';
import { Command, CommandGroup, CommandInput, CommandItem, CommandList, CommandShortcut } from './ui/command';
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

/**
 * The canvas chrome on the left of the top bar: the library (every canvas,
 * grouped as open, stashed and archived), the open canvases as tabs, a new
 * canvas, and the session map. compact: the top bar's last resort for room —
 * only the tab in view stays, the others fold into a menu beside it.
 */
export default function ProjectSwitcher({ onSwitched, compact = false }: { onSwitched: () => void; compact?: boolean }) {
  const t = useT();
  const projects = useProjects((s) => s.projects);
  const activeId = useProjects((s) => s.activeId);
  const openIds = useProjects((s) => s.openIds);
  const switching = useProjects((s) => s.switching);
  const [open, setOpen] = useState(false);
  const [chatImport, setChatImport] = useState<ImportableConversation[] | null>(null);
  const [atlasOpen, setAtlasOpen] = useState(false);
  const [atlasFocus, setAtlasFocus] = useState<string | undefined>(undefined);
  const [organizerOpen, setOrganizerOpen] = useState(false);
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
  // a library first: the open canvases in their tab order on top, then the
  // stashed ones, most recent first; the search narrows by name, and
  // archived canvases stay out of the way until asked for (a search reaches
  // them too — "where did that canvas go" has an answer)
  const q = query.trim().toLowerCase();
  const byRecent = (a: ProjectMeta, b: ProjectMeta) => b.updatedAt - a.updatedAt;
  const matches = (p: ProjectMeta) => !q || p.name.toLowerCase().includes(q);
  const isOpen = new Set(openIds);
  const opened = openIds.map((id) => projects.find((p) => p.id === id)).filter((p): p is ProjectMeta => !!p && matches(p));
  const stashed = projects.filter((p) => !p.archived && !isOpen.has(p.id) && matches(p)).sort(byRecent);
  const archived = projects.filter((p) => p.archived && matches(p)).sort(byRecent);
  const archivedTotal = projects.filter((p) => p.archived).length;
  const archivedShown = (showArchived || !!q) && archived.length > 0;

  // a row's action brings another canvas into view only when it acted on
  // the canvas in view; the camera of a canvas that stays is left alone
  const keepingView = async (action: () => Promise<unknown>) => {
    const before = useProjects.getState().activeId;
    await action();
    if (useProjects.getState().activeId !== before) onSwitched();
  };

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
    if (ok) void keepingView(() => deleteProject(p.id));
  };

  // archiving loses nothing, so it asks nothing — the toast carries the way back
  const archive = async (p: ProjectMeta) => {
    await keepingView(() => setProjectArchived(p.id, true));
    toast('success', fmt(ti('switcher.archived'), { name: p.name }), 6000, {
      label: ti('common.undo'),
      run: () => void setProjectArchived(p.id, false),
    });
  };

  // neither does stashing: the canvas waits here, as it was left
  const stash = (p: ProjectMeta) => keepingView(() => stashProject(p.id));

  // opening a canvas makes it a tab (beside the one in view), as it was left
  // (its arrival frames the camera)
  const doSwitch = async (id: string) => {
    setOpen(false);
    await openCanvas(id);
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
    const tabbed = isOpen.has(p.id);
    return (
      // the row menu rides beside the item, not inside it — a nested
      // button would swallow the item's own click target
      // one line per canvas: a long list still fits a glance. What kind of
      // canvas it is, and what goes on there, rides the icon (CanvasIcon);
      // the one in view is set in the heavier weight, and the row menu
      // takes the time's place on the row under the pointer or the keys —
      // no gutter held empty for it, no tick beside it
      <div key={p.id} className="group/row relative">
        <CommandItem
          value={p.id}
          onSelect={() => void (p.archived ? restore(p) : doSwitch(p.id))}
          data-checked={p.id === activeId}
          className={p.id === activeId ? 'font-medium text-foreground' : undefined}
          data-canvas-row={p.id}
          data-canvas-open={tabbed || undefined}
        >
          <CanvasIcon canvas={p} />
          <span className="min-w-0 flex-1 truncate" title={main ? `${p.name} · ${runnerLabel(main.runner)}` : p.name}>{p.name}</span>
          <CommandShortcut className="shrink-0 font-normal tracking-normal tabular-nums group-hover/row:invisible group-has-data-selected/row:invisible">{relativeTime(p.updatedAt)}</CommandShortcut>
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
            {tabbed && openIds.length > 1 && (
              <DropdownMenuItem title={t('tabs.stashHint')} onClick={() => void stash(p)} data-stash-canvas><X />{t('tabs.stash')}</DropdownMenuItem>
            )}
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

  // on a mirror canvas the map opens on the session it mirrors — the other
  // face of this canvas, one click away
  const mirror = mainSubscription(active);
  const newCanvas = () => { setOpen(false); void createProject().then(onSwitched); };

  return (
    // in flow: the top bar's left cluster places it (and gives it z-20 over
    // the content palette); the tabs are its one shrinkable part, so a tight
    // row narrows them first, down to a name's worth each. Past that they
    // clip, which the top bar's squeeze reads (CanvasTabs marks the row) to
    // fold its tools, and last the tabs themselves
    <div className="relative flex min-w-0 items-center gap-1.5">
      <div className="flex h-8 min-w-0 items-center gap-0.5 rounded-lg border border-border bg-card/90 p-0.5 shadow-sm backdrop-blur" data-canvas-desktops>
        <Popover open={open} onOpenChange={(next) => { setOpen(next); if (next) { setQuery(''); setShowArchived(false); } else endRename(); }}>
          <PopoverTrigger
            render={<Button variant="ghost" size="xs" className="shrink-0 gap-0.5 px-1.5 text-muted-foreground" aria-label={t('switcher.library')} title={t('switcher.library')} data-canvas-library />}
          >
            <Layers strokeWidth={1.75} />
            <ChevronDown strokeWidth={1.75} />
          </PopoverTrigger>
          <PopoverContent align="start" sideOffset={8} className="w-[320px] gap-0 p-0" data-canvas-manager>
            {/* a menu, not a hand-built list: cmdk owns the row metrics,
                hover/keyboard highlight and the tick on the open canvas */}
            <Command shouldFilter={false} className="bg-transparent">
              <CommandInput autoFocus placeholder={t('switcher.search')} value={query} onValueChange={setQuery} />
              <CommandList className="max-h-[min(420px,60dvh)]">
                {opened.length > 0 && (
                  <CommandGroup heading={t('switcher.openGroup')} data-open-group>
                    {opened.map(row)}
                  </CommandGroup>
                )}
                {stashed.length > 0 && (
                  <CommandGroup heading={t('switcher.stashedGroup')} data-stashed-group>
                    {stashed.map(row)}
                  </CommandGroup>
                )}
                {!opened.length && !stashed.length && !archivedShown && <p className="px-2 py-4 text-center text-xs text-muted-foreground">{t('switcher.noResults')}</p>}
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
              <Button variant="ghost" size="sm" className="flex-1 justify-start" disabled={switching} onClick={newCanvas}>
                <Plus />
                {t('switcher.newCanvas')}
              </Button>
              {projects.some((p) => !p.archived && p.kind !== 'paradigm') && (
                <Button variant="ghost" size="sm" className="text-muted-foreground" disabled={switching} title={t('organizer.openHint')} onClick={() => { setOpen(false); setOrganizerOpen(true); }} data-open-organizer>
                  <LayoutGrid />
                  {t('organizer.open')}
                </Button>
              )}
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
        <CanvasTabs onSwitched={onSwitched} compact={compact} />
        <Button
          variant="ghost"
          size="icon-xs"
          className="shrink-0 text-muted-foreground"
          disabled={switching}
          aria-label={t('switcher.newCanvas')}
          title={t('tabs.newHint')}
          onClick={newCanvas}
          data-new-canvas
        >
          <Plus strokeWidth={1.75} />
        </Button>
      </div>
      <Button
        variant="chrome"
        size={compact ? 'icon' : 'default'}
        className={compact ? 'shrink-0' : 'shrink-0 px-3 text-xs'}
        aria-label={t('switcher.sessionAtlas')}
        title={t('switcher.sessionAtlas')}
        onClick={() => { setAtlasFocus(mirror?.sessionId); setAtlasOpen(true); }}>
        <MapIcon strokeWidth={1.75} />
        {!compact && t('switcher.sessionAtlas')}
      </Button>
      {chatImport && (
        <ImportChatModal
          conversations={chatImport}
          onClose={() => setChatImport(null)}
          onDone={() => { setChatImport(null); onSwitched(); }}
        />
      )}
      {organizerOpen && <CanvasOrganizer onClose={() => setOrganizerOpen(false)} onSwitched={onSwitched} />}
      {atlasOpen && <SessionAtlas onClose={() => { setAtlasOpen(false); setAtlasFocus(undefined); }} onSwitched={onSwitched} focusSessionId={atlasFocus} />}
    </div>
  );
}
