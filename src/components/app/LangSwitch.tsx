import { useI18n } from '../../i18n';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group';

// Compact EN/中 toggle used on the canvas toolbar and the landing page.
export default function LangSwitch() {
  const lang = useI18n((s) => s.lang);
  const setLang = useI18n((s) => s.setLang);

  return (
    // spacing 0 = one segmented shape: the group draws the outer radius and
    // collapses the seam, so neither half needs a class of its own.
    <ToggleGroup
      variant="chrome"
      spacing={0}
      value={[lang]}
      // a segmented control has no empty state — clicking the pressed half
      // would clear the group otherwise
      onValueChange={(v) => { const next = v[0]; if (next === 'en' || next === 'zh') setLang(next); }}
    >
      {(['en', 'zh'] as const).map((l) => (
        // one square each: 'EN' and '中' do not measure the same, and half
        // a segmented control is a shape before it is a label. The padding
        // override is spelled with the group's own variant so it replaces
        // the spacing-0 default instead of losing to it on specificity.
        <ToggleGroupItem key={l} value={l} className="min-w-8 text-2xs group-data-[spacing=0]/toggle-group:px-0">
          {l === 'en' ? 'EN' : '中'}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
