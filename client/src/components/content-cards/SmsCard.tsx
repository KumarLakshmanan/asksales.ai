import { useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Smartphone, Edit, Trash2, Rocket, ArrowRight, AlertTriangle, Wifi, Signal, Battery, Maximize2, RefreshCw, Send } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { ContentFullscreenModal } from "@/components/modals";
import { normalizeUploadUrl } from "@/lib/utils";
import { calculateSmsMetrics } from "@/lib/smsMetrics";
import { formatLocaleDate as formatDate } from "@/lib/display-format";

interface SmsContent {
  message?: string;
  characterCount?: number;
  imagePrompt?: string;
}

export interface SmsCardProps {
  id?: number;
  title: string;
  content: string;
  status?: string;
  channel?: string;
  createdAt?: string | number;
  imageUrl?: string;
  prompt?: string;
  onEdit?: () => void;
  onDelete?: () => void;
  onSend?: () => void;
  onGenerateImage?: (imagePrompt: string) => Promise<void>;
  onHireAgent?: (agentType: string, prompt: string) => void;  // Callback to hire an agent
  isGeneratingImage?: boolean;
  variant?: "preview" | "full";
  showActions?: boolean;
  maxCharacters?: number;
}

export default function SmsCard({
  title,
  content,
  status,
  channel,
  createdAt,
  imageUrl,
  prompt,
  onEdit,
  onDelete,
  onSend,
   
  onGenerateImage,
  onHireAgent,
  isGeneratingImage = false,
  variant = "full",
  showActions = true,
  maxCharacters,
}: SmsCardProps) {
  const { toast } = useToast();
  const [showFullscreen, setShowFullscreen] = useState(false);

  // Parse content if it's a JSON string
  const parsedContent: SmsContent = (() => {
    try {
      const parsed = JSON.parse(content);
      return {
        message: parsed.message || parsed.content || content,
        characterCount: parsed.characterCount || (parsed.message || parsed.content || content).length,
        imagePrompt: parsed.imagePrompt,
      };
    } catch {
      return { message: content, characterCount: content.length };
    }
  })();

  const message = parsedContent.message || '';
  const charCount = message.length;
  const metrics = calculateSmsMetrics(message);
  const isOverLimit = maxCharacters !== undefined && charCount > maxCharacters;


  if (variant === "preview") {
    return (
      <div className="border rounded-lg p-4 hover:shadow-md transition-shadow">
        <div className="flex items-start justify-between mb-2">
          <div className="flex items-center gap-2">
            <Smartphone className="h-4 w-4 text-green-600" />
            <span className="font-medium text-sm">{title}</span>
          </div>
          {status && (
            <StatusBadge status={status} label={status} />
          )}
        </div>
        <p className="text-sm text-muted-foreground line-clamp-3">{message}</p>
        <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground/60">
          {channel && <Badge variant="outline" className="text-xs">{channel}</Badge>}
          <Badge variant={isOverLimit ? "destructive" : "secondary"} className="text-xs">
            {charCount}{maxCharacters ? `/${maxCharacters}` : ''} chars · {metrics.encoding} · {metrics.segments} segments
          </Badge>
          {createdAt && <span>{new Date(createdAt).toLocaleDateString()}</span>}
        </div>
      </div>
    );
  }

  return (
    <Card className="hover:shadow-md transition-shadow overflow-hidden">
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between mb-2">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-yellow-100 rounded-lg">
              <Smartphone className="h-5 w-5 text-yellow-600" />
            </div>
            <div className="flex items-center gap-2">
              <Badge className="bg-yellow-100 text-yellow-700">SMS</Badge>
              {status && (
                <StatusBadge status={status} label={status} />
              )}
            </div>
          </div>
          {showActions && (
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setShowFullscreen(true)} aria-label="View fullscreen" title="View Fullscreen">
                <Maximize2 className="h-4 w-4" />
              </Button>
              <CopyButton variant="ghost" iconOnly className="h-8 w-8" value={message} onCopied={() => toast({ title: "Copied", description: "SMS template copied to clipboard" })} />
              {onEdit && (
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onEdit} aria-label="Edit">
                  <Edit className="h-4 w-4" />
                </Button>
              )}
              {onDelete && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive" aria-label="Delete">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete SMS?</AlertDialogTitle>
                      <AlertDialogDescription>This action cannot be undone. The SMS will be permanently deleted.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={onDelete} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </div>
          )}
        </div>
        <h4 className="font-medium text-base leading-tight line-clamp-2">{title}</h4>
      </CardHeader>
      <CardContent>
        {/* Realistic iPhone-style Phone Preview */}
        <div className="flex justify-center py-2">
          <div className="relative w-full max-w-[280px]">
            {/* iPhone outer frame */}
            <div className="w-full rounded-[3rem] bg-[#1c1c1e] p-[10px] shadow-2xl">
              {/* Side buttons */}
              <div className="absolute -left-[3px] top-24 w-[3px] h-8 bg-[#3a3a3c] rounded-l-sm" />
              <div className="absolute -left-[3px] top-36 w-[3px] h-14 bg-[#3a3a3c] rounded-l-sm" />
              <div className="absolute -left-[3px] top-52 w-[3px] h-14 bg-[#3a3a3c] rounded-l-sm" />
              <div className="absolute -right-[3px] top-32 w-[3px] h-16 bg-[#3a3a3c] rounded-r-sm" />
              
              {/* Screen */}
              <div className="bg-white text-gray-900 rounded-[2.5rem] overflow-hidden relative">
                {/* Dynamic Island / Notch */}
                <div className="absolute top-2 left-1/2 -translate-x-1/2 w-28 h-7 bg-black rounded-full z-10 flex items-center justify-center gap-2">
                  <div className="w-2 h-2 rounded-full bg-[#1c1c1e] ring-1 ring-[#2c2c2e]" />
                  <div className="w-3 h-3 rounded-full bg-[#1c1c1e] ring-1 ring-[#2c2c2e]" />
                </div>
                
                {/* Status Bar */}
                <div className="h-12 bg-[#f2f2f7] flex items-end justify-between px-6 pb-1.5 text-xs font-medium text-black">
                  <span>9:41</span>
                  <div className="flex items-center gap-1">
                    <Signal className="w-3.5 h-3.5" />
                    <Wifi className="w-3.5 h-3.5" />
                    <Battery className="w-4.5 h-3.5" />
                  </div>
                </div>
                
                {/* Messages App Header */}
                <div className="bg-[#f2f2f7] px-4 pb-2">
                  <div className="flex items-center justify-center gap-2">
                    <div className="w-10 h-10 bg-gradient-to-br from-green-400 to-green-600 rounded-full flex items-center justify-center">
                      <span className="text-white font-semibold text-sm">M</span>
                    </div>
                  </div>
                  <p className="text-center text-xs font-semibold mt-1">Marketing</p>
                  <p className="text-center text-xs text-gray-500">SMS/MMS</p>
                </div>
                
                {/* Messages Area */}
                <div className="bg-white px-3 py-3 min-h-[180px]">
                  {/* Incoming Message Bubble */}
                  <div className="flex justify-start mb-1">
                    <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-[#e9e9eb] px-3 py-2 shadow-sm">
                      <p className="text-[13px] text-black whitespace-pre-wrap leading-tight">{message}</p>
                    </div>
                  </div>
                  
                  {/* Timestamp */}
                  <p className="text-xs text-gray-400 text-center my-2">Today {new Date().toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</p>
                  
                  {/* Delivered indicator */}
                  <div className="flex justify-end">
                    <span className="text-xs text-gray-400">Delivered</span>
                  </div>
                </div>
                
                {/* iMessage Input Bar */}
                <div className="bg-[#f2f2f7] px-3 py-2 flex items-center gap-2 border-t">
                  <div className="w-7 h-7 bg-[#007aff] rounded-full flex items-center justify-center">
                    <span className="text-white text-lg font-light">+</span>
                  </div>
                  <div className="flex-1 bg-white rounded-full px-3 py-1.5 border border-gray-300">
                    <span className="text-xs text-gray-400">Text Message</span>
                  </div>
                  <div className="w-7 h-7 bg-[#007aff] rounded-full flex items-center justify-center">
                    <svg className="w-3.5 h-3.5 text-white" fill="currentColor" viewBox="0 0 20 20">
                      <path d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-11a1 1 0 10-2 0v3.586L7.707 9.293a1 1 0 00-1.414 1.414l3 3a1 1 0 001.414 0l3-3a1 1 0 00-1.414-1.414L11 10.586V7z"/>
                    </svg>
                  </div>
                </div>
                
                {/* Home Indicator */}
                <div className="h-6 bg-white flex items-center justify-center">
                  <div className="w-32 h-1 bg-black rounded-full" />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Character Count */}
        <div className="flex items-center justify-between mt-3 px-2">
          <span className="text-xs text-muted-foreground">Character count:</span>
          <Badge variant={isOverLimit ? 'destructive' : 'secondary'}>
            {charCount}{maxCharacters ? `/${maxCharacters}` : ''} chars · {metrics.encoding} · {metrics.segments} segments
          </Badge>
        </div>
        
        {isOverLimit && (
          <p className="text-xs text-red-500 px-2 mt-1 flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" />
            Message exceeds the {maxCharacters}-character draft limit
          </p>
        )}

        {/* Media Display & Auto-generating Indicator */}
        {(() => {
          if (imageUrl) {
            return (
              <div className="mt-3">
                <div className="aspect-video rounded-lg overflow-hidden border">
                  <img src={normalizeUploadUrl(imageUrl)} alt="MMS Image" className="w-full h-full object-cover" />
                </div>
              </div>
            );
          }
          const showImageGenerating = isGeneratingImage && parsedContent.imagePrompt && !imageUrl;
          const showImageMissing = !isGeneratingImage && parsedContent.imagePrompt && !imageUrl;
          
          if (!showImageGenerating && !showImageMissing) return null;
          
          return (
            <div className="mt-3 p-4 space-y-2">
              {showImageGenerating && (
                <div className="flex items-center gap-2 text-sm text-blue-600">
                  <Spinner size="sm" label={null} />
                  <span>Generating MMS image...</span>
                </div>
              )}
              {showImageMissing && onGenerateImage && (
                <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground bg-muted/50 p-2 rounded">
                  <span>No image attached yet.</span>
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={(e) => { e.stopPropagation(); onGenerateImage(parsedContent.imagePrompt!); }}>
                    <RefreshCw className="w-3 h-3 mr-1" /> Generate
                  </Button>
                </div>
              )}
            </div>
          );
        })()}

        {createdAt && (
          <p className="text-xs text-muted-foreground/60 mt-2 text-center">
            Created {formatDate(createdAt)}
          </p>
        )}

        {onSend && (
          <Button 
            className="w-full mt-4 gap-2 bg-gradient-to-r from-yellow-600 to-amber-600 hover:from-yellow-700 hover:to-amber-700 text-white font-medium shadow-sm"
            onClick={onSend}
          >
            <Send className="w-4 h-4" />
            Send Outreach SMS
          </Button>
        )}

        {/* Outreach Agent Recommendation */}
        {onHireAgent && showActions && (
          <div className="pt-3 border-t mt-3">
            <div className="flex items-center justify-between gap-3 rounded-lg border border-primary/20 bg-primary/5 p-2">
              <div className="flex items-center gap-2">
                <div className="rounded-md bg-primary p-1.5">
                  <Rocket className="w-3 h-3 text-white" />
                </div>
                <div>
                  <p className="text-xs font-medium">Ready to send?</p>
                  <p className="text-xs text-muted-foreground">Hire Emily for automated SMS campaigns</p>
                </div>
              </div>
              <Button
                size="sm"
                className="h-7 bg-primary text-xs text-primary-foreground hover:bg-primary/90"
                onClick={() => onHireAgent('OutreachAgent', 'Start an SMS outreach campaign with this SMS template')}
              >
                Launch Outreach <ArrowRight className="w-3 h-3 ml-1" />
              </Button>
            </div>
          </div>
        )}
      </CardContent>

      {/* Fullscreen Modal */}
      <ContentFullscreenModal
        open={showFullscreen}
        onOpenChange={setShowFullscreen}
        contentType="sms"
        title={title}
        content={content}
        status={status}
        channel={channel}
        createdAt={typeof createdAt === 'number' ? new Date(createdAt).toISOString() : createdAt}
        imageUrl={imageUrl}
        prompt={prompt}
      />
    </Card>
  );
}
