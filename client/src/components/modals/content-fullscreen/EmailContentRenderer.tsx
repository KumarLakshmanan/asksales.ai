import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Eye, Code, Download } from "lucide-react";
import type { ContentRendererProps } from "./types";
import { stripHtml } from "./utils";

interface EmailContentRendererProps extends ContentRendererProps {
  generateHtml: () => string;
  downloadHtml: () => void;
}

export default function EmailContentRenderer({
  parsedContent,
  content,
  title,
  generateHtml,
  downloadHtml,
}: EmailContentRendererProps) {
  const [viewMode, setViewMode] = useState<"preview" | "html">("preview");

  const emailSubject = parsedContent.subject || title;
  const emailBody = stripHtml(parsedContent.body || parsedContent.content || content);

  return (
    <div className="space-y-4">
      {/* View Mode Toggle for Email */}
      <div className="flex items-center justify-between">
        <div className="flex gap-1 p-1 bg-muted/50 rounded-lg w-fit">
          <Button
            variant={viewMode === "preview" ? "default" : "ghost"}
            size="sm"
            className="h-7"
            onClick={() => setViewMode("preview")}
          >
            <Eye className="w-3 h-3 mr-1" />
            Preview
          </Button>
          <Button
            variant={viewMode === "html" ? "default" : "ghost"}
            size="sm"
            className="h-7"
            onClick={() => setViewMode("html")}
          >
            <Code className="w-3 h-3 mr-1" />
            HTML
          </Button>
        </div>
        <Button variant="outline" size="sm" onClick={downloadHtml}>
          <Download className="w-3 h-3 mr-1" />
          Export HTML
        </Button>
      </div>

      {viewMode === "html" ? (
        <div className="overflow-hidden rounded-lg border">
          <div className="bg-gray-800 text-gray-100 p-4 max-h-[400px] overflow-y-auto">
            <pre className="text-xs font-mono whitespace-pre-wrap break-all">{generateHtml()}</pre>
          </div>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-white text-gray-900">
          <div className="bg-gray-100 p-4 border-b">
            <div className="font-semibold text-lg mb-2">Subject: {emailSubject}</div>
            <p className="text-xs text-gray-500">Draft preview · no recipient selected</p>
          </div>
          <div className="p-6 bg-white">
            {parsedContent.greeting && <p className="text-sm mb-4">{parsedContent.greeting}</p>}
            <div className="text-sm whitespace-pre-wrap text-gray-700">{emailBody}</div>
            {parsedContent.cta && (
              <div className="mt-4">
                <span className="inline-block bg-blue-500 text-white px-4 py-2 rounded text-sm">
                  {parsedContent.cta}
                </span>
              </div>
            )}
            {parsedContent.closing && <p className="text-sm mt-4">{parsedContent.closing}</p>}
            {parsedContent.signature && (
              <p className="text-sm font-medium mt-2">{parsedContent.signature}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
