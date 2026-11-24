'use client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { safeCitationUrl } from './workspace-ui';
export function SafeMarkdown({ children }: { children: string }) {
  return (
    <div className="prose prose-sm max-w-none break-words dark:prose-invert [&_pre]:max-w-full [&_pre]:overflow-auto [&_table]:block [&_table]:overflow-auto">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ href, children }) => {
            const safe = href ? safeCitationUrl(href) : null;
            return safe ? (
              <a href={safe} target="_blank" rel="noreferrer" className="text-primary underline">
                {children}
              </a>
            ) : (
              <span>{children}</span>
            );
          },
          img: ({ alt }) => <span>{alt ? `[Image: ${alt}]` : '[Image omitted]'}</span>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
