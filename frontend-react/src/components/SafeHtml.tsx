// <div> cujo conteúdo é HTML rico (detalhes de comando, notas), sempre
// passado por sanitizeRichHtml() antes de virar DOM — ver lib/safeHtml.ts.
import { useMemo } from 'react';
import { sanitizeRichHtml } from '../lib/safeHtml';

export function SafeHtml({ html, className }: { html: string | null | undefined; className?: string }) {
  const clean = useMemo(() => sanitizeRichHtml(html), [html]);
  return <div className={className} dangerouslySetInnerHTML={{ __html: clean }} />;
}
