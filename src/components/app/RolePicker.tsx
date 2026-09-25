import { useState } from 'react';
import { Drama, X } from 'lucide-react';
import { useT, fmt } from '../../i18n';
import { roleLabel } from '../../lib/node-face';
import { Button } from '../ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import RoleEditor from './RoleEditor';

/** The role an ask box will ask its question in. */
export interface AskRole { name: string; prompt: string }

// The one role action, where questions are asked: every ask box carries
// this button, and the role it picks is set on the question about to be
// asked — from there down, until a node sets another (ThoughtData.rolePrompt).
export function RolePickerButton({ value, onChange }: { value: AskRole | null; onChange: (role: AskRole | null) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const use = () => {
    onChange(prompt.trim() ? { name: name.trim(), prompt: prompt.trim() } : null);
    setOpen(false);
  };
  return (
    <Popover open={open} onOpenChange={(next: boolean) => {
      setOpen(next);
      if (next) { setName(value?.name ?? ''); setPrompt(value?.prompt ?? ''); }
    }}>
      <PopoverTrigger
        render={
          <Button variant="ghost" size="icon-sm" title={t('role.pick')} data-ask-role-button
            className={`shrink-0 ${value ? 'text-primary bg-primary/10 hover:bg-primary/20' : 'text-muted-foreground hover:text-primary hover:bg-border'}`} />
        }
      >
        <Drama strokeWidth={1.75} />
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-80 gap-2">
        <RoleEditor name={name} prompt={prompt} onName={setName} onPrompt={setPrompt} onSubmit={use} autoFocus />
        <div className="flex justify-end gap-2">
          {value && (
            <Button variant="ghost" size="xs" onClick={() => { onChange(null); setOpen(false); }}>{t('role.clear')}</Button>
          )}
          <Button size="xs" onClick={use} disabled={!prompt.trim()}>{t('role.use')}</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The picked role, above the question it will be asked in. */
export function AskRoleChip({ role, onClear }: { role: AskRole; onClear: () => void }) {
  const t = useT();
  return (
    <span className="inline-flex max-w-full items-center gap-0.5 rounded-full bg-primary/10 py-px pl-2 pr-0.5 text-2xs font-medium text-primary" title={role.prompt} data-ask-role>
      <span className="truncate">{fmt(t('role.chip'), { x: roleLabel({ roleName: role.name, rolePrompt: role.prompt }) })}</span>
      <Button variant="ghost" size="icon-xs" className="size-4 rounded-full text-primary hover:bg-primary/15" onClick={(e) => { e.stopPropagation(); onClear(); }} title={t('role.clear')}>
        <X strokeWidth={2} />
      </Button>
    </span>
  );
}
