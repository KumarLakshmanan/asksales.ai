import { Badge } from "@/components/ui/badge";
import type { ContentRendererProps } from "./types";

export default function SmsContentRenderer({
  parsedContent,
  content,
}: ContentRendererProps) {
  const message = parsedContent.message || parsedContent.content || content;
  const charCount = message?.length || 0;
  const isOverLimit = charCount > 160;

  return (
    <div className="space-y-4">
      <div className="flex justify-center">
        <div className="w-full max-w-[300px] rounded-[3rem] bg-[#1c1c1e] p-[10px] shadow-2xl">
          <div className="overflow-hidden rounded-[2.5rem] bg-white text-gray-900">
            <div className="h-10 bg-[#f2f2f7] flex items-center justify-center text-xs font-medium">
              Messages
            </div>
            <div className="bg-white px-3 py-3 min-h-[200px]">
              <div className="flex justify-start mb-1">
                <div className="bg-[#e9e9eb] px-3 py-2 rounded-2xl rounded-bl-md max-w-[220px] shadow-sm">
                  <p className="text-sm text-black whitespace-pre-wrap leading-tight">{message}</p>
                </div>
              </div>
              <p className="text-[9px] text-gray-400 text-center my-2">Today</p>
            </div>
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">Character count:</span>
        <Badge variant={isOverLimit ? "destructive" : "secondary"}>
          {charCount}/160 {isOverLimit && "(exceeds limit)"}
        </Badge>
      </div>
    </div>
  );
}
