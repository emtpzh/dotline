import { useStore as useRfStore, useStoreApi, useReactFlow, Panel } from '@xyflow/react';
import { Lock, LockOpen, Maximize, ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from '../ui/button';
import { ButtonGroup } from '../ui/button-group';
import { useT } from '../../i18n';
import { MOTION, fitMotion } from '../../lib/motion';

// React Flow's own <Controls> ships fill-based glyphs on four different
// viewBoxes and hardcoded English labels — it took a block of !important to
// half-fit the board and it never followed the language switch. Same
// behaviour, built from the design system: chrome buttons in a ButtonGroup,
// lucide icons at the canvas's stroke weight, and i18n titles, which
// GlobalTooltip styles like every other control's.
export default function CanvasControls() {
  const t = useT();
  const store = useStoreApi();
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  // the library's own reading of "interactive": any one of the three axes
  const interactive = useRfStore((s) => s.nodesDraggable || s.nodesConnectable || s.elementsSelectable);
  const minZoomReached = useRfStore((s) => s.transform[2] <= s.minZoom);
  const maxZoomReached = useRfStore((s) => s.transform[2] >= s.maxZoom);

  return (
    <Panel position="bottom-left">
      <ButtonGroup orientation="vertical">
        <Button variant="chrome" size="icon" onClick={() => zoomIn(fitMotion(MOTION.base))} disabled={maxZoomReached} title={t('controls.zoomIn')}>
          <ZoomIn strokeWidth={1.75} />
        </Button>
        <Button variant="chrome" size="icon" onClick={() => zoomOut(fitMotion(MOTION.base))} disabled={minZoomReached} title={t('controls.zoomOut')}>
          <ZoomOut strokeWidth={1.75} />
        </Button>
        <Button variant="chrome" size="icon" onClick={() => fitView(fitMotion())} title={t('controls.fitView')}>
          <Maximize strokeWidth={1.75} />
        </Button>
        <Button
          variant="chrome"
          size="icon"
          onClick={() => store.setState({ nodesDraggable: !interactive, nodesConnectable: !interactive, elementsSelectable: !interactive })}
          title={interactive ? t('controls.lock') : t('controls.unlock')}
        >
          {interactive ? <LockOpen strokeWidth={1.75} /> : <Lock strokeWidth={1.75} />}
        </Button>
      </ButtonGroup>
    </Panel>
  );
}
