import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, ChevronDown, Pencil, X } from 'lucide-react';
import { useProjects, stashProject, stashOthers, moveTab, renameProject, setProjectArchived, mainSubscription, type ProjectMeta } from '../store/projects';
import { openCanvas } from '../lib/open-canvas';
import { tabAt, tabBeside } from '../lib/workspace';
import { runnerLabel } from '../lib/atlas/discover';
import { toast, useUiStore } from '../lib/ui-store';
import { isViewerMode } from '../lib/viewer';
import { isImeComposing } from '../utils';
import { useT, t as ti, fmt } from '../i18n';
import CanvasIcon from './CanvasIcon';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut, ContextMenuTrigger } from './ui/context-menu';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuShortcut, DropdownMenuTrigger } from './ui/dropdown-menu';

// The open canvases as tabs — the desktops of this app. A click brings one
// into view as it was left; × stashes it (it waits in the library); a drag
// puts it elsewhere in the row; the keys jump between them. A tab out of
// view says what goes on there (CanvasIcon).

const MAC = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.userAgent);
// the desktop app takes the keys a browser keeps for its own tabs
const DESKTOP = typeof window !== 'undefined' && !!window.desktop;
const jumpKey = (n: number) => (DESKTOP ? (MAC ? `⌘${n}` : `Ctrl+${n}`) : (MAC ? `⌥${n}` : `Alt+${n}`));
/** the key that reaches the nth of `count` tabs, if one does (9 is the last) */
const keyFor = (n: number, count: number) => (n <= 8 ? jumpKey(n) : n === count ? jumpKey(9) : null);
const TAB_TYPE = 'application/x-dotline-tab';

/** compact: the top bar short of room — the canvas in view keeps its tab,
 *  the other open ones fold into a menu beside it. hidden: its last resort —
 *  no tab is drawn (the library lists them), the keys still switch. */
export default function CanvasTabs({ onSwitched, compact = false, hidden = false }: { onSwitched: () => void; compact?: boolean; hidden?: boolean }) {
  const t = useT();
  const projects = useProjects((s) => s.projects);
  const openIds = useProjects((s) => s.openIds);
  const activeId = useProjects((s) => s.activeId);
  const tabs = openIds.map((id) => projects.find((p) => p.id === id)).filter((p): p is ProjectMeta => !!p);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  // the tab being renamed, for its menu: read when the menu closes
  const renaming = useRef<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<{ id: string; after: boolean } | null>(null);

  // the canvas comes into view as it was left: its arrival frames the camera
  const go = useCallback(async (id: string) => { await openCanvas(id); }, []);
  // a tab's own action brings another canvas into view only when it was the
  // tab in view; the camera of a canvas that stays is left where it is
  const keepingView = async (action: () => Promise<unknown>) => {
    const before = useProjects.getState().activeId;
    await action();
    if (useProjects.getState().activeId !== before) onSwitched();
  };

  const startRename = (p: ProjectMeta) => { renaming.current = p.id; setRenamingId(p.id); setRenameValue(p.name); };
  const endRename = () => { renaming.current = null; setRenamingId(null); };

  // stashing loses nothing, so it asks nothing; the toast carries the way back
  const stash = async (p: ProjectMeta) => {
    await keepingView(() => stashProject(p.id));
    toast('success', fmt(ti('tabs.stashed'), { name: p.name }), 6000, {
      label: ti('tabs.reopen'),
      run: () => void go(p.id),
    });
  };
  const archive = async (p: ProjectMeta) => {
    await keepingView(() => setProjectArchived(p.id, true));
    toast('success', fmt(ti('switcher.archived'), { name: p.name }), 6000, {
      label: ti('common.undo'),
      run: () => void setProjectArchived(p.id, false),
    });
  };

  // Alt+1…9 everywhere; ⌘1…9 (Ctrl on Windows and Linux) and Ctrl+Tab in
  // the desktop app. 9 is the last tab, the way browsers count. A modal
  // dialog keeps the keys. In a field Alt+digit types a character on a Mac
  // (¡, or a bracket on some layouts), so a field gives the key up only
  // while it is empty — the box a new canvas focuses — and only for a tab
  // that is there.
  useEffect(() => {
    if (isViewerMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (useUiStore.getState().confirmRequest) return;
      const el = document.activeElement;
      if (el instanceof HTMLElement && el.closest('[role="dialog"], [role="alertdialog"]')) return;
      const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value
        : el instanceof HTMLElement && el.isContentEditable ? el.textContent ?? '' : null;
      const { openIds: open, activeId: cur, switching: busy } = useProjects.getState();
      const digit = /^Digit([1-9])$/.exec(e.code);
      const n = digit ? Number(digit[1]) : 0;
      const cmd = MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      let target: string | null = null;
      if (digit && !e.shiftKey && DESKTOP && cmd && !e.altKey) {
        target = tabAt(open, n);
      } else if (digit && !e.shiftKey && e.altKey && !e.metaKey && !e.ctrlKey) {
        target = field === null ? tabAt(open, n) : field === '' ? open[n - 1] ?? null : null;
      } else if (DESKTOP && e.key === 'Tab' && e.ctrlKey && !e.metaKey && !e.altKey) {
        target = tabBeside(open, cur, e.shiftKey ? -1 : 1);
      }
      if (!target) return;
      e.preventDefault();
      if (!busy && target !== cur) void go(target);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go]);

  const drop = (e: React.DragEvent) => {
    const id = e.dataTransfer.getData(TAB_TYPE);
    const at = dropAt;
    setDragging(null);
    setDropAt(null);
    if (!id || !at || id === at.id) return;
    e.preventDefault();
    const rest = openIds.filter((x) => x !== id);
    void moveTab(id, rest.indexOf(at.id) + (at.after ? 1 : 0));
  };

  const tab = (p: ProjectMeta, n: number) => {
    const active = p.id === activeId;
    if (renamingId === p.id) return (
      <Input
        key={p.id}
        autoFocus
        aria-label={t('switcher.rename')}
        className="h-6 w-40 shrink-0 rounded-md px-2 text-xs md:text-xs"
        value={renameValue}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setRenameValue(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && !isImeComposing(e) && renameValue.trim()) {
            void renameProject(p.id, renameValue.trim());
            endRename();
          }
          if (e.key === 'Escape') endRename();
        }}
        onBlur={endRename}
      />
    );
    const main = mainSubscription(p);
    const closable = tabs.length > 1;
    const hint = [p.name, main ? fmt(ti('switcher.mirrorBadge'), { runner: runnerLabel(main.runner) }) : null, keyFor(n, tabs.length)].filter(Boolean).join(' · ');
    return (
      <ContextMenu key={p.id}>
        <ContextMenuTrigger
          render={<div
            role="presentation"
            draggable
            onDragStart={(e) => { e.dataTransfer.setData(TAB_TYPE, p.id); e.dataTransfer.effectAllowed = 'move'; setDragging(p.id); }}
            onDragEnd={() => { setDragging(null); setDropAt(null); }}
            onDragOver={(e) => {
              if (!dragging || !e.dataTransfer.types.includes(TAB_TYPE)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = 'move';
              const r = e.currentTarget.getBoundingClientRect();
              const after = e.clientX > r.left + r.width / 2;
              if (dropAt?.id !== p.id || dropAt.after !== after) setDropAt({ id: p.id, after });
            }}
            onDrop={drop}
            // a middle click stashes, as it closes a browser tab
            onAuxClick={(e) => { if (e.button === 1 && closable) { e.preventDefault(); void stash(p); } }}
            // a tab narrows with the row but keeps a name's worth of room;
            // past that the row folds other tools, then the tabs themselves
            className={`group/tab relative flex min-w-24 shrink items-center ${dragging === p.id ? 'opacity-50' : ''}`}
            data-canvas-tab={p.id}
            data-active={active || undefined}
          />}
        >
          {/* the tab in view keeps room for its ×; another tab's × shows on
              hover over the end of its name, which fades out beneath it */}
          <Button
            variant="ghost"
            size="xs"
            role="tab"
            aria-selected={active}
            title={hint}
            onClick={() => void go(p.id)}
            className={`w-full min-w-0 max-w-44 justify-start gap-1.5 ${active
              ? `bg-accent font-medium text-foreground hover:bg-accent ${closable ? 'pr-6' : ''}`
              : 'font-normal text-muted-foreground group-hover/tab:bg-muted group-hover/tab:text-foreground dark:group-hover/tab:bg-muted/50'}`}
          >
            <CanvasIcon canvas={p} />
            <span className={`min-w-0 truncate ${closable && !active ? 'group-hover/tab:[mask-image:linear-gradient(to_left,transparent_1.25rem,black_2.25rem)]' : ''}`}>{p.name}</span>
          </Button>
          {closable && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={fmt(t('tabs.stashOne'), { name: p.name })}
              title={t('tabs.stashHint')}
              onClick={() => void stash(p)}
              className={`absolute top-0 right-0 text-muted-foreground hover:bg-transparent hover:text-foreground focus-visible:opacity-100 dark:hover:bg-transparent ${active ? '' : 'opacity-0 group-hover/tab:opacity-100'}`}
              data-stash-tab
            >
              <X />
            </Button>
          )}
          {dropAt?.id === p.id && dragging !== p.id && (
            <span className={`pointer-events-none absolute inset-y-1 w-0.5 rounded-full bg-primary ${dropAt.after ? '-right-px' : '-left-px'}`} />
          )}
        </ContextMenuTrigger>
        {/* the field replaces the tab: a menu closing hands focus back to
            the tab, which would take it from the field and end the rename */}
        <ContextMenuContent finalFocus={() => renaming.current !== p.id}>
          <ContextMenuItem onClick={() => startRename(p)}><Pencil />{t('switcher.rename')}</ContextMenuItem>
          {closable && <ContextMenuItem onClick={() => void stash(p)}><X />{t('tabs.stash')}<ContextMenuShortcut>{t('tabs.middleClick')}</ContextMenuShortcut></ContextMenuItem>}
          {closable && <ContextMenuItem inset onClick={() => void keepingView(() => stashOthers(p.id))}>{t('tabs.stashOthers')}</ContextMenuItem>}
          <ContextMenuSeparator />
          <ContextMenuItem title={t('switcher.archiveHint')} onClick={() => void archive(p)}><Archive />{t('switcher.archive')}</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  if (hidden) return null;

  if (compact) {
    const current = tabs.find((p) => p.id === activeId);
    const others = tabs.filter((p) => p.id !== activeId);
    return (
      <div role="tablist" aria-label={t('tabs.label')} className="flex min-w-0 items-center gap-0.5" data-canvas-tabs="compact">
        {current && tab(current, tabs.indexOf(current) + 1)}
        {others.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="xs" className="shrink-0 gap-0.5 px-1.5 font-normal text-muted-foreground" aria-label={t('tabs.more')} title={t('tabs.more')} />}>
              +{others.length}
              <ChevronDown />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-60">
              {others.map((p) => (
                <DropdownMenuItem key={p.id} onClick={() => void go(p.id)} data-canvas-tab={p.id}>
                  <CanvasIcon canvas={p} />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  {keyFor(tabs.indexOf(p) + 1, tabs.length) && <DropdownMenuShortcut>{keyFor(tabs.indexOf(p) + 1, tabs.length)}</DropdownMenuShortcut>}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    );
  }

  return (
    // the tabs narrow to a name's worth each; what still does not fit is
    // clipped, and the top bar's squeeze reads the clip (data-squeeze-watch)
    // to fold its tools — and, last, the tabs (compact)
    <div role="tablist" aria-label={t('tabs.label')} className="flex min-w-0 items-center gap-0.5 overflow-x-clip" data-canvas-tabs data-squeeze-watch>
      {tabs.map((p, i) => tab(p, i + 1))}
    </div>
  );
}
