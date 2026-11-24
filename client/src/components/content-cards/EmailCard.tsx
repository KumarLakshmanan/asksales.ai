import { useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/ui/copy-button";
import { Spinner } from "@/components/ui/spinner";
import { StatusBadge } from "@/components/ui/status-badge";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Mail, Edit, Trash2, User, Users, Send, Paperclip, MoreHorizontal, Download, Eye, Code, Rocket, ArrowRight, Maximize2, RefreshCw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { ContentFullscreenModal } from "@/components/modals";
import { normalizeUploadUrl } from "@/lib/utils";
import { readEmailDraft, emailDraftHtml } from "@/lib/emailTemplateSections";
import { sanitizeEmailPreviewHtml } from "@/lib/contentTemplateRendering";
import { formatLocaleDate as formatDate } from "@/lib/display-format";

// Helper function to strip HTML tags and convert to plain text
const stripHtml = (html: string): string => {
  if (!html) return '';
  // Replace common HTML tags with appropriate text equivalents
  const text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<p[^>]*>/gi, '')
    .replace(/<\/div>/gi, '\n')
    .replace(/<div[^>]*>/gi, '')
    .replace(/<li>/gi, '• ')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/(ul|ol)>/gi, '\n')
    .replace(/<(ul|ol)[^>]*>/gi, '')
    .replace(/<strong>/gi, '')
    .replace(/<\/strong>/gi, '')
    .replace(/<em>/gi, '')
    .replace(/<\/em>/gi, '')
    .replace(/<[^>]+>/g, '') // Remove any remaining HTML tags
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n') // Normalize multiple newlines
    .trim();
  return text;
};

interface EmailContent {
  subject?: string;
  greeting?: string;
  body?: string;
  closing?: string;
  signature?: string;
  cta?: string;
  imagePrompt?: string;
  videoPrompt?: string;
  imageUrl?: string;
  videoUrl?: string;
}

export interface EmailCardProps {
  id?: number;
  title: string;
  content: string;
  subject?: string;
  status?: string;
  channel?: string;
  createdAt?: string | number;
  imageUrl?: string;
  videoUrl?: string;
  prompt?: string;
  onEdit?: () => void;
  onDelete?: () => void;
  onImport?: () => void;
  onSend?: () => void;
  htmlContent?: string;
  onGenerateImage?: (imagePrompt: string) => Promise<void>;
  onGenerateVideo?: (videoPrompt: string) => Promise<void>;
  onHireAgent?: (agentType: string, prompt: string) => void;  // Callback to hire an agent
  isGeneratingImage?: boolean;
  isGeneratingVideo?: boolean;
  isNew?: boolean;
  variant?: "preview" | "full";
  showActions?: boolean;
}

export default function EmailCard({
  title,
  content,
  subject: propSubject,
  status,
  channel,
  createdAt,
  imageUrl,
  videoUrl,
  prompt,
  onEdit,
  onDelete,
  onImport,
  onSend,
  htmlContent,
   
  onGenerateImage,
   
  onGenerateVideo,
  onHireAgent,
  isGeneratingImage = false,
  isGeneratingVideo = false,
  isNew = false,
  variant = "full",
  showActions = true,
}: EmailCardProps) {
  const { toast } = useToast();
  const [viewMode, setViewMode] = useState<'preview' | 'html'>('preview');
  const [showFullscreen, setShowFullscreen] = useState(false);

  // Parse content if it's a JSON string
  const emailDraft = readEmailDraft(content);
  const parsedContent = emailDraft.sections as EmailContent;

  const emailSubject = parsedContent.subject || propSubject || title;
  const emailBody = stripHtml(parsedContent.body || '');

  const copyContent = () => `Subject: ${emailSubject}\n\n${stripHtml(emailDraft.body)}`.trim();

  const generateHtml = () => {
    if (htmlContent) return sanitizeEmailPreviewHtml(htmlContent);
    return emailDraftHtml(htmlContent ? { htmlContent } : content);
  };

  const generatePreviewHtml = () => {
    const html = sanitizeEmailPreviewHtml(htmlContent || generateHtml());
    const previewStyle = `
      <style>
        html, body {
          background: #ffffff !important;
          color: #111827 !important;
          color-scheme: light !important;
        }
        body {
          margin: 0 !important;
          overflow-wrap: anywhere;
        }
      </style>
    `;

    if (/<head[^>]*>/i.test(html)) {
      return html.replace(/<head([^>]*)>/i, `<head$1>${previewStyle}`);
    }

    if (/<html[^>]*>/i.test(html)) {
      return html.replace(/<html([^>]*)>/i, `<html$1><head>${previewStyle}</head>`);
    }

    return `<!DOCTYPE html><html><head><meta charset="utf-8">${previewStyle}</head><body>${html}</body></html>`;
  };

  const downloadHtml = () => {
    const html = generateHtml();
    const blob = new Blob([html], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `email-template-${Date.now()}.html`;
    link.click();
    URL.revokeObjectURL(url);
  };

  if (variant === "preview") {
    return (
      <div className="border rounded-lg p-4 hover:shadow-md transition-shadow">
        <div className="flex items-start justify-between mb-2">
          <div className="flex items-center gap-2">
            <Mail className="h-4 w-4 text-green-600" />
            <span className="font-medium text-sm">{title}</span>
          </div>
          {status && (
            <StatusBadge status={status} label={status} />
          )}
        </div>
        {emailSubject && (
          <p className="text-xs text-muted-foreground mb-1">Subject: {emailSubject}</p>
        )}
        <p className="text-sm text-muted-foreground line-clamp-3">{emailBody}</p>
        <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground/60">
          {channel && <Badge variant="outline" className="text-xs">{channel}</Badge>}
          {createdAt && <span>{new Date(createdAt).toLocaleDateString()}</span>}
        </div>
      </div>
    );
  }

  return (
    <Card className={`hover:shadow-md transition-shadow overflow-hidden min-w-0 ${isNew ? "ring-2 ring-emerald-400/70" : ""}`}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between mb-2">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-green-100 rounded-lg">
              <Mail className="h-5 w-5 text-green-600" />
            </div>
            <div className="flex items-center gap-2">
              <Badge className="bg-green-100 text-green-700">Email</Badge>
              {isNew && (
                <Badge className="bg-emerald-600 text-white">New</Badge>
              )}
              {status && (
                <StatusBadge status={status} label={status} />
              )}
            </div>
          </div>
          {showActions && (
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setShowFullscreen(true)} aria-label="View fullscreen" title="View fullscreen">
                <Maximize2 className="h-4 w-4" />
              </Button>
              <CopyButton variant="ghost" iconOnly className="h-8 w-8" value={copyContent} onCopied={() => toast({ title: "Copied", description: "Email template copied to clipboard" })} onError={() => toast({ title: "Could not copy", description: "Clipboard access was denied. Select and copy the text manually.", variant: "destructive" })} />
              {onImport && (
                <Button variant="ghost" size="icon" className="h-8 w-8 text-blue-600 hover:text-blue-700" onClick={onImport} aria-label="Import" title="Import Template">
                  <Download className="h-4 w-4" />
                </Button>
              )}
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
                      <AlertDialogTitle>Delete Email?</AlertDialogTitle>
                      <AlertDialogDescription>This action cannot be undone. The email will be permanently deleted.</AlertDialogDescription>
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
      <CardContent className="min-w-0">
        {/* View Mode Toggle & Download */}
        {showActions && (
          <div className="flex items-center gap-2 mb-3 min-w-0">
            <div className="grid grid-cols-2 gap-1 p-1 bg-muted/50 rounded-lg flex-1 min-w-0">
              <Button
                variant={viewMode === 'preview' ? 'default' : 'ghost'}
                size="sm"
                className="h-9 min-w-0 px-2 text-xs"
                onClick={() => setViewMode('preview')}
              >
                <Eye className="w-3.5 h-3.5 mr-1 shrink-0" />
                <span className="truncate">Preview</span>
              </Button>
              <Button
                variant={viewMode === 'html' ? 'default' : 'ghost'}
                size="sm"
                className="h-9 min-w-0 px-2 text-xs"
                onClick={() => setViewMode('html')}
              >
                <Code className="w-3.5 h-3.5 mr-1 shrink-0" />
                <span className="truncate">HTML</span>
              </Button>
            </div>
            <Button
              variant="outline"
              size="icon"
              className="h-10 w-10 shrink-0 rounded-lg"
              onClick={downloadHtml}
              aria-label="Download HTML"
              title="Download HTML"
            >
              <Download className="w-4 h-4" />
            </Button>
          </div>
        )}

        {/* HTML Code View */}
        {viewMode === 'html' ? (
          <div className="border rounded-lg overflow-hidden">
            <div className="bg-gray-800 text-gray-100 p-4 min-h-[200px] max-h-[300px] overflow-y-auto">
              <pre className="text-xs font-mono whitespace-pre-wrap break-all">
                {generateHtml()}
              </pre>
            </div>
          </div>
        ) : (
          /* Email Client Preview */
          <div className="border rounded-lg overflow-hidden">
            {/* Email Header */}
            <div className="bg-muted p-3 border-b min-w-0">
              {/* Email Toolbar */}
              <div className="flex items-center gap-2 mb-3 text-muted-foreground">
                <Send className="w-4 h-4" />
                <User className="w-4 h-4" />
                <Users className="w-4 h-4" />
                <Paperclip className="w-4 h-4" />
                <div className="flex-1" />
                <MoreHorizontal className="w-4 h-4" />
              </div>
              
              {/* Subject */}
              <div className="font-medium text-sm mb-2 line-clamp-2 break-words">{emailSubject}</div>
              
              <p className="text-xs text-muted-foreground">Draft preview · no recipient selected</p>
            </div>
            
            {/* Email Body */}
            <div className="p-4 bg-background min-h-[120px] max-h-[200px] overflow-y-auto">
              {htmlContent ? (
                <div className="w-full h-full min-h-[120px] overflow-hidden bg-white">
                  <iframe
                    srcDoc={generatePreviewHtml()}
                    className="w-full h-full border-0 bg-white"
                    sandbox=""
                    title="Preview"
                    scrolling="yes"
                    style={{ transform: 'scale(0.8)', transformOrigin: 'top left', width: '125%', height: '125%', minHeight: '150px' }}
                  />
                </div>
              ) : (
                <>
                  {parsedContent.greeting && (
                    <p className="text-sm mb-3">{parsedContent.greeting}</p>
                  )}
                  <div className="text-sm whitespace-pre-wrap text-foreground">
                    {emailBody}
                  </div>
                  {parsedContent.cta && (
                    <div className="mt-4">
                      <span className="inline-block bg-blue-500 text-white px-4 py-2 rounded text-sm">
                        {parsedContent.cta}
                      </span>
                    </div>
                  )}
                  {parsedContent.closing && (
                    <p className="text-sm mt-4">{parsedContent.closing}</p>
                  )}
                  {parsedContent.signature && (
                    <p className="text-sm font-medium mt-2">{parsedContent.signature}</p>
                  )}
                </>
              )}
            </div>
          </div>
        )}

        {/* Media Display & Auto-generating Indicator */}
        {(() => {
          // Show existing image
          if (imageUrl) {
            return (
              <div className="mt-3">
                <div className="aspect-video rounded-lg overflow-hidden border">
                  <img src={normalizeUploadUrl(imageUrl)} alt="Email Image" className="w-full h-full object-cover" />
                </div>
              </div>
            );
          }
          
          // Show generating indicators
          const showImageGenerating = isGeneratingImage && parsedContent.imagePrompt && !parsedContent.imageUrl;
          const showVideoGenerating = isGeneratingVideo && parsedContent.videoPrompt && !videoUrl;
          
          const showImageMissing = !isGeneratingImage && parsedContent.imagePrompt && !parsedContent.imageUrl;
          
          if (!showImageGenerating && !showVideoGenerating && !showImageMissing) return null;
          
          return (
            <div className="mt-3 p-4 space-y-2">
              {showImageGenerating && (
                <div className="flex items-center gap-2 text-sm text-green-600">
                  <Spinner size="sm" label={null} />
                  <span>Generating image...</span>
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
              
              {showVideoGenerating && (
                <div className="flex items-center gap-2 text-sm text-purple-600">
                  <Spinner size="sm" label={null} />
                  <span>Generating video...</span>
                </div>
              )}
            </div>
          );
        })()}

        {videoUrl && (
          <div className="mt-3 overflow-hidden rounded-lg border">
            <video aria-label="Email video attachment" src={normalizeUploadUrl(videoUrl)} controls preload="metadata" className="w-full aspect-video" onClick={event => event.stopPropagation()} />
          </div>
        )}

        {createdAt && (
          <p className="text-xs text-muted-foreground/60 mt-3 text-center">
            Created {formatDate(createdAt)}
          </p>
        )}

        {onSend && (
          <Button 
            className="w-full mt-4 gap-2 bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700 text-white font-medium shadow-sm"
            onClick={onSend}
          >
            <Send className="w-4 h-4" />
            Send Outreach Email
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
                  <p className="text-xs text-muted-foreground">Hire Emily for automated email campaigns</p>
                </div>
              </div>
              <Button
                size="sm"
                className="h-7 bg-primary text-xs text-primary-foreground hover:bg-primary/90"
                onClick={() => onHireAgent('OutreachAgent', 'Start an email outreach campaign with this email template')}
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
        contentType="email"
        title={title}
        content={JSON.stringify({ ...parsedContent, subject: emailSubject })}
        status={status}
        channel={channel}
        createdAt={createdAt}
        imageUrl={imageUrl}
        prompt={prompt}
      />
    </Card>
  );
}
