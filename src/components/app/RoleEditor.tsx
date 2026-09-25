import { useT } from '../../i18n';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import RoleTemplateChips from './RoleTemplateChips';

// One way to write a role, wherever a role is written (the landing box, an
// ask box's role button, the panel's role line): a name, the prompt, and
// the library's templates — a template fills both. The name is what the
// canvas shows on the card; the prompt is what the model receives.
export default function RoleEditor({ name, prompt, onName, onPrompt, onSubmit, autoFocus }: {
  name: string;
  prompt: string;
  onName: (name: string) => void;
  onPrompt: (prompt: string) => void;
  /** Enter in the prompt (without Shift) */
  onSubmit?: () => void;
  autoFocus?: boolean;
}) {
  const t = useT();
  return (
    <div className="space-y-1.5">
      <Input
        value={name}
        onChange={(e) => onName(e.target.value)}
        placeholder={t('role.namePlaceholder')}
        className="h-7 text-xs!"
      />
      <Textarea
        value={prompt}
        onChange={(e) => onPrompt(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && onSubmit) { e.preventDefault(); onSubmit(); }
        }}
        placeholder={t('role.placeholder')}
        className="w-full resize-none leading-relaxed"
        rows={2}
        autoFocus={autoFocus}
      />
      <RoleTemplateChips onPick={(p, n) => { onPrompt(p); onName(n); }} />
    </div>
  );
}
