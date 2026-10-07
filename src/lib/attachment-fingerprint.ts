import type { Attachment } from '../types';

// Identity of an attachment's content — used to dedup the same file uploaded
// to multiple nodes or reached via multiple DAG paths. Its own module so the
// context builder can use it without the upload pipeline behind lib/attachments.
export function attachmentFingerprint(att: Pick<Attachment, 'name' | 'size' | 'content'>): string {
  return `${att.name}|${att.size}|${att.content?.substring(0, 100)}`;
}
