import { Pencil } from 'lucide-react';
import { effectiveRoles } from '../../lib/role-templates';
import { useUiStore } from '../../lib/ui-store';
import { useI18n, useT } from '../../i18n';
import { Button } from '../ui/button';

// One-tap role presets shown under every role input — pick a chip to fill
// the prompt, then edit freely. The list is the user-editable role library
// (built-ins + custom); the pencil opens the manager.
export default function RoleTemplateChips({ onPick }: { onPick: (prompt: string) => void }) {
  const lang = useI18n((s) => s.lang);
  const lib = useUiStore((s) => s.roleLib);
  const setRoleManagerOpen = useUiStore((s) => s.setRoleManagerOpen);
  const t = useT();
  return (
    <div className="flex flex-wrap gap-1.5 mt-1.5">
      {effectiveRoles(lang, lib).map((tpl) => (
        <Button variant="ghost" size="xs"
          key={tpl.id}
          type="button"
          onClick={() => onPick(tpl.prompt)}
          className="text-2xs bg-muted hover:bg-primary/10 hover:text-primary text-muted-foreground"
          title={tpl.prompt.slice(0, 140) + '…'}
        >
          {tpl.name}
        </Button>
      ))}
      <Button variant="outline" size="xs"
        type="button"
        onClick={() => setRoleManagerOpen(true)}
        title={t('roles.manageTitle')}
        className="border-dashed hover:border-primary/40"
      >
        <Pencil strokeWidth={1.75} /> {t('roles.manage')}
      </Button>
    </div>
  );
}
