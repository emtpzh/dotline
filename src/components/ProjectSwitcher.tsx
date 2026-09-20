import { useRef, useState } from 'react';
import { Archive, ChevronDown, Dna, FolderOpen, Loader2, Map as MapIcon, Pencil, Plus, RefreshCw, Trash2, Upload } from 'lucide-react';
import SessionAtlas from './SessionAtlas';
import { knownSessionIds } from '../lib/atlas/discover';
import { useProjects, switchProject, createProject, renameProject, deleteProject, setProjectArchived } from '../store/projects';
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

export default function ProjectSwitcher({ onSwitched }: { onSwitched: () => void }) {
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
    // z-20: the open dropdown must cover the content palette below (both
    // live on the left edge; the palette is z-10)
    <div ref={rootRef} className="absolute top-4 left-4 z-20">
      <Popover open={open} onOpenChange={setOpen}>
      <div className="flex items-center gap-1.5">
        <PopoverTrigger
          disabled={switching}
          render={<Button variant="chrome" className="gap-2 px-3 text-xs text-foreground max-w-[220px]" />}
        >
          {switching
            ? <Loader2 strokeWidth={1.75} className="animate-spin text-primary" />
            : activeIsParadigm
              ? <Dna strokeWidth={1.75} className="text-primary" />
              : <FolderOpen strokeWidth={1.75} className="text-muted-foreground" />}
          <span className="truncate font-medium">{active?.name ?? '…'}</span>
          <ChevronDown strokeWidth={1.75} className="text-muted-foreground" />
        </PopoverTrigger>
        {/* the twin badge: this canvas is one face of a session — the
            other face is one click away on the map */}
        {!!active?.sourceSession?.sessionId && (() => {
          // three states, honest about the source: reachable (live),
          // unreachable on this machine (grey — the ledger holds only
          // UUIDs, so the moment the source appears anywhere in a
          // scanned root, listening resumes on its own), or no scan yet
          // (assume live: never a false alarm)
          const unreachable = knownSessionIds.size > 0 && !knownSessionIds.has(active.sourceSession.sessionId);
          return (
            <Button variant="chrome"
              title={unreachable
                ? ti('switcher.mirrorBadgeGone')
                : fmt(ti('switcher.mirrorBadge'), { runner: active.sourceSession!.runner })}
              onClick={() => { setAtlasFocus(active.sourceSession!.sessionId); setAtlasOpen(true); }}
              className={`gap-1 px-2 text-2xs font-mono ${unreachable ? 'text-muted-foreground/50 line-through decoration-1' : 'hover:text-primary'}`}
              data-twin-badge={unreachable ? 'unreachable' : 'live'}
            >
              ⇄ {active.sourceSession!.runner}
            </Button>
          );
        })()}
      </div>

      <PopoverContent align="start" sideOffset={6} className="w-[280px] gap-0 p-0 py-1.5">
          <div className="max-h-[320px] overflow-y-auto">
            {sorted.map((p) => (
              <div
                key={p.id}
                className={`group flex items-center gap-1 px-3 py-2 hover:bg-accent cursor-pointer transition-colors ${p.id === activeId ? 'bg-primary/5' : ''}`}
                onClick={() => { if (renamingId !== p.id && p.id !== activeId) void doSwitch(p.id); }}
              >
                {renamingId === p.id ? (
                  <Input
                    autoFocus
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !isImeComposing(e) && renameValue.trim()) {
                        void renameProject(p.id, renameValue.trim());
                        setRenamingId(null);
                      }
                      if (e.key === 'Escape') setRenamingId(null);
                    }}
                    onBlur={() => setRenamingId(null)}
                    className="flex-1 border-primary/40"
                  />
                ) : (
                  <>
                    <div className="flex-1 min-w-0">
                      {/* the name owns its line; provenance rides below with the time */}
                      <div className={`text-xs truncate ${p.id === activeId ? 'text-primary font-medium' : 'text-foreground'}`}>
                        {p.name}
                      </div>
                      <div className="text-2xs text-muted-foreground flex items-center gap-1.5">
                        <span>{relativeTime(p.updatedAt)}</span>
                        {!!p.sourceSession?.sessionId && (
                          <span className="font-mono border border-border rounded px-1 py-px" data-mirror-mark>
                            {p.sourceSession.runner}
                          </span>
                        )}
                      </div>
                    </div>
                    <Button variant="ghost"
                      title={t('switcher.rename')}
                      className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-foreground shrink-0"
                      onClick={(e) => { e.stopPropagation(); setRenamingId(p.id); setRenameValue(p.name); }}
                    >
                      <Pencil size={14} strokeWidth={1.75} />
                    </Button>
                    <Button variant="ghost"
                      title={t('common.delete')}
                      className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive/90 shrink-0"
                      onClick={(e) => { e.stopPropagation(); void confirmDelete(p); }}
                    >
                      <Trash2 size={14} strokeWidth={1.75} />
                    </Button>
                    <Button variant="ghost"
                      title={t('switcher.archive')}
                      className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-warning/90 shrink-0"
                      onClick={(e) => { e.stopPropagation(); void setProjectArchived(p.id, true).then(onSwitched); }}
                      data-archive-canvas
                    >
                      <Archive size={14} strokeWidth={1.75} />
                    </Button>
                  </>
                )}
              </div>
            ))}
          </div>

          <div className="border-t border-border mt-1 pt-1">
            <Button variant="ghost" size="sm"
              onClick={() => { setOpen(false); void createProject().then(onSwitched); }}
              className="w-full text-left text-xs text-primary hover:bg-accent"
            >
              <Plus size={15} strokeWidth={1.75} /> {t('switcher.newCanvas')}
            </Button>
            <Button variant="ghost" size="sm"
              onClick={() => importFileRef.current?.click()}
              className="w-full text-left text-xs text-muted-foreground hover:bg-accent"
            >
              <Upload size={15} strokeWidth={1.75} /> {t('switcher.importBackup')}
            </Button>
            <Button variant="ghost" size="sm"
              onClick={() => { setOpen(false); setAtlasOpen(true); }}
              className="w-full text-left text-xs text-muted-foreground hover:bg-accent"
              data-open-atlas
            >
              <MapIcon size={15} strokeWidth={1.75} /> {t('switcher.allCanvases')}
            </Button>
            {window.desktop && (
              <Button variant="ghost" size="sm"
                onClick={() => { setOpen(false); void window.desktop!.checkForUpdates(); }}
                className="w-full text-left text-xs text-muted-foreground hover:bg-accent"
                data-check-updates
              >
                <RefreshCw size={15} strokeWidth={1.75} /> {t('update.checkMenu')}
                {/* the one place that answers "which version am I on" at a glance */}
                <span className="ml-auto text-2xs text-muted-foreground">
                  v{new URLSearchParams(window.location.search).get('dv')}
                </span>
              </Button>
            )}
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
          </div>
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
