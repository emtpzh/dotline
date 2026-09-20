import { useI18n } from '../../i18n';
import { Button } from '../ui/button';

// Compact EN/中 toggle used on the canvas toolbar and the landing page.
export default function LangSwitch() {
  const lang = useI18n((s) => s.lang);
  const setLang = useI18n((s) => s.setLang);

  return (
    <div className="flex items-center bg-card/90 backdrop-blur border border-border rounded-lg shadow-sm overflow-hidden">
      {(['en', 'zh'] as const).map((l) => (
        <Button variant="ghost"
          key={l}
          onClick={() => setLang(l)}
          // fixed width: the two halves of a segmented control are one
          // shape, and 'EN' and '中' do not measure the same
          size="icon"
          className={`rounded-none text-2xs font-medium ${
            lang === l ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'
          }`}
        >
          {l === 'en' ? 'EN' : '中'}
        </Button>
      ))}
    </div>
  );
}
