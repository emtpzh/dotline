import { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkCjkFriendly from 'remark-cjk-friendly';
import rehypeHighlight from 'rehype-highlight';
import rehypeKatex from 'rehype-katex';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import type { Schema } from 'hast-util-sanitize';
import type { Element, ElementContent } from 'hast';
import type { PluggableList } from 'unified';
import { Check, ChevronDown, Copy, WrapText } from 'lucide-react';
import rehypeMarks, { type MarkSpec } from '../lib/rehype-marks';
import { useT, fmt } from '../i18n';
import { localPathOf, openLocalPath, basenameOf } from '../lib/local-path';
import { Button } from './ui/button';
import { Toggle } from './ui/toggle';

// CommonMark closes `**` only where it is right-flanking, which a full-width
// stop followed by a CJK letter is not: `**结论。**后文` would show its stars.
// remark-cjk-friendly relaxes the flanking rules for CJK text.
const REMARK_PLUGINS = [remarkGfm, remarkCjkFriendly, remarkMath];

// Models freely emit \( \) and \[ \] math delimiters; remark-math only
// parses $-style. Normalize outside code fences/spans so formulas render
// everywhere (cards, panel, rail, reader) instead of leaking raw.
function normalizeMath(src: string): string {
  if (!src || (!src.includes('\\(') && !src.includes('\\['))) return src;
  const parts = src.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return parts
    .map((seg, i) => (i % 2 === 1 ? seg : seg
      .replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => `\n$$\n${m.trim()}\n$$\n`)
      .replace(/\\\((.+?)\\\)/g, (_, m) => `$${m.trim()}$`)))
    .join('');
}
// Raw HTML in an answer is kept for what it is used for (details, sub/sup,
// kbd, mark, tables, line breaks) and stripped of what can run or embed:
// iframe, object, embed, script, style, link, meta, base, form. An answer is
// untrusted text (a shared graph, an imported project, a model quoting a
// page), and a srcdoc iframe runs with this origin's storage and bridges.
// The sanitizer sits after rehype-raw and before highlight and KaTeX, so
// their own markup (hljs spans, KaTeX styles) is never touched; highlights
// and explore traces are marked after it (rehype-marks), so they need no
// allow-list entry and a pasted <mark data-explore-target> cannot pose as one.
const SANITIZE_SCHEMA: Schema = {
  ...defaultSchema,
  // footnote ids already carry mdast's own user-content- prefix; a second one would break their links
  clobberPrefix: '',
  tagNames: [...(defaultSchema.tagNames ?? []), 'mark'],
  attributes: {
    ...defaultSchema.attributes,
    // remark-math marks its code as language-math plus math-inline / math-display; KaTeX reads all three
    code: [['className', /^language-./, 'math-inline', 'math-display']],
  },
};
const REHYPE_PLUGINS: PluggableList = [rehypeRaw, [rehypeSanitize, SANITIZE_SCHEMA], rehypeHighlight, rehypeKatex];

/** Where the text is read. A card on the canvas keeps its code blocks light
 *  (a copy button on hover); the panel, where an answer is read at length,
 *  gives each one a header — its language, a copy that stays, line
 *  wrapping — and folds a long one to its first lines. */
export type MarkdownSurface = 'card' | 'panel';
const SurfaceContext = createContext<MarkdownSurface>('card');

// The text of a hast subtree: what a code block copies, and how long it is.
const textOf = (n: ElementContent): string => (n.type === 'text' ? n.value : 'children' in n ? n.children.map(textOf).join('') : '');

// react-markdown hands each component its hast node; it is not a DOM prop
type PreProps = React.HTMLAttributes<HTMLPreElement> & { node?: Element };

function Pre({ node, ...props }: PreProps) {
  const surface = useContext(SurfaceContext);
  const code = node?.children.find((c): c is Element => c.type === 'element' && c.tagName === 'code');
  return surface === 'panel' && code ? <CodeBlock code={code} {...props} /> : <HoverCopyPre {...props} />;
}

// a block longer than this opens folded to its first lines
const FOLD_LINES = 24;

// No toast on copy: too frequent an action — the icon flashes a check.
function CodeBlock({ code, className, ...props }: React.HTMLAttributes<HTMLPreElement> & { code: Element }) {
  const t = useT();
  const text = useMemo(() => textOf(code).replace(/\n$/, ''), [code]);
  const cls = code.properties.className;
  const lang = (Array.isArray(cls) ? cls.map(String) : []).find((c) => c.startsWith('language-'))?.slice('language-'.length);
  const lines = text.split('\n').length;
  const long = lines > FOLD_LINES;
  const [open, setOpen] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [copied, setCopied] = useState(false);
  const folded = long && !open;
  return (
    <div className="tdag-code my-3 overflow-hidden rounded-lg border border-border bg-muted" data-code-block>
      <div className="flex h-8 items-center gap-0.5 border-b border-border pr-1 pl-3 text-xs text-muted-foreground">
        <span className="min-w-0 truncate font-mono" data-code-lang>{lang}</span>
        <Toggle size="sm" pressed={wrap} onPressedChange={setWrap} title={t('code.wrap')} aria-label={t('code.wrap')}
          className="ml-auto h-6 min-w-6 px-1.5 text-muted-foreground hover:bg-background aria-pressed:bg-background aria-pressed:text-foreground">
          <WrapText strokeWidth={1.75} />
        </Toggle>
        <Button variant="ghost" size="xs" className="text-muted-foreground hover:bg-background hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            void navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          }}
          data-code-copy
        >
          {copied ? <Check strokeWidth={2} className="text-success" /> : <Copy strokeWidth={1.75} />}
          {copied ? t('code.copied') : t('code.copy')}
        </Button>
      </div>
      <pre {...props}
        className={`${className ?? ''} ${wrap ? 'whitespace-pre-wrap wrap-anywhere' : ''} ${folded ? 'max-h-[22em] overflow-y-hidden mask-b-from-60%' : ''}`} />
      {long && (
        <Button variant="ghost" size="xs" aria-expanded={open} onClick={() => setOpen(!open)}
          className="w-full rounded-none border-t border-border text-muted-foreground hover:bg-background hover:text-foreground"
          data-code-fold>
          <ChevronDown strokeWidth={1.75} className={open ? 'rotate-180' : undefined} />
          {open ? t('code.collapse') : fmt(t('code.expand'), { n: lines })}
        </Button>
      )}
    </div>
  );
}

// A card's code block: a copy button on hover.
function HoverCopyPre(props: React.HTMLAttributes<HTMLPreElement>) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const t = useT();
  return (
    <div className="relative group/pre">
      <pre {...props} ref={ref} />
      <Button variant="outline" size="icon-sm"
        onClick={(e) => {
          e.stopPropagation();
          void navigator.clipboard.writeText(ref.current?.innerText ?? '');
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        }}
        title={t('common.copyCode')}
        className="absolute top-1.5 right-1.5 opacity-0 group-hover/pre:opacity-100 nodrag nopan"
      >
        {copied ? <Check strokeWidth={2} className="text-success" /> : <Copy strokeWidth={1.75} />}
      </Button>
    </div>
  );
}

// Wide tables scroll inside their own container instead of blowing the card
function Table(props: React.HTMLAttributes<HTMLTableElement>) {
  return (
    <div className="overflow-x-auto">
      <table {...props} />
    </div>
  );
}

// Links leave the card, never the app. A web URL opens a new tab (the
// desktop shell hands it to the system browser); a LOCAL path — a file
// or folder the agent named — opens on this machine and never becomes a
// web address. Either way the click does not reach the canvas as a node
// selection.
// The writer's working directory, when the text came from a session: a
// relative path in it resolves against this, not against the app.
const BaseContext = createContext<string | undefined>(undefined);

function Anchor(props: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const local = localPathOf(props.href, useContext(BaseContext));
  if (local) {
    return (
      <a
        {...props}
        title={local}
        data-local-path={local}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); void openLocalPath(local); }}
      />
    );
  }
  return <a {...props} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()} />;
}

// An image the agent produced shows inline, read from disk through the
// shell; where there is no disk (the browser) a chip names the file.
function LocalImage({ path, alt }: { path: string; alt?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  // no shell, no disk: the chip is final from the first paint
  const [failed, setFailed] = useState(() => !window.desktopLocal);
  useEffect(() => {
    const bridge = window.desktopLocal;
    if (!bridge) return;
    let live = true;
    void bridge.image(path).then((d) => { if (!live) return; if (d) setSrc(d); else setFailed(true); }).catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [path]);
  if (src) {
    return <img src={src} alt={alt ?? basenameOf(path)} title={path} className="cursor-zoom-in nopan" onClick={(e) => { e.stopPropagation(); void openLocalPath(path); }} />;
  }
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs border border-border rounded-md px-1.5 py-0.5 font-mono nopan cursor-pointer ${failed ? 'text-muted-foreground' : 'text-muted-foreground'}`}
      title={path}
      data-local-image={path}
      onClick={(e) => { e.stopPropagation(); void openLocalPath(path); }}
    >
      🖼 {basenameOf(path)}
    </span>
  );
}

function Img(props: React.ImgHTMLAttributes<HTMLImageElement>) {
  const local = localPathOf(props.src, useContext(BaseContext));
  if (local) return <LocalImage path={local} alt={props.alt} />;
  return <img {...props} />;
}

const COMPONENTS = { pre: Pre, table: Table, a: Anchor, img: Img };

// Standard markdown rendering (GFM + math + syntax highlighting).
// memo: the unified parse + KaTeX layout is the most expensive render on a
// card, and cards re-render far more often than their text changes (every
// streamed chunk anywhere re-renders every card). Same string → skip.
export const Markdown = memo(function Markdown({ children, base, marks, surface = 'card' }: { children: string; base?: string; marks?: MarkSpec[]; surface?: MarkdownSurface }) {
  const rehypePlugins = useMemo(
    (): PluggableList => (marks?.length ? [...REHYPE_PLUGINS, [rehypeMarks, marks] as [typeof rehypeMarks, MarkSpec[]]] : REHYPE_PLUGINS),
    [marks],
  );
  return (
    <SurfaceContext.Provider value={surface}>
      <BaseContext.Provider value={base}>
        <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={rehypePlugins} components={COMPONENTS}>
          {normalizeMath(children)}
        </ReactMarkdown>
      </BaseContext.Provider>
    </SurfaceContext.Provider>
  );
});

/** A passage a child branch explores from: rendered as a warm dotted
    underline (structural trace), never a fill (fills belong to the user's
    own highlights). data-explore-target lets hosts delegate clicks. */
export interface ExploreMarkSpec { text: string; nodeId: string; title: string }

// Markdown with user highlights (and explore traces) marked on the rendered
// tree (see rehype-marks). Callers rebuild the Set/array props every
// render, so memo compares by CONTENT (see areMarkPropsEqual below).
// `base` as for Markdown: a marked answer still resolves its relative paths.
export const HighlightedMarkdown = memo(function HighlightedMarkdown({ content, highlights, exploreMarks, base, surface }: HMProps) {
  const marks: MarkSpec[] = [
    ...[...highlights].map((text) => ({ text, prio: 0, properties: { className: ['user-mark'] } })),
    // the user's own highlight outranks the structural trace
    ...(exploreMarks ?? []).map((em) => ({
      text: em.text,
      prio: 1,
      properties: { className: ['explore-mark'], dataExploreTarget: em.nodeId, title: em.title },
    })),
  ];
  return <Markdown marks={marks} base={base} surface={surface}>{content}</Markdown>;
}, areMarkPropsEqual);

type HMProps = { content: string; highlights: Set<string>; exploreMarks?: ExploreMarkSpec[]; base?: string; surface?: MarkdownSurface };
function areMarkPropsEqual(prev: HMProps, next: HMProps): boolean {
  if (prev.content !== next.content || prev.base !== next.base || prev.surface !== next.surface) return false;
  if (prev.highlights.size !== next.highlights.size) return false;
  for (const h of prev.highlights) if (!next.highlights.has(h)) return false;
  const a = prev.exploreMarks ?? [];
  const b = next.exploreMarks ?? [];
  if (a.length !== b.length) return false;
  return a.every((m, i) => m.text === b[i].text && m.nodeId === b[i].nodeId && m.title === b[i].title);
}
