"use client";

import { useEffect, useState } from "react";
import { Database } from "lucide-react";
import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

interface SavedContent {
  extractedText: string;
  chunks: { index: number; text: string }[];
  embeddingsGenerated: boolean;
}

export function KnowledgeBasePreview({ entryId }: { entryId: number }) {
  const [content, setContent] = useState<SavedContent | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setContent(null);
    setError(false);
    api
      .get<SavedContent>(
        `/api/settings/knowledge-base/${entryId}/extracted-text`,
      )
      .then((result) => {
        if (active) setContent(result);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [entryId, attempt]);

  if (error)
    return (
      <div role="alert" className="space-y-3">
        <p>
          Your knowledge base was saved, but its content could not be loaded.
        </p>
        <Button
          variant="outline"
          onClick={() => setAttempt((value) => value + 1)}
        >
          Retry loading content
        </Button>
      </div>
    );
  if (!content)
    return (
      <p role="status" className="flex items-center gap-2 text-sm">
        <Spinner size="sm" label={null} />
        Loading saved content…
      </p>
    );
  const pages = content.chunks?.filter((chunk) => chunk.text.trim()) || [];
  return (
    <section className="space-y-4" aria-label="Saved knowledge base content">
      <div className="flex items-start gap-3">
        <Database size={24} className="shrink-0 text-primary" />
        <div>
          <h3 className="font-semibold">Saved knowledge base content</h3>
          <p className="text-sm text-muted-foreground">
            {pages.length
              ? `${pages.length} pages saved. Expand a page to read its stored content.`
              : "The website text stored for your business."}
          </p>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {content.embeddingsGenerated
          ? "Saved and indexed for knowledge search."
          : "Content is saved. Knowledge search indexing is not ready yet."}
      </p>
      <div className="max-h-[480px] space-y-3 overflow-y-auto pr-1">
        {pages.length ? (
          pages.map((page, index) => {
            const lines = page.text.split("\n");
            const title =
              lines[0]?.replace(/^#+\s*/, "").trim() || `Page ${index + 1}`;
            const source = lines
              .find((line) => line.startsWith("URL: "))
              ?.slice(5)
              .trim();
            const safeSource =
              source && /^https?:\/\//i.test(source) ? source : null;
            return (
              <details
                key={`${page.index}-${index}`}
                open={index === 0}
                className="rounded-lg border bg-background p-3"
              >
                <summary className="cursor-pointer text-sm font-medium">
                  {title}
                </summary>
                {safeSource && (
                  <a
                    href={safeSource}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-2 block break-all text-xs text-primary underline"
                  >
                    {safeSource}
                  </a>
                )}
                <pre className="mt-3 max-h-64 overflow-y-auto whitespace-pre-wrap break-words font-sans text-sm leading-6 text-foreground">
                  {page.text}
                </pre>
              </details>
            );
          })
        ) : (
          <p className="whitespace-pre-wrap break-words text-sm leading-6">
            {content.extractedText ||
              "No readable text was stored for this website."}
          </p>
        )}
      </div>
    </section>
  );
}
