import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, Folder, FolderPlus } from 'lucide-react';
import { useT } from '../../i18n';
import { Button } from '../ui/button';
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from '../ui/input-group';
import { Command, CommandGroup, CommandItem, CommandList } from '../ui/command';

// The folder dialog of a host whose own dialog would open where nobody is
// looking (a harness reached over the network, or over SSH): the host lists
// one level at a time and the person walks it here, inside the cwd popover.
// A row goes in; the crumbs go back up; the footer takes the folder shown.

const MAX_CRUMBS = 3;

export default function CwdBrowser({ start, onUse, onBack }: { start?: string; onUse: (path: string) => void; onBack: () => void }) {
  const t = useT();
  const [listing, setListing] = useState<DesktopDirListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  // a slow folder answered after a later click must not win
  const seq = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  /** list a level; a remembered folder that is gone falls back to home */
  const load = async (path: string | undefined, fallbackHome: boolean) => {
    const n = ++seq.current;
    try {
      const l = await window.desktopAgents!.listDirs!(path);
      if (n !== seq.current) return;
      setListing(l);
      setError(null);
    } catch (e) {
      if (n !== seq.current) return;
      if (fallbackHome && path) return void load(undefined, false);
      setError(e instanceof Error ? e.message : String(e));
    }
    if (n === seq.current) setLoading(false);
  };
  const go = (path: string) => {
    setLoading(true);
    setNaming(false);
    void load(path, false);
  };

  useEffect(() => {
    void load(start?.startsWith('/') ? start : undefined, true);
    listRef.current?.focus();
    // the starting folder is read once, when the browser opens
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const create = async () => {
    const v = name.trim();
    if (!v || !listing) return;
    try {
      const made = await window.desktopAgents!.createDir!(listing.path, v);
      setName('');
      go(made);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // crumbs from home down when the folder is under it ("~"), else from the
  // root; a long path keeps its last few, with "…" one step above them
  const crumbs = (() => {
    if (!listing) return [];
    const at = listing.crumbs.findIndex((c) => c.path === listing.home);
    const from = at >= 0 ? listing.crumbs.slice(at).map((c, i) => (i === 0 ? { ...c, name: '~' } : c)) : listing.crumbs;
    if (from.length <= MAX_CRUMBS + 1) return from;
    return [from[0], { ...from[from.length - MAX_CRUMBS - 1], name: '…' }, ...from.slice(-MAX_CRUMBS)];
  })();
  const entries = listing?.entries.filter((e) => !e.hidden) ?? [];

  return (
    <Command ref={listRef} shouldFilter={false} className="bg-transparent" data-agent-cwd-browser>
      <div className="flex items-center gap-1 border-b border-border/60 p-1">
        <Button variant="ghost" size="icon-sm" onClick={onBack} title={t('agent.cwdBack')} aria-label={t('agent.cwdBack')}>
          <ChevronLeft strokeWidth={1.75} />
        </Button>
        <div className="flex min-w-0 flex-1 items-center overflow-hidden text-xs text-muted-foreground" title={listing?.path}>
          {crumbs.map((c, i) => (
            // only the folder shown gives way; the crumbs above it keep their width
            <span key={c.path + i} className={`flex items-center ${i === crumbs.length - 1 ? 'min-w-0' : 'shrink-0'}`}>
              {i > 0 && <span className="px-0.5 opacity-60">/</span>}
              {i === crumbs.length - 1 ? (
                <span className="truncate font-medium text-foreground">{c.name}</span>
              ) : (
                <Button variant="ghost" size="xs" onClick={() => go(c.path)} className="shrink-0 px-1 font-normal text-muted-foreground">{c.name}</Button>
              )}
            </span>
          ))}
        </div>
      </div>
      <CommandList className="max-h-[50vh]">
        {error && <p className="px-3 py-2 text-2xs text-destructive" data-agent-cwd-error>{error}</p>}
        {loading && !listing && !error && <p className="px-3 py-2 text-2xs text-muted-foreground">{t('agent.cwdBrowseLoading')}</p>}
        {listing && (
          <CommandGroup className={loading ? 'opacity-60' : undefined}>
            {entries.map((e) => (
              <CommandItem key={e.path} value={e.path} onSelect={() => go(e.path)}>
                <Folder strokeWidth={1.75} className="text-muted-foreground" />
                <span className="flex-1 truncate text-xs text-foreground">{e.name}</span>
              </CommandItem>
            ))}
            {entries.length === 0 && <p className="px-2 py-1.5 text-2xs text-muted-foreground">{t('agent.cwdBrowseEmpty')}</p>}
            {listing.truncated && <p className="px-2 py-1.5 text-2xs text-muted-foreground">{t('agent.cwdBrowseTruncated')}</p>}
          </CommandGroup>
        )}
      </CommandList>
      <div className="flex flex-col gap-1 border-t border-border/60 p-1">
        {naming && (
          <InputGroup>
            <InputGroupInput
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') void create(); if (e.key === 'Escape') setNaming(false); }}
              placeholder={t('agent.cwdNewFolderName')}
              className="text-xs!"
            />
            <InputGroupAddon align="inline-end">
              <InputGroupButton onClick={() => void create()} disabled={!name.trim()} className="text-primary">
                {t('agent.cwdCreate')}
              </InputGroupButton>
            </InputGroupAddon>
          </InputGroup>
        )}
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => setNaming((v) => !v)} disabled={!listing} aria-expanded={naming}>
            <FolderPlus strokeWidth={1.75} />
            {t('agent.cwdNewFolder')}
          </Button>
          <Button size="sm" className="ml-auto" disabled={!listing || loading} onClick={() => listing && onUse(listing.path)} title={listing?.path} data-agent-cwd-use>
            {t('agent.cwdBrowseUse')}
          </Button>
        </div>
      </div>
    </Command>
  );
}
