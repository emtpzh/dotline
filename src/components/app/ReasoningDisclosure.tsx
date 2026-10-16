import { ChevronRight } from 'lucide-react';
import { useT } from '../../i18n';
import { LINE_BODY_CLASS, LINE_CLASS } from '../focus-panel/line';

// The thinking behind an answer, folded by default: the card's face is the
// answer, reasoning is backstage. Rendered only when the model emitted it
// (data-driven adaptation, no capability registry) and NEVER sent anywhere:
// not into context, fingerprints, summaries or exports beyond raw JSON.
export default function ReasoningDisclosure({ text }: { text: string }) {
  const t = useT();
  return (
    <details className="group/reasoning nopan">
      <summary className={LINE_CLASS} onClick={(e) => e.stopPropagation()} data-reasoning-toggle>
        <span>{t('node.reasoning')}</span>
        <ChevronRight size={14} strokeWidth={1.75} className="shrink-0 transition-transform group-open/reasoning:rotate-90" />
      </summary>
      <div className={`${LINE_BODY_CLASS} text-xs text-muted-foreground italic leading-relaxed whitespace-pre-wrap break-words max-h-[240px] overflow-y-auto nowheel nodrag cursor-text`} data-reasoning-body>
        {text}
      </div>
    </details>
  );
}
