import { ChevronRight } from 'lucide-react';
import { LINE_BODY_CLASS, LINE_CLASS } from './line';

// One foldable line of the transcript's lower part (attachments, highlights,
// context): the same grey line the tool calls fold into, its count after
// the title. Colour belongs to what the section holds (a highlight's bar),
// never to its title. A native <details> so a card's quiet line can open it
// by pointing at it (FocusPanel's panelSection effect opens `details` inside
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
        <summary className={LINE_CLASS}>
          <span className="truncate">{title}{meta != null && <span className="tabular-nums"> · {meta}</span>}</span>
          <ChevronRight size={14} strokeWidth={1.75} className="shrink-0 transition-transform group-open/section:rotate-90" />
        </summary>
        <div className={LINE_BODY_CLASS}>{children}</div>
      </details>
    </div>
  );
}
