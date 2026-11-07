import { ChevronsDownUp, Milestone, UnfoldVertical } from 'lucide-react';
import { useStore } from '../store';
import { chainPillKey, parseChainFolds } from '../lib/pleats';
import { useT, fmt } from '../i18n';
import { Button } from './ui/button';
import { ButtonGroup } from './ui/button-group';

// Under the head of a long chain, on the wire to the next card: the one-
// click way to fold it (lib/pleats). Gather keeps the landmarks and the last
// turns; keep-ends folds everything between the head and the tail; once
// folded, it unfolds the chain again. Working distance only, like every
// control on a card.

const stop = (e: React.MouseEvent) => e.stopPropagation();

export default function ChainPill({ nodeId }: { nodeId: string }) {
  const t = useT();
  const key = useStore((s) => chainPillKey(s.nodes, s.edges, nodeId));
  const foldChain = useStore((s) => s.foldChain);
  const f = parseChainFolds(key);
  if (!f) return null;
  const { folded, gather, middle } = f;
  if (!folded && !gather && !middle) return null;
  return (
    <div className="absolute top-[calc(100%+18px)] left-1/2 -translate-x-1/2 nodrag nopan"
      onClick={stop} onDoubleClick={stop} data-chain-pill>
      {folded > 0 ? (
        <Button variant="outline" size="xs" title={t('chain.unfoldAllTitle')}
          className="bg-card font-normal text-muted-foreground shadow-sm hover:text-foreground"
          onClick={() => foldChain(nodeId, 'open')} data-chain-unfold>
          <UnfoldVertical strokeWidth={1.75} />{fmt(t('chain.unfoldAll'), { n: folded })}
        </Button>
      ) : (
        <ButtonGroup className="shadow-sm">
          {gather > 0 && (
            <Button variant="outline" size="xs" title={t('chain.gatherTitle')}
              className="bg-card font-normal text-muted-foreground hover:text-foreground"
              onClick={() => foldChain(nodeId, 'gather')} data-chain-gather>
              <Milestone strokeWidth={1.75} />{fmt(t('chain.gather'), { n: gather })}
            </Button>
          )}
          {middle > 0 && (
            <Button variant="outline" size="xs" title={fmt(t('chain.keepEndsTitle'), { n: middle })}
              className="bg-card font-normal text-muted-foreground hover:text-foreground"
              onClick={() => foldChain(nodeId, 'middle')} data-chain-keep-ends>
              <ChevronsDownUp strokeWidth={1.75} />{t('chain.keepEnds')}
            </Button>
          )}
        </ButtonGroup>
      )}
    </div>
  );
}
