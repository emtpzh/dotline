import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { useStore } from '../../store';
import { isFactNode } from '../../lib/facts';
import { isImeComposing } from '../../utils';
import { useT } from '../../i18n';
import { isViewerMode } from '../../lib/viewer';
import { toast } from '../../lib/ui-store';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { PassageQuote } from '../app/composer/Composer';

export default function QuestionSection({
  nodeId,
  question,
  isEditing,
  isHuman,
  branchContext,
}: {
  nodeId: string;
  question: string;
  isEditing: boolean;
  /** Paradigm human turn: edits record the question without generating. */
  isHuman?: boolean;
  branchContext?: string;
}) {
  const editQuestion = useStore((s) => s.editQuestion);
  const submitHumanTurn = useStore((s) => s.submitHumanTurn);
  const setEditing = useStore((s) => s.setEditing);
  const isFact = useStore((s) => isFactNode(s.nodes.find((n) => n.id === nodeId)));
  const t = useT();

  const [editValue, setEditValue] = useState('');

  const handleDoubleClickQuestion = () => {
    setEditValue(question);
    if (isViewerMode) return;
    // Editing mid-generation is ambiguous by design: stop first, then edit.
    if (useStore.getState().nodes.find((n) => n.id === nodeId)?.data.isLoading) {
      toast('info', t('question.lockedWhileGenerating'));
      return;
    }
    setEditing(nodeId, true);
  };

  const handleEditSubmit = () => {
    if (!editValue.trim()) return;
    // Unchanged question: close the editor, never regenerate
    if (editValue.trim() === question) { setEditing(nodeId, false); return; }
    if (isHuman) submitHumanTurn(nodeId, editValue.trim());
    else editQuestion(nodeId, editValue.trim());
  };

  const handleEditKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { setEditing(nodeId, false); return; }
    if (e.key !== 'Enter' || isImeComposing(e)) return;
    // Same contract as the card editor: a revision confirms explicitly
    // (✓ button, ⌘/Ctrl+Enter or Shift+Enter) and plain Enter just breaks
    // the line. (A first question is the ask box's — Composer.)
    if (e.metaKey || e.ctrlKey || e.shiftKey) { e.preventDefault(); handleEditSubmit(); }
  };

  // Same contract as the card editor: click-away keeps a changed draft
  // open and never generates; only an unchanged visit closes.
  const handleEditBlur = () => {
    if (editValue.trim() === question) setEditing(nodeId, false);
  };

  const autoGrowTa = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(480, el.scrollHeight)}px`;
  };

  return (
    <div className="panel-card px-4 py-3">
      <label className="text-2xs font-semibold text-muted-foreground mb-1 block">{t('panel.question')}</label>
      {branchContext && <PassageQuote text={branchContext} className="mb-2" />}
      {isEditing && !isViewerMode ? (
        <>
          <Textarea
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onKeyDown={handleEditKeyDown}
            onBlur={isHuman ? undefined : handleEditBlur}
            onInput={(e) => autoGrowTa(e.currentTarget)}
            ref={autoGrowTa}
            className="w-full border-primary resize-none"
            rows={3}
            autoFocus
          />
          {isFact && !isHuman && <p className="text-2xs text-muted-foreground mt-1.5" data-fact-note>{t('fact.editQuestionNote')}</p>}
          {!isHuman && (
            <div className="flex items-center justify-end gap-2 mt-1.5">
              <Button variant="ghost" size="sm"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setEditing(nodeId, false)}
                className="text-xs text-muted-foreground hover:text-destructive/90 hover:bg-accent"
                data-edit-cancel
              >
                <X strokeWidth={2} /> {t('question.editCancel')}
              </Button>
              <Button size="sm"
                onMouseDown={(e) => e.preventDefault()}
                onClick={handleEditSubmit}
                disabled={!editValue.trim()}
                data-edit-submit>
                <Check strokeWidth={2.25} /> {t('question.editSubmit')}
              </Button>
            </div>
          )}
        </>
      ) : (
        <div
          onDoubleClick={handleDoubleClickQuestion}
          className="text-sm text-foreground font-semibold cursor-pointer hover:bg-accent rounded-xl px-2 py-1.5 -mx-1 transition-colors max-h-[240px] overflow-y-auto"
        >
          {question}
        </div>
      )}
    </div>
  );
}
