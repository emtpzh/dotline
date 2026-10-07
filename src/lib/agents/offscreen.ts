// Telling the person about an agent turn they cannot see: it finished, or
// the agent is waiting for an answer — but only when the node is off
// screen (or the page is in the background). A card in view already says
// all of this itself. One toast per event, with a way to the node.

import type { ThoughtData } from '../../types';
import { toast, useUiStore } from '../ui-store';
import { useStore } from '../../store';
import { shortName } from '../node-face';
import { t, fmt } from '../../i18n';

/** Is the node's card on screen in a page the person is looking at? */
export function nodeInView(nodeId: string): boolean {
  if (typeof document === 'undefined' || document.hidden) return false;
  const el = document.querySelector(`.react-flow__node[data-id="${CSS.escape(nodeId)}"]`);
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
}

const locate = (nodeId: string) => ({
  label: t('offscreen.locate'),
  run: () => {
    useStore.getState().setSelectedNodeId(nodeId);
    useUiStore.getState().setArrivalFocusNodeId(nodeId);
  },
});

/** Waiting questions' toasts, by node: they stay until answered. */
const asking = new Map<string, string>();

/** An agent turn ended on a node: say so when the person cannot see it. */
export function noticeTurnEnded(nodeId: string): void {
  const data = useStore.getState().nodes.find((n) => n.id === nodeId)?.data;
  if (!data || nodeInView(nodeId)) return;
  toast('success', fmt(t('offscreen.done'), { x: shortName(data as ThoughtData) }), 6000, locate(nodeId));
}

/** The agent asks the person something: a toast that stays until it is answered. */
export function noticeQuestion(nodeId: string): void {
  if (asking.has(nodeId)) return;
  const data = useStore.getState().nodes.find((n) => n.id === nodeId)?.data;
  if (!data || nodeInView(nodeId)) return;
  asking.set(nodeId, toast('info', fmt(t('offscreen.asks'), { x: shortName(data as ThoughtData) }), 0, locate(nodeId)));
}

/** Nothing left to answer on the node: its waiting toast goes. */
export function clearQuestionNotice(nodeId: string): void {
  const id = asking.get(nodeId);
  if (!id) return;
  asking.delete(nodeId);
  useUiStore.getState().dismissToast(id);
}
