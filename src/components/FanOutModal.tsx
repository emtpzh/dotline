import { useState } from 'react';
import { Eye, Split } from 'lucide-react';
import { useStore } from '../store';
import { effectiveRoles } from '../lib/role-templates';
import { useUiStore } from '../lib/ui-store';
import { useI18n, useT, fmt } from '../i18n';
import { Dialog, DialogContent, DialogTitle } from './ui/dialog';
import { Button } from './ui/button';
import { Textarea } from './ui/textarea';

// Perspectives dialog: N roles, ONE mechanism, two run policies.
//   once   → each role answers the question once, blind to its siblings
//            (the rule-in/rule-out candidate pool)
//   follow → each role becomes a reviewer on a sliding watch edge that
//            auto-reruns whenever the thread grows (the old "attach
//            evaluator" is exactly this with N=1)
// Roles come from the template library (toggle chips) and/or free-form
// lines ("Name: prompt"). Used from the panel and from fan-out
// placeholder nodes instantiated out of paradigms.
export default function FanOutModal({
  parentId,
  initialQuestion,
  initialRoles,
  onClose,
}: {
  parentId: string;
  initialQuestion: string;
  initialRoles?: { name: string; prompt: string }[];
  onClose: () => void;
}) {
  const fanOut = useStore((s) => s.fanOut);
  const t = useT();
  const lang = useI18n((s) => s.lang);
  const [mode, setMode] = useState<'once' | 'follow'>('once');
  const [rounds, setRounds] = useState(1);
  const [question, setQuestion] = useState(initialQuestion);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [customText, setCustomText] = useState(
    (initialRoles ?? []).map((r) => `${r.name}: ${r.prompt}`).join('\n')
  );

  const switchMode = (m: 'once' | 'follow') => {
    setMode(m);
    // Each mode has its natural task: the shared question vs a standing critique
    setQuestion(m === 'follow' ? t('fanout.critiqueInstruction') : initialQuestion);
  };

  const customRoles = customText
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const idx = line.indexOf(':');
      return idx > 0
        ? { name: line.slice(0, idx).trim(), prompt: line.slice(idx + 1).trim() }
        : { name: line.slice(0, 24), prompt: line };
    });

  const roleLib = useUiStore((s) => s.roleLib);
  const library = effectiveRoles(lang, roleLib);
  const templateRoles = library.filter((tpl) => picked.has(tpl.id)).map((tpl) => ({
    name: tpl.name,
    prompt: tpl.prompt,
  }));

  const roles = [...templateRoles, ...customRoles];

  const run = () => {
    if (!question.trim() || roles.length === 0) return;
    void fanOut(parentId, question.trim(), roles, { follow: mode === 'follow', rounds });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(next: boolean) => { if (!next) onClose(); }}>
      <DialogContent size="md" className="p-0 gap-0 flex flex-col">
        <div className="px-6 py-4 pr-12 border-b border-border flex items-start gap-4">
          <div>
            <DialogTitle className="flex items-center gap-2">
              <Split size={16} strokeWidth={1.75} className="text-edge-explore" /> {t('fanout.title')}
            </DialogTitle>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">{t('fanout.subtitle')}</p>
          </div>
        </div>

        <div className="px-6 py-4 space-y-4 overflow-y-auto">
          {/* Run policy: answer once (candidates) vs keep reviewing (watchers) */}
          <div>
            <div className="flex gap-1.5">
              {([
                { m: 'once' as const, icon: <Split size={14} strokeWidth={1.75} />, label: t('fanout.modeOnce') },
                { m: 'follow' as const, icon: <Eye size={14} strokeWidth={1.75} />, label: t('fanout.modeFollow') },
              ]).map(({ m, icon, label }) => (
                <Button variant="ghost"
                  key={m}
                  onClick={() => switchMode(m)}
                  className={`text-xs px-3 py-2 rounded-lg transition-colors flex items-center gap-1.5 ${
                    mode === m
                      ? (m === 'follow' ? 'bg-edge-watch/10 text-edge-watch font-medium ring-1 ring-edge-watch/30' : 'bg-edge-explore/15 text-edge-explore font-medium ring-1 ring-edge-explore/30')
                      : 'bg-muted text-muted-foreground hover:bg-border'
                  }`}
                >
                  {icon} {label}
                </Button>
              ))}
            </div>
            <p className="text-2xs text-muted-foreground mt-1.5 leading-relaxed">
              {mode === 'once' ? t('fanout.modeOnceHint') : t('fanout.modeFollowHint')}
            </p>
            {mode === 'follow' && (
              <div className="mt-2 flex items-center gap-2">
                <span className="text-2xs text-muted-foreground">{t('fanout.rounds')}</span>
                {[1, 2, 3].map((r) => (
                  <Button variant="ghost"
                    key={r}
                    onClick={() => setRounds(r)}
                    size="icon-xs"
                    className={`text-2xs ${
                      rounds === r ? 'bg-edge-watch/10 text-edge-watch font-medium ring-1 ring-edge-watch/30' : 'bg-muted text-muted-foreground hover:bg-border'
                    }`}
                  >
                    {r}×
                  </Button>
                ))}
                <span className="text-2xs text-muted-foreground">{t('fanout.roundsHint')}</span>
              </div>
            )}
          </div>

          <div>
            <label className="text-2xs text-muted-foreground uppercase tracking-wider font-medium block mb-1.5">{t(mode === 'follow' ? 'fanout.instruction' : 'fanout.question')}</label>
            <Textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              rows={2}
              className="w-full resize-none leading-relaxed"
            />
          </div>

          <div>
            <label className="text-2xs text-muted-foreground uppercase tracking-wider font-medium block mb-1.5">{t('fanout.templates')}</label>
            <div className="flex flex-wrap gap-1.5">
              {library.map((tpl) => (
                <Button variant="ghost"
                  key={tpl.id}
                  onClick={() => setPicked((prev) => {
                    const next = new Set(prev);
                    if (next.has(tpl.id)) next.delete(tpl.id);
                    else next.add(tpl.id);
                    return next;
                  })}
                  className={`text-2xs px-2.5 py-1.5 rounded-full transition-colors ${
                    picked.has(tpl.id) ? 'bg-edge-explore/15 text-edge-explore font-medium' : 'bg-muted hover:bg-border text-muted-foreground'
                  }`}
                >
                  {tpl.name}
                </Button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-2xs text-muted-foreground uppercase tracking-wider font-medium block mb-1.5">{t('fanout.custom')}</label>
            <Textarea
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              rows={4}
              placeholder={t('fanout.customPlaceholder')}
              className="w-full resize-y leading-relaxed font-mono"
            />
          </div>
        </div>

        <div className="px-6 py-4 border-t border-border flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} className="text-xs text-muted-foreground hover:text-foreground hover:bg-accent">
            {t('common.cancel')}
          </Button>
          <Button variant="ghost"
            onClick={run}
            disabled={!question.trim() || roles.length === 0}
            className={`text-xs text-white px-5 py-2 rounded-lg transition-colors disabled:opacity-30 ${
              mode === 'follow' ? 'bg-edge-watch/90 hover:bg-edge-watch' : 'bg-edge-explore hover:bg-edge-explore/90'
            }`}
          >
            {fmt(t(mode === 'follow' ? 'fanout.confirmFollow' : 'fanout.confirm'), { n: roles.length })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
