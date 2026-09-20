import { useState, useRef, useCallback } from 'react';
import { ChevronRight, FileText, Loader2, Paperclip, X, BookOpen } from 'lucide-react';
import { useStore } from '../../store';
import { useUiStore } from '../../lib/ui-store';
import { processFile, FILE_INPUT_ACCEPT } from '../../lib/attachments';
import { useT, fmt } from '../../i18n';
import { isViewerMode } from '../../lib/viewer';
import type { Attachment } from '../../types';
import { Button } from '../ui/button';

export default function AttachmentsSection({
  nodeId,
  attachments,
  excludedAttachmentIds,
  includedAttachmentIds,
  addAttachment,
  removeAttachment,
  toggleExcludeAttachment,
  setAttachmentRenderMode,
  getInheritedAttachments,
}: {
  nodeId: string;
  attachments: Attachment[];
  excludedAttachmentIds: string[];
  includedAttachmentIds: string[];
  addAttachment: (nodeId: string, attachment: Attachment) => void;
  removeAttachment: (nodeId: string, attachmentId: string) => void;
  toggleExcludeAttachment: (nodeId: string, attachmentId: string, ancestorExcluded?: boolean) => void;
  setAttachmentRenderMode: (nodeId: string, attachmentId: string, mode: 'full' | 'text-only') => void;
  getInheritedAttachments: (nodeId: string) => { attachment: Attachment; sourceNodeId: string; sourceQuestion: string; excludedByAncestor: boolean }[];
}) {
  const t = useT();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const inherited = getInheritedAttachments(nodeId);
  const excludeSet = new Set(excludedAttachmentIds);

  const handleFile = useCallback((file: File) => {
    void processFile(file, {
      add: (att) => addAttachment(nodeId, att),
      update: (attId, patch) => useStore.getState().setAttachmentData(nodeId, attId, patch),
    });
  }, [nodeId, addAttachment]);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    for (const file of Array.from(e.dataTransfer.files)) {
      handleFile(file);
    }
  }, [handleFile]);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) handleFile(file);
      }
    }
  }, [handleFile]);

  const hasContent = attachments.length > 0 || inherited.length > 0;

  return (
    <div className="panel-card px-4 py-3">
      <details className="group">
        <summary className="text-2xs font-semibold text-edge-explore cursor-pointer hover:text-edge-explore/80 transition-colors flex items-center gap-1.5 select-none">
          <ChevronRight size={12} strokeWidth={1.75} className="transition-transform group-open:rotate-90" />
          {t('attach.title')}
          {hasContent && (
            <span className="text-muted-foreground font-normal ml-1">
              {fmt(t('attach.local'), { n: attachments.length })}{inherited.length > 0 ? ` ${fmt(t('attach.inheritedBadge'), { n: inherited.length })}` : ''}
            </span>
          )}
        </summary>
        <div className="mt-2 space-y-3">
          {/* Upload area */}
          {!isViewerMode && <div
            onDrop={handleDrop}
            onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
            onDragLeave={() => setIsDragging(false)}
            onPaste={handlePaste}
            onClick={() => fileInputRef.current?.click()}
            className={`border-2 border-dashed rounded-xl px-4 py-3 text-center cursor-pointer transition-all ${
              isDragging
                ? 'border-primary bg-primary/5'
                : 'border-border hover:border-primary/40 hover:bg-background'
            }`}
          >
            <p className="text-xs text-muted-foreground">
              {isDragging ? t('attach.dropHere') : <><Paperclip size={14} strokeWidth={1.75} className="inline" /> {t('attach.upload')}</>}
            </p>
            <p className="text-2xs text-muted-foreground/60 mt-0.5">{t('attach.types')}</p>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={FILE_INPUT_ACCEPT}
              className="hidden"
              onChange={(e) => {
                for (const file of Array.from(e.target.files || [])) {
                  handleFile(file);
                }
                e.target.value = '';
              }}
            />
          </div>}

          {/* Local attachments */}
          {attachments.length > 0 && (
            <div className="space-y-1.5">
              <span className="text-2xs text-muted-foreground font-medium">{t('attach.thisNode')}</span>
              {attachments.map((att) => (
                <div key={att.id} className="flex items-center gap-2 bg-muted rounded-lg px-3 py-2 group">
                  {att.thumbnailUrl ? (
                    <img src={att.thumbnailUrl} className="w-8 h-8 rounded object-cover shrink-0" alt={att.name} />
                  ) : (
                    <span className="w-8 h-8 rounded bg-border flex items-center justify-center text-xs text-muted-foreground shrink-0"><FileText size={16} strokeWidth={1.75} /></span>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-foreground truncate">{att.name}</p>
                    <p className="text-2xs text-muted-foreground">
                      {(att.size / 1024).toFixed(1)} KB
                      {att.isExtracting && <span className="ml-1 text-primary"><Loader2 className="animate-spin inline" size={12} strokeWidth={1.75} /> {t('attach.extracting')}</span>}
                      {att.numPages != null && <span className="ml-1 text-muted-foreground">• {fmt(t('attach.pages'), { n: att.numPages })}</span>}
                      {att.renderMode && <span className="ml-1 text-muted-foreground">• {att.renderMode === 'full' ? t('attach.textVision') : t('attach.textOnly')}</span>}
                    </p>
                    {/* Render mode toggle for PDFs with >10 pages */}
                    {att.type === 'application/pdf' && att.numPages != null && att.numPages > 10 && !att.isExtracting && (
                      <div className="mt-1 flex items-center gap-1.5">
                        <span className="text-2xs text-warning">{fmt(t('attach.pagesWarning'), { n: att.numPages, tok: (att.numPages * 1500).toLocaleString() })}</span>
                        <Button variant="ghost"
                          onClick={() => setAttachmentRenderMode(nodeId, att.id, att.renderMode === 'full' ? 'text-only' : 'full')}
                          className={`text-2xs px-2 py-0.5 rounded-lg transition-colors ${
                            att.renderMode === 'full'
                              ? 'bg-primary/10 text-primary'
                              : 'bg-border text-muted-foreground'
                          }`}
                        >
                          {att.renderMode === 'full' ? t('attach.switchTextOnly') : t('attach.enableVision')}
                        </Button>
                      </div>
                    )}
                  </div>
                  {att.type === 'application/pdf' && !att.isExtracting && (
                    <Button variant="ghost"
                      onClick={() => useUiStore.getState().setReaderNodeId(nodeId)}
                      title={t('attach.openReader')}
                      className="text-muted-foreground hover:text-primary shrink-0"
                    >
                      <BookOpen strokeWidth={1.75} />
                    </Button>
                  )}
                  {!isViewerMode && <Button variant="ghost"
                    onClick={() => removeAttachment(nodeId, att.id)}
                    className="text-muted-foreground hover:text-destructive/90 shrink-0 opacity-0 group-hover:opacity-100"
                  >
                    <X strokeWidth={1.75} />
                  </Button>}
                </div>
              ))}
            </div>
          )}

          {/* Inherited attachments */}
          {inherited.length > 0 && (
            <div className="space-y-1.5">
              <span className="text-2xs text-muted-foreground font-medium">{t('attach.inheritedFrom')}</span>
              {inherited.map(({ attachment: att, sourceNodeId, sourceQuestion, excludedByAncestor }) => {
                const isExcludedSelf = excludeSet.has(att.id);
                const includeSet = new Set(includedAttachmentIds);
                const isOverridden = includeSet.has(att.id); // re-included despite ancestor exclusion
                const isEffectivelyExcluded = isExcludedSelf || (excludedByAncestor && !isOverridden);
                return (
                  <div key={att.id} className={`flex items-center gap-2 rounded-lg px-3 py-2 transition-all ${isEffectivelyExcluded ? 'bg-destructive/10 opacity-50' : 'bg-muted'}`}>
                    {att.thumbnailUrl ? (
                      <img src={att.thumbnailUrl} className="w-8 h-8 rounded object-cover shrink-0" alt={att.name} />
                    ) : (
                      <span className="w-8 h-8 rounded bg-border flex items-center justify-center text-xs text-muted-foreground shrink-0"><FileText size={16} strokeWidth={1.75} /></span>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className={`text-xs truncate ${isEffectivelyExcluded ? 'text-muted-foreground line-through' : 'text-foreground'}`}>{att.name}</p>
                      <p className="text-2xs text-muted-foreground truncate">
                        ← {sourceQuestion.slice(0, 40)}{sourceQuestion.length > 40 ? '…' : ''}
                        {excludedByAncestor && !isOverridden && !isExcludedSelf && <span className="ml-1 text-warning">• {t('attach.excludedUpstream')}</span>}
                        {isOverridden && <span className="ml-1 text-success">• {t('attach.reIncluded')}</span>}
                      </p>
                    </div>
                    {att.type === 'application/pdf' && (
                      <Button variant="ghost"
                        onClick={() => useUiStore.getState().setReaderNodeId(sourceNodeId)}
                        title={t('attach.openReader')}
                        className="text-muted-foreground hover:text-primary shrink-0"
                      >
                        <BookOpen strokeWidth={1.75} />
                      </Button>
                    )}
                    <Button variant="ghost"
                      onClick={() => toggleExcludeAttachment(nodeId, att.id, excludedByAncestor)}
                      className={`text-xs px-2 py-1 rounded-lg transition-colors shrink-0 ${
                        isEffectivelyExcluded
                          ? 'bg-destructive/15 text-destructive hover:bg-destructive/30'
                          : isOverridden
                          ? 'bg-success/15 text-success hover:bg-success/30'
                          : 'bg-border text-muted-foreground hover:bg-primary/10 hover:text-primary'
                      }`}
                      title={excludedByAncestor && !isOverridden ? t('attach.titleExcludedUpstream') : isOverridden ? t('attach.titleReIncluded') : isExcludedSelf ? t('attach.titleInclude') : t('attach.titleExclude')}
                    >
                      {excludedByAncestor && !isOverridden && !isExcludedSelf ? t('attach.btnUpstream') : isOverridden ? t('attach.btnReIncluded') : isExcludedSelf ? t('attach.btnExcluded') : t('attach.btnIncluded')}
                    </Button>
                  </div>
                );
              })}
            </div>
          )}

          {!hasContent && (
            <p className="text-2xs text-muted-foreground italic">{t('attach.empty')}</p>
          )}
        </div>
      </details>
    </div>
  );
}
