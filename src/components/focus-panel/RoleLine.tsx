import { useState } from 'react';
import { Paperclip, UserCog } from 'lucide-react';
import { useStore } from '../../store';
import { useT, fmt } from '../../i18n';
import { isViewerMode } from '../../lib/viewer';
import { roleLabel, shortName } from '../../lib/node-face';
import RoleEditor from '../app/RoleEditor';
import type { ThoughtData, ThoughtNode } from '../../types';
import { Button } from '../ui/button';

// The panel's summary kicker: role · tokens · materials, in one quiet line
// at the top. One role model: a rolePrompt on a node is the system prompt
// for it and everything downstream along solid wires, until the next node
// that sets one. ANY node can set, rename or clear its own; an inherited
// role says where it was set, and that node is one click away.

export default function RoleLine({
  nodeId,
  data,
  inheritedFrom,
  onJump,
}: {
  nodeId: string;
  data: ThoughtData;
  /** the node whose role this one inherits (none when it sets its own) */
  inheritedFrom?: ThoughtNode;
  onJump?: (nodeId: string) => void;
}) {
  const setRolePrompt = useStore((s) => s.setRolePrompt);
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');

  const own = !!data.rolePrompt;
  const attachCount = (data.attachments || []).length;
  const open = () => {
    if (isViewerMode) return;
    setName(data.roleName ?? '');
    setPrompt(data.rolePrompt ?? '');
    setEditing(true);
  };
  const save = () => {
    setRolePrompt(nodeId, prompt.trim(), name);
    setEditing(false);
  };

  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0 h-8">
        <UserCog size={13} strokeWidth={1.75} className="shrink-0" />
        {!editing && (<>
        {own ? (
          <Button variant="ghost" size="xs" onClick={open} data-role-own
            className="px-1 font-medium text-foreground hover:underline decoration-dotted underline-offset-2 truncate max-w-[45%] shrink-0"
            title={`${data.rolePrompt}\n— ${t('role.setHere')}`}
          >
            {roleLabel(data)}
          </Button>
        ) : inheritedFrom ? (
          <>
            <span className="truncate max-w-[30%] shrink-0 text-foreground" title={inheritedFrom.data.rolePrompt}>{roleLabel(inheritedFrom.data)}</span>
            <Button variant="ghost" size="xs" onClick={() => onJump?.(inheritedFrom.id)} data-role-inherited
              className="px-1.5 text-2xs bg-border/50 rounded-full shrink min-w-0 truncate"
            >
              {fmt(t('role.inheritedFrom'), { x: shortName(inheritedFrom.data) })}
            </Button>
            {!isViewerMode && (
              <Button variant="ghost" size="xs" onClick={open} className="px-1 hover:text-foreground shrink-0">+ {t('role.set')}</Button>
            )}
          </>
        ) : !isViewerMode ? (
          <Button variant="ghost" size="xs" onClick={open} className="px-1 hover:text-foreground shrink-0">+ {t('role.set')}</Button>
        ) : (
          <span className="italic shrink-0">{t('role.noRoleSet')}</span>
        )}
        <span className="shrink-0">·</span>
        </>)}
        <span className="shrink-0 text-muted-foreground">{data.tokenCount} tok</span>
        {attachCount > 0 && (
          <>
            <span className="shrink-0">·</span>
            <span className="shrink-0 text-muted-foreground flex items-center gap-0.5">
              <Paperclip size={11} strokeWidth={1.75} /> {attachCount}
            </span>
          </>
        )}
      </div>
      {editing && (
        <div className="pb-2 space-y-1.5">
          <RoleEditor name={name} prompt={prompt} onName={setName} onPrompt={setPrompt} onSubmit={save} autoFocus />
          <div className="flex justify-end gap-2">
            {own && (
              <Button variant="ghost" size="xs" onClick={() => { setRolePrompt(nodeId, ''); setEditing(false); }} className="mr-auto text-xs text-muted-foreground hover:text-destructive">{t('role.remove')}</Button>
            )}
            <Button variant="ghost" size="xs" onClick={() => setEditing(false)} className="text-xs text-muted-foreground hover:text-foreground hover:bg-border/40">{t('common.cancel')}</Button>
            <Button size="xs" onClick={save} disabled={!prompt.trim() && !own}>{t('common.save')}</Button>
          </div>
        </div>
      )}
    </div>
  );
}
