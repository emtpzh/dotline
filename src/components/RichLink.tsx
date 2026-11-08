import { Children, useEffect, useState } from 'react';
import { Check, Copy, File as FileIcon, Folder, Globe } from 'lucide-react';
import { useT, fmt } from '../i18n';
import { iconFailed, loadLinkPreview, siteOf, useSiteIcon, type LinkPreview } from '../lib/link-preview';
import { basenameOf, openLocalPath } from '../lib/local-path';
import type { Reference } from '../types';
import { Button } from './ui/button';
import { HoverCard, HoverCardContent, HoverCardTrigger } from './ui/hover-card';
import { Skeleton } from './ui/skeleton';

// Links where an answer is read at length (Markdown's 'panel' surface): a
// web link carries its site's icon and, on hover, a card with the page's
// site, title and description; a file on this machine carries a file glyph
// and a card that opens it or copies its path; an inline citation [n] is a
// small pill whose card is its source. No title attribute on any of them:
// the app's tooltip layer would show it over the card.

/** What the answer already knows about a page (a cited source's record). */
export interface KnownPage { title?: string; site?: string; date?: string }

const OPEN_DELAY = 350;
const CLOSE_DELAY = 150;
const stop = (e: React.MouseEvent) => e.stopPropagation();

/** A site's icon at the text's size, or a globe where it has none. A site
 *  draws its icon for a light page: on the dark theme it sits on a light
 *  chip (tdag-site-icon), so a dark logo stays visible. */
export function SiteIcon({ url, className = 'tdag-link-icon' }: { url: string; className?: string }) {
  const src = useSiteIcon(url);
  if (!src) return <Globe aria-hidden strokeWidth={1.75} className={className} />;
  return (
    <img src={src} alt="" aria-hidden draggable={false} loading="lazy" decoding="async" referrerPolicy="no-referrer"
      className={`tdag-site-icon ${className}`} onError={() => iconFailed(src)} />
  );
}

// The icon rides with the link's first letters, so a line never breaks
// between them (the icon would end one line, the words start the next).
// Only the first few letters: a long word still wraps where it would have.
// No joiner character: it would ride along into a selection, and from there
// into a highlight that the rendered text no longer matches.
function withIcon(icon: React.ReactNode, children: React.ReactNode): React.ReactNode {
  const parts = Children.toArray(children);
  const first = parts[0];
  if (typeof first !== 'string') return <>{icon}{children}</>;
  const head = /^\S{1,8}/.exec(first)?.[0] ?? '';
  return (
    <>
      <span className="whitespace-nowrap">{icon}{head}</span>
      {first.slice(head.length)}
      {parts.slice(1)}
    </>
  );
}

function useCopied(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  return [copied, (text) => {
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }];
}

/** The card of a web page: read when it opens, once per address. */
export function WebLinkCard({ url, known }: { url: string; known?: KnownPage }) {
  const t = useT();
  // undefined while it is being read; null when it cannot be
  const [preview, setPreview] = useState<LinkPreview | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void loadLinkPreview(url).then((p) => { if (live) setPreview(p); });
    return () => { live = false; };
  }, [url]);
  const [copied, copy] = useCopied();
  const site = known?.site || preview?.site || siteOf(url);
  const title = known?.title || preview?.title;
  const reading = preview === undefined;
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-link-card aria-busy={reading || undefined}>
      <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
        <SiteIcon url={url} className="size-4 shrink-0 rounded-sm" />
        <span className="min-w-0 flex-1 truncate">{site}</span>
        {known?.date && <span className="shrink-0 tabular-nums">{known.date}</span>}
        <Button variant="ghost" size="icon-xs" className="-my-1 -mr-1 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={t('link.copy')} onClick={() => copy(url)} data-link-copy>
          {copied ? <Check strokeWidth={2} className="text-success" /> : <Copy strokeWidth={1.75} />}
        </Button>
      </div>
      {title ? (
        <a href={url} target="_blank" rel="noreferrer noopener" onClick={stop}
          className="line-clamp-2 text-sm font-medium leading-snug text-foreground hover:underline" data-link-title>
          {title}
        </a>
      ) : reading && <Skeleton className="h-4 w-4/5" />}
      {preview?.description
        ? <p className="line-clamp-3 text-xs leading-relaxed text-muted-foreground" data-link-description>{preview.description}</p>
        : reading && <Skeleton className="h-3 w-full" />}
      <a href={url} target="_blank" rel="noreferrer noopener" onClick={stop}
        className="truncate text-2xs text-muted-foreground hover:text-foreground">
        {url.replace(/^https?:\/\//, '')}
      </a>
    </div>
  );
}

/** A web link in the text: the site's icon, then the words; a card on hover. */
export function WebLink({ href, known, className, children }: { href: string; known?: KnownPage; className?: string; children: React.ReactNode }) {
  return (
    <HoverCard>
      <HoverCardTrigger href={href} target="_blank" rel="noreferrer noopener" delay={OPEN_DELAY} closeDelay={CLOSE_DELAY}
        onClick={stop} className={className} data-web-link>
        {withIcon(<SiteIcon url={href} />, children)}
      </HoverCardTrigger>
      <HoverCardContent side="top" align="start" className="w-72 p-3">
        <WebLinkCard url={href} known={known} />
      </HoverCardContent>
    </HoverCard>
  );
}

/** A file or folder on this machine that the answer names (`href` as written,
 *  `path` resolved: lib/local-path). A click opens it here, never as a web address. */
export function LocalLink({ href, path, children }: { href?: string; path: string; children: React.ReactNode }) {
  const t = useT();
  const [copied, copy] = useCopied();
  const folder = path.endsWith('/');
  const name = basenameOf(path);
  const dir = path.slice(0, path.replace(/\/+$/, '').length - name.length).replace(/\/+$/, '');
  const Glyph = folder ? Folder : FileIcon;
  return (
    <HoverCard>
      <HoverCardTrigger href={href} delay={OPEN_DELAY} closeDelay={CLOSE_DELAY}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); void openLocalPath(path); }}
        data-local-path={path}>
        {withIcon(<Glyph aria-hidden strokeWidth={1.75} className="tdag-link-icon" />, children)}
      </HoverCardTrigger>
      <HoverCardContent side="top" align="start" className="w-72 p-3">
        <div className="flex min-w-0 flex-col gap-1.5" data-local-card>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Glyph aria-hidden strokeWidth={1.75} className="size-4 shrink-0" />
            {t(folder ? 'link.localFolder' : 'link.localFile')}
          </div>
          <div className="text-sm font-medium leading-snug text-foreground wrap-anywhere">{name}</div>
          {dir && <div className="font-mono text-2xs leading-relaxed text-muted-foreground wrap-anywhere">{dir}</div>}
          <div className="mt-0.5 flex items-center gap-1">
            <Button variant="outline" size="xs" onClick={(e) => { stop(e); void openLocalPath(path); }}>{t('link.openLocal')}</Button>
            <Button variant="ghost" size="xs" className="text-muted-foreground hover:text-foreground" onClick={(e) => { stop(e); copy(path); }}>
              {copied ? <Check strokeWidth={2} className="text-success" /> : <Copy strokeWidth={1.75} />}
              {copied ? t('link.copied') : t('link.copyPath')}
            </Button>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

/** An inline citation [n]: a numbered pill that opens its source; its card is the source's. */
export function CitationPill({ n, source }: { n: number; source: Reference }) {
  const t = useT();
  const label = fmt(t('link.source'), { n });
  const known: KnownPage = { title: source.title, site: source.media, date: source.date };
  if (!source.url) return <span className="tdag-cite" aria-label={`${label} · ${source.title}`} data-cite={n}>{n}</span>;
  return (
    <HoverCard>
      <HoverCardTrigger href={source.url} target="_blank" rel="noreferrer noopener" delay={250} closeDelay={CLOSE_DELAY}
        onClick={stop} className="tdag-cite" aria-label={label} data-cite={n}>
        {n}
      </HoverCardTrigger>
      <HoverCardContent side="top" align="start" className="w-72 p-3">
        <WebLinkCard url={source.url} known={known} />
      </HoverCardContent>
    </HoverCard>
  );
}
