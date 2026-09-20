import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useT } from '../../i18n';
import { Button } from '../ui/button';

// The thinking behind an answer, folded by default: the card's face is the
// answer, reasoning is backstage. Rendered only when the model emitted it
// (data-driven adaptation, no capability registry) and NEVER sent anywhere:
// not into context, fingerprints, summaries or exports beyond raw JSON.
export default function ReasoningDisclosure({ text }: { text: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-2 nopan">
      <Button variant="ghost" size="xs"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        className="text-2xs text-muted-foreground hover:text-muted-foreground"
        data-reasoning-toggle
      >
        {open ? <ChevronDown strokeWidth={1.75} /> : <ChevronRight strokeWidth={1.75} />}
        <span>💭 {t('node.reasoning')}</span>
      </Button>
      {open && (
        <div className="mt-1.5 px-3 py-2 bg-muted/70 rounded-xl text-xs text-muted-foreground italic leading-relaxed whitespace-pre-wrap break-words max-h-[240px] overflow-y-auto nowheel nodrag cursor-text" data-reasoning-body>
          {text}
        </div>
      )}
    </div>
  );
}
