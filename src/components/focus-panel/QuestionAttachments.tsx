import { Loader2, X } from 'lucide-react';
import { useStore } from '../../store';
import { useUiStore } from '../../lib/ui-store';
import { useT, fmt } from '../../i18n';
import { isViewerMode } from '../../lib/viewer';
import type { Attachment } from '../../types';
import { Button } from '../ui/button';

// The files a question was asked with, as cards above its bubble: an image
// shows itself, a document its kind and name. A PDF opens in the reader,
// and a long one says how it is read (text only, or with page images) — a
// click switches it. Hover takes a file off the question.

const extOf = (att: Attachment) => {
  if (att.type === 'application/pdf') return 'PDF';
  const ext = att.name.split('.').pop();
  return ext && ext !== att.name ? ext.slice(0, 4).toUpperCase() : 'FILE';
};

export default function QuestionAttachments({ nodeId, attachments }: { nodeId: string; attachments: Attachment[] }) {
  const t = useT();
  const removeAttachment = useStore((s) => s.removeAttachment);
  const setAttachmentRenderMode = useStore((s) => s.setAttachmentRenderMode);
  if (attachments.length === 0) return null;

  const remove = (att: Attachment) => !isViewerMode && (
    <Button variant="ghost" size="icon-xs" onClick={(e) => { e.stopPropagation(); removeAttachment(nodeId, att.id); }}
      title={t('transcript.removeFile')} aria-label={t('transcript.removeFile')}
      className="absolute -top-1.5 -right-1.5 size-4 rounded-full bg-foreground text-background opacity-0 hover:bg-foreground hover:text-background group-hover/att:opacity-100 focus-visible:opacity-100">
      <X strokeWidth={2.5} className="size-2.5" />
    </Button>
  );

  return (
    <div className="flex max-w-[86%] flex-wrap justify-end gap-1.5" data-question-attachments>
      {attachments.map((att) => {
        if (att.thumbnailUrl) {
          return (
            <div key={att.id} className="group/att relative size-14 shrink-0" title={att.name} data-question-attachment={att.id}>
              <img src={att.thumbnailUrl} alt={att.name} className="size-14 rounded-lg border border-border object-cover" />
              {remove(att)}
            </div>
          );
        }
        const pdf = att.type === 'application/pdf';
        const long = pdf && att.numPages != null && att.numPages > 10 && !att.isExtracting;
        const sub = att.isExtracting ? null
          : pdf && att.numPages != null ? fmt(t('transcript.pdfPages'), { n: att.numPages })
          : `${Math.max(1, Math.round(att.size / 1024))} KB`;
        return (
          <div key={att.id} className="group/att relative min-w-0" data-question-attachment={att.id}>
            <Button variant="outline" disabled={!pdf} title={pdf ? t('attach.openReader') : att.name}
              onClick={() => useUiStore.getState().setReaderNodeId(nodeId)}
              className="h-auto max-w-56 justify-start gap-2 rounded-lg py-1 pr-2.5 pl-1 font-normal disabled:opacity-100">
              <span className="grid size-7.5 shrink-0 place-items-center rounded-md bg-muted text-[9.5px] font-semibold text-muted-foreground">{extOf(att)}</span>
              <span className="flex min-w-0 flex-col items-start leading-tight">
                <span className="max-w-full truncate text-xs text-foreground">{att.name}</span>
                <span className="text-2xs text-muted-foreground">
                  {att.isExtracting ? <Loader2 size={11} className="animate-spin text-primary" /> : sub}
                </span>
              </span>
            </Button>
            {long && !isViewerMode && (
              <Button variant="link" size="xs" title={t('transcript.renderToggle')}
                onClick={() => setAttachmentRenderMode(nodeId, att.id, att.renderMode === 'full' ? 'text-only' : 'full')}
                className="h-auto px-1 text-2xs font-normal text-muted-foreground"
                data-question-attachment-render>
                {att.renderMode === 'full' ? t('transcript.renderFull') : t('transcript.renderText')}
              </Button>
            )}
            {remove(att)}
          </div>
        );
      })}
    </div>
  );
}
