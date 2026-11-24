import { ExternalLink } from "lucide-react";
import type { ContentRendererProps } from "./types";

export default function AdCopyContentRenderer({
  parsedContent,
  title,
  platform,
  channel,
}: ContentRendererProps) {
  const adHeadline = parsedContent.headline || title;
  const adDescription = parsedContent.description;
  const adBody = parsedContent.body || parsedContent.primaryText || "";
  const adCta = parsedContent.callToAction;
  const displayUrl = parsedContent.displayUrl || "yoursite.com";
  const displayPlatform = platform || parsedContent.platform || channel || "meta";

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-lg border bg-white text-gray-900">
        <div className="bg-gray-50 px-3 py-1 border-b flex items-center gap-1 text-xs text-gray-500">
          <span>Sponsored</span>
          {displayPlatform && <span className="capitalize">• {displayPlatform}</span>}
        </div>
        <div className="p-4">
          <div className="text-blue-600 text-lg font-medium mb-1 flex items-center gap-1">
            {adHeadline}
            <ExternalLink className="w-3 h-3" />
          </div>
          <div className="text-xs text-green-600 mb-2 flex items-center gap-1">
            <span>Ad</span>
            <span>•</span>
            <span>{displayUrl}</span>
          </div>
          {adDescription && <p className="text-sm text-gray-600 mb-2">{adDescription}</p>}
          {adBody && <p className="text-sm text-gray-700">{adBody}</p>}
          {adCta && (
            <div className="mt-3">
              <span className="inline-block bg-blue-500 text-white px-4 py-2 rounded text-sm font-medium">
                {adCta}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
