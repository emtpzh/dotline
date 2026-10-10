import { memo } from 'react';
import katex from 'katex';

// A highlight's words, outside the answer they came from: plain text, with
// the formulas it caught (`$tex$`, see selectionText) typeset instead of
// shown as TeX.
export const HighlightText = memo(function HighlightText({ text }: { text: string }) {
  const parts = text.split(/(\$[^$]+\$)/g);
  return (
    <>
      {parts.map((p, i) => {
        if (i % 2 === 0) return p;
        const html = katex.renderToString(p.slice(1, -1), { throwOnError: false, output: 'html' });
        return <span key={i} dangerouslySetInnerHTML={{ __html: html }} />;
      })}
    </>
  );
});
