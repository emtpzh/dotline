import { fmt, type MessageKey } from '../i18n';
import { shortName } from './node-face';
import type { SessionLink } from './agents/continuity';
import type { ThoughtNode } from '../types';

type Translate = (key: MessageKey) => string;
type Broken = Extract<SessionLink, { kind: 'new' }>;

/** The name a role goes by where the canvas mentions it. */
export function roleLabel(data: ThoughtNode['data']): string {
  const prompt = (data.rolePrompt ?? '').replace(/\s+/g, ' ').trim();
  return prompt.length > 14 ? `${prompt.slice(0, 14)}…` : prompt;
}

/** Why a turn left the agent session above it, as one short phrase. */
export function sessionWhy(link: Broken, nodes: ThoughtNode[], t: Translate): string {
  const about = link.about ? nodes.find((n) => n.id === link.about) : undefined;
  switch (link.reason) {
    case 'runtime':
      return link.detail ? fmt(t('session.why.runtimeTo'), { x: link.detail }) : t('session.why.runtimePlain');
    case 'role': {
      const name = about ? roleLabel(about.data) : '';
      return name ? fmt(t('session.why.roleNamed'), { x: name }) : t('session.why.role');
    }
    case 'material':
    case 'reference':
    case 'edited': {
      const name = about ? shortName(about.data) : '';
      return name ? fmt(t(`session.why.${link.reason}Named`), { x: name }) : t(`session.why.${link.reason}`);
    }
    default:
      return t(`session.why.${link.reason}`);
  }
}
