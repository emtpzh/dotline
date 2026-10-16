// The panel's one quiet row: a folded line in the transcript (tool calls,
// reasoning, decisions, attachments, highlights, context) — grey text and a
// chevron, no box. Lives on a <summary> so the line opens in place.
export const LINE_CLASS =
  'inline-flex max-w-full cursor-pointer select-none list-none items-center gap-1 text-[13px] text-muted-foreground/70 transition-colors hover:text-muted-foreground [&::-webkit-details-marker]:hidden';

// What the line opens onto: indented under a hairline, like a quoted aside.
export const LINE_BODY_CLASS = 'mt-2 ml-1.5 border-l border-border pl-3';

// The row under an answer (and the ask box's own icons): quiet icons that
// darken on hover. The icon carries its own size class, so the button's
// default svg size steps aside.
export const ACTION = 'rounded-md text-muted-foreground hover:bg-muted hover:text-foreground';
export const ACTION_ICON = 'size-[13px]';
