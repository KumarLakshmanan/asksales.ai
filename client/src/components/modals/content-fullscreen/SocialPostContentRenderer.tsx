import { Badge } from "@/components/ui/badge";
import type { ContentRendererProps } from "./types";
import { getPlatformColor } from "./utils";
import { hashtagsMissingFromCaption } from "../../../../../shared/socialCaption";
import { brandInitial, useCachedBrandName } from "@/hooks/use-cached-brand-name";

export default function SocialPostContentRenderer({
  parsedContent,
  content,
  platform,
  channel,
}: ContentRendererProps) {
  const postContent = parsedContent.content || parsedContent.caption || parsedContent.body || content;
  // The caption often already ends with these tags; show each one only once.
  const hashtags = hashtagsMissingFromCaption(String(postContent || ""), parsedContent.hashtags);
  const displayPlatform = platform || parsedContent.platform || channel;
  const brandName = useCachedBrandName();

  return (
    <div className="space-y-4">
      <div className="overflow-hidden rounded-xl border bg-white text-gray-900">
        <div className="p-3 flex items-center gap-3 border-b">
          <div className="w-10 h-10 bg-gradient-to-br from-purple-400 to-violet-400 rounded-full flex items-center justify-center text-white font-bold text-sm">
            {brandInitial(brandName)}
          </div>
          <div className="flex-1">
            <p className="font-semibold text-sm">{brandName}</p>
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
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
