import { Badge } from "@/components/ui/badge";
import type { ContentRendererProps } from "./types";
import { getPlatformColor } from "./utils";

export default function SocialPostContentRenderer({
  parsedContent,
  content,
  platform,
  channel,
}: ContentRendererProps) {
  const postContent = parsedContent.content || parsedContent.caption || parsedContent.body || content;
  const hashtags = (parsedContent.hashtags || []).map((h: string) =>
    typeof h === "string" ? h.replace(/^#+/, "") : h
  );
  const displayPlatform = platform || parsedContent.platform || channel;

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-xl border bg-white text-gray-900">
        <div className="p-3 flex items-center gap-3 border-b">
          <div className="w-10 h-10 bg-gradient-to-br from-purple-400 to-violet-400 rounded-full flex items-center justify-center text-white font-bold text-sm">
            Y
          </div>
          <div className="flex-1">
            <p className="font-semibold text-sm">Your Brand</p>
            <p className="text-xs text-gray-500">@yourbrand</p>
          </div>
          {displayPlatform && (
            <Badge className={`text-xs ${getPlatformColor(displayPlatform)}`}>
              {displayPlatform}
            </Badge>
          )}
        </div>
        <div className="p-4">
          <p className="text-sm whitespace-pre-wrap break-words">{postContent}</p>
          {hashtags && hashtags.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-3">
              {hashtags.map((tag: string, i: number) => (
                <span key={i} className="text-sm text-blue-500">
                  #{tag}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
