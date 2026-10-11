import { ChevronRight } from 'lucide-react';

// One foldable row of the panel's lower card (attachments, highlights,
// context): the same chevron, the same quiet title, the count on the right.
// Colour belongs to what the section holds (a highlight's bar), never to
// its title. A native <details> so a card's quiet line can open it by
// pointing at it (FocusPanel's panelSection effect opens `details` inside
// `[data-panel-section]`).
export default function PanelSection({
  section,
  title,
  meta,
  children,
}: {
  section?: string;
  title: string;
  meta?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div data-panel-section={section}>
      <details className="group/section">
        <summary className="flex items-center gap-1.5 px-4 py-2.5 text-2xs font-semibold text-muted-foreground cursor-pointer select-none list-none hover:text-foreground transition-colors [&::-webkit-details-marker]:hidden">
          <ChevronRight size={12} strokeWidth={1.75} className="shrink-0 transition-transform group-open/section:rotate-90" />
          <span>{title}</span>
          {meta != null && <span className="ml-auto font-normal tabular-nums">{meta}</span>}
        </summary>
        <div className="px-4 pb-3">{children}</div>
      </details>
    </div>
  );
}
