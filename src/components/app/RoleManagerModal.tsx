import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { effectiveRoles, type EffectiveRole } from '../../lib/role-templates';
import { useUiStore } from '../../lib/ui-store';
import { generateId } from '../../utils';
import { useI18n, useT } from '../../i18n';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { Button } from '../ui/button';

// The role LIBRARY editor: add, edit and remove the reusable options shown
// as chips everywhere. Editing a built-in converts it into a custom copy
// (the bilingual original is hidden, restorable). This never touches roles
// already applied to nodes — those are plain text frozen on the node.

function Row({ role, onCommit, onRemove }: {
  role: EffectiveRole;
  onCommit: (role: EffectiveRole, name: string, prompt: string) => void;
  onRemove: (role: EffectiveRole) => void;
}) {
  const t = useT();
  const [name, setName] = useState(role.name);
  const [prompt, setPrompt] = useState(role.prompt);
  const commit = () => onCommit(role, name.trim(), prompt.trim());
  return (
    <div className="border border-border rounded-xl px-3 py-2.5 space-y-1.5 bg-background">
      <div className="flex items-center gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          placeholder={t('roles.namePlaceholder')}
          className="flex-1 text-sm font-medium text-foreground bg-transparent focus:outline-none placeholder-muted-foreground"
        />
        {role.builtin && <span className="text-2xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded-full shrink-0">{t('roles.builtin')}</span>}
        <Button variant="ghost" size="icon-sm"
          onClick={() => onRemove(role)}
          title={t('common.delete')}
          className="text-muted-foreground hover:text-destructive/90 shrink-0"
        >
          <Trash2 size={13} strokeWidth={1.75} />
        </Button>
      </div>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onBlur={commit}
        placeholder={t('roles.promptPlaceholder')}
        rows={2}
        className="w-full text-xs text-muted-foreground bg-transparent focus:outline-none resize-y leading-relaxed placeholder-muted-foreground"
      />
    </div>
  );
}

export default function RoleManagerModal() {
  const open = useUiStore((s) => s.roleManagerOpen);
  const setOpen = useUiStore((s) => s.setRoleManagerOpen);
  const lib = useUiStore((s) => s.roleLib);
  const setLib = useUiStore((s) => s.setRoleLib);
  const lang = useI18n((s) => s.lang);
  const t = useT();

  const roles = effectiveRoles(lang, lib);

  const commit = (role: EffectiveRole, name: string, prompt: string) => {
    if ((name === role.name && prompt === role.prompt) || (!name && !prompt)) return;
    if (role.builtin) {
      // editing a built-in = hide the bilingual original, keep a custom copy
      setLib({ hidden: [...lib.hidden, role.id], custom: [...lib.custom, { id: generateId(), name: name || role.name, prompt: prompt || role.prompt }] });
    } else {
      setLib({ ...lib, custom: lib.custom.map((c) => (c.id === role.id ? { ...c, name, prompt } : c)) });
    }
  };
  const remove = (role: EffectiveRole) => {
    if (role.builtin) setLib({ ...lib, hidden: [...lib.hidden, role.id] });
    else setLib({ ...lib, custom: lib.custom.filter((c) => c.id !== role.id) });
  };
  const add = () => setLib({ ...lib, custom: [...lib.custom, { id: generateId(), name: '', prompt: '' }] });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent size="md" className="p-0 gap-0 max-h-[80vh] flex flex-col">
        <DialogHeader className="flex-row items-center gap-2 px-5 py-3 pr-12 border-b shrink-0">
          <DialogTitle>{t('roles.managerTitle')}</DialogTitle>
          <DialogDescription className="text-2xs flex-1">{t('roles.hint')}</DialogDescription>
        </DialogHeader>
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-3 space-y-2">
          {roles.map((r) => <Row key={r.id} role={r} onCommit={commit} onRemove={remove} />)}
          {roles.length === 0 && <p className="text-xs text-muted-foreground italic py-2">{t('roles.empty')}</p>}
        </div>
        <div className="flex items-center gap-2 px-5 py-3 border-t border-border shrink-0">
          <Button variant="ghost" size="sm"
            onClick={add}
            className="text-xs text-primary hover:bg-primary/10"
          >
            <Plus size={14} strokeWidth={1.75} /> {t('roles.add')}
          </Button>
          <div className="flex-1" />
          {lib.hidden.length > 0 && (
            <Button variant="ghost" size="xs"
              onClick={() => setLib({ ...lib, hidden: [] })}
              className="text-2xs text-muted-foreground hover:text-muted-foreground underline decoration-dotted"
            >
              {t('roles.restore')}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
