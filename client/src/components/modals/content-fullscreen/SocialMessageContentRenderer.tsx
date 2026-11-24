import { Badge } from "@/components/ui/badge";
import type { ContentRendererProps } from "./types";
import { getPlatformColor } from "./utils";

export default function SocialMessageContentRenderer({
  parsedContent,
  content,
  platform,
  channel,
}: ContentRendererProps) {
  const message = parsedContent.message || parsedContent.body || content;
  const displayPlatform = platform || parsedContent.platform || channel || "linkedin";
  const recipientName = parsedContent.recipientName || "Recipient";

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-xl border bg-white text-gray-900">
        <div className="bg-gray-100 p-3 flex items-center gap-3 border-b">
          <div className="w-10 h-10 bg-gradient-to-br from-gray-300 to-gray-400 rounded-full flex items-center justify-center">
            <span className="text-white font-bold">
              {recipientName.charAt(0).toUpperCase()}
            </span>
          </div>
          <div className="flex-1">
            <p className="font-semibold text-sm">{recipientName}</p>
            <p className="text-xs text-gray-500">Direct Message</p>
          </div>
          {displayPlatform && (
            <Badge className={`text-xs ${getPlatformColor(displayPlatform)}`}>
              {displayPlatform}
            </Badge>
          )}
        </div>
        <div className="p-4 bg-gray-50 min-h-[200px]">
          {parsedContent.subject && (
            <div className="text-center text-xs text-gray-500 mb-2">
              <span className="bg-gray-200 px-2 py-1 rounded">
                Subject: {parsedContent.subject}
              </span>
            </div>
          )}
          <div className="flex justify-end">
            <div className="max-w-[80%] bg-blue-500 text-white rounded-2xl rounded-br-sm px-4 py-2">
              {parsedContent.greeting && <p className="text-sm mb-1">{parsedContent.greeting}</p>}
              <p className="text-sm whitespace-pre-wrap">{message}</p>
              {parsedContent.closing && <p className="text-sm mt-2">{parsedContent.closing}</p>}
              {parsedContent.signature && (
                <p className="text-sm font-medium mt-1">{parsedContent.signature}</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
