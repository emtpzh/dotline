import { useState } from 'react';
import { Paperclip, UserCog } from 'lucide-react';
import { useStore } from '../../store';
import { isImeComposing } from '../../utils';
import { useT } from '../../i18n';
import { isViewerMode } from '../../lib/viewer';
import RoleTemplateChips from '../app/RoleTemplateChips';
import type { ThoughtData } from '../../types';

// The panel's summary kicker: role · tokens · materials, in one quiet line
// at the top. The narrow role model: a rolePrompt on a node is the system
// prompt for it and everything downstream (nearest ancestor wins). It is
// edited where it lives — on the node that set it, or on a root; clicking
// the role text opens the editor. Elsewhere it is a read-only "inherited"
// segment. Machine-step personas don't use this at all; they live in
// prompt text.

export default function RoleLine({
  nodeId,
  data,
  inheritedRole,
}: {
  nodeId: string;
  data: ThoughtData;
  inheritedRole: string;
}) {
  const setRolePrompt = useStore((s) => s.setRolePrompt);
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(data.rolePrompt ?? '');

  const own = data.rolePrompt;
  const effective = own || inheritedRole;
  const canEdit = !!own || data.isRoot;
  const attachCount = (data.attachments || []).length;

  const save = () => {
    setRolePrompt(nodeId, value.trim());
    setEditing(false);
  };

  return (
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground min-w-0 h-8">
        <UserCog size={13} strokeWidth={1.75} className="shrink-0" />
        {!editing && (<>
        {effective ? (
          canEdit ? (
            <button
              onClick={() => { if (isViewerMode) return; setValue(own ?? ''); setEditing(true); }}
              className="text-edge-explore hover:underline decoration-dotted underline-offset-2 truncate font-medium max-w-[45%] shrink-0"
              title={`${effective} — ${t('role.edit')}`}
            >
              {effective}
            </button>
          ) : (
            <span className="text-edge-explore/90 truncate max-w-[45%] shrink-0" title={effective}>{effective}</span>
          )
        ) : canEdit && !isViewerMode ? (
          <button
            onClick={() => { setValue(''); setEditing(true); }}
            className="hover:text-edge-explore transition-colors shrink-0"
          >
            + {t('role.set')}
          </button>
        ) : (
          <span className="italic shrink-0">{t('role.noRoleSet')}</span>
        )}
        {!own && effective && (
          <span className="text-2xs bg-border/50 px-1.5 py-px rounded-full shrink-0">{t('role.inherited')}</span>
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
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !isImeComposing(e)) { e.preventDefault(); save(); }
              if (e.key === 'Escape') setEditing(false);
            }}
            placeholder={t('role.placeholder')}
            className="w-full text-xs border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-ring bg-card text-foreground resize-none leading-relaxed"
            rows={2}
            autoFocus
          />
          <RoleTemplateChips onPick={(p) => setValue(p)} />
          <div className="flex justify-end gap-2">
            <button onClick={() => setEditing(false)} className="text-xs text-muted-foreground hover:text-foreground px-2.5 py-1 rounded-lg hover:bg-border/40 transition-colors">{t('common.cancel')}</button>
            <button onClick={save} className="text-xs bg-primary hover:bg-primary/90 text-white px-3 py-1 rounded-lg transition-colors">{t('common.save')}</button>
          </div>
        </div>
      )}
    </div>
  );
}
