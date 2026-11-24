"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { stripEmailOpenTracking } from '../../../../shared/emailFormatting';
import DOMPurify from "dompurify";
import { Button } from "@/components/ui/button";
import { emailDisplayText } from '@/lib/emailUtils';

const MAX_PREVIEW_HEIGHT = 520;

function FormattedEmailPreview({ html }: { html: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(160);
  const documentHtml = useMemo(() => {
    // Viewing a conversation inside AskSales must never record a recipient open.
    const safeHtml = DOMPurify.sanitize(stripEmailOpenTracking(html));
    return `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>
      html { color-scheme: light; background: #fff; }
      body { box-sizing: border-box; margin: 0; max-width: 100%; overflow-wrap: anywhere; }
      img, video { max-width: 100%; height: auto; }
      table { max-width: 100%; }
    </style></head><body>${safeHtml}</body></html>`;
  }, [html]);

  useEffect(() => {
    const iframe = frame.current;
    if (!iframe) return;
    let observer: ResizeObserver | undefined;
    const watchContent = () => {
      observer?.disconnect();
      const doc = iframe.contentDocument;
      if (!doc?.body) return;
      const updateHeight = () => {
        const contentHeight = Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight);
        setHeight(Math.min(MAX_PREVIEW_HEIGHT, Math.max(120, contentHeight)));
      };
      if (typeof ResizeObserver !== "undefined") {
        observer = new ResizeObserver(updateHeight);
        observer.observe(doc.body);
      }
      updateHeight();
    };
    iframe.addEventListener("load", watchContent);
    if (iframe.contentDocument?.readyState === "complete") watchContent();
    return () => {
      iframe.removeEventListener("load", watchContent);
      observer?.disconnect();
    };
  }, [documentHtml]);

  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-border/70 bg-white shadow-sm">
      <iframe
        ref={frame}
        title="Formatted email content"
        srcDoc={documentHtml}
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        className="block w-full border-0 bg-white"
        style={{ height }}
      />
    </div>
  );
}

export function EmailMessageContent({
  content,
  htmlContent,
}: {
  content: string;
  htmlContent?: string | null;
}) {
  const text = useMemo(() => {
    // Old HTML-to-text ingestion included the original style block in content.
    // Require that exact block and a CSS declaration, rather than guessing from words.
    const originalCss = htmlContent?.match(/<style\b[^>]*>([\s\S]*?)<\/style>/i)?.[1].trim();
    const hasLegacyCss = Boolean(originalCss && /^[^{}]+\{\s*[-\w]+\s*:[^{}]+\}/.test(originalCss) && content.trimStart().startsWith(originalCss));
    const useHtml = Boolean(htmlContent && (!content || content === htmlContent || hasLegacyCss));
    return emailDisplayText(useHtml ? htmlContent! : content, useHtml ? 'html' : 'text');
  }, [content, htmlContent]);
  const hasPlainText = Boolean(text);
  const [showFormatted, setShowFormatted] = useState(false);
  const showPreview = Boolean(htmlContent) && (showFormatted || !hasPlainText);

  return (
    <div className="min-w-0">
      {showPreview && htmlContent ? (
        <FormattedEmailPreview html={htmlContent} />
      ) : (
        <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground">
          {text}
        </p>
      )}
      {htmlContent && hasPlainText ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-2 h-8 px-2 text-xs text-muted-foreground hover:text-foreground"
          aria-expanded={showFormatted}
          onClick={() => setShowFormatted((current) => !current)}
        >
          {showFormatted ? "Show text" : "View formatted email"}
        </Button>
      ) : null}
    </div>
  );
}
