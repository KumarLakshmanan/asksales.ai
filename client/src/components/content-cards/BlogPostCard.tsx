import { useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Copy,
  Edit,
  Trash2,
  Eye,
  Clock,
  BookOpen,
  ArrowRight,
  Check,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export interface BlogPostCardProps {
  id?: number;
  /** Template name or asset title */
  name: string;
  /** Full blog content (may contain markdown / plain text) */
  content: string;
  /** Extracted or explicit title for the blog post */
  blogTitle?: string;
  /** Category label */
  category?: string;
  /** Tags list */
  tags?: string[];
  /** Status badge */
  status?: string;
  createdAt?: string;
  onPreview?: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onCopy?: () => void;
  showActions?: boolean;
}

/**
 * Extract a title and body from blog content.
 * Handles markdown headings (# Title) and plain text.
 */
function extractBlogText(content: string): { title: string; body: string } {
  if (!content) return { title: "", body: "" };
  try {
    const parsed = JSON.parse(content);
    return {
      title: parsed.title || parsed.headline || "",
      body: parsed.body || parsed.content || content,
    };
  } catch {
    // Not JSON — try markdown heading
    const lines = content.split("\n");
    const headingIdx = lines.findIndex((l) => /^#{1,2}\s/.test(l));
    if (headingIdx !== -1) {
      const title = lines[headingIdx].replace(/^#{1,2}\s+/, "").trim();
      const body = lines
        .filter((_, i) => i !== headingIdx)
        .join("\n")
        .trim();
      return { title, body };
    }
    return { title: "", body: content };
  }
}

export default function BlogPostCard({
  name,
  content,
  blogTitle,
  category,
  tags,
  status,
  createdAt,
  onPreview,
  onEdit,
  onDelete,
  onCopy,
  showActions = true,
}: BlogPostCardProps) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);

  const { title: extractedTitle, body } = extractBlogText(content);
  const displayTitle = blogTitle || extractedTitle || name;
  const wordCount = body.split(" ").filter(Boolean).length;
  const readTime = Math.max(1, Math.ceil(wordCount / 200));

  const handleCopy = () => {
    const text = [displayTitle, body].filter(Boolean).join("\n\n");
    navigator.clipboard.writeText(text);
    setCopied(true);
    toast({ title: "Copied to clipboard" });
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Card className="group hover:shadow-lg transition-all duration-300 overflow-hidden border-0 shadow-sm bg-gradient-to-b from-card to-card/80">
      {/* Teal accent bar */}
      <div className="h-1 bg-gradient-to-r from-teal-500 via-emerald-500 to-cyan-500" />

      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            {/* Category / Status row */}
            <div className="flex items-center gap-2 mb-2">
              {category && (
                <Badge
                  variant="secondary"
                  className="text-xs uppercase tracking-wider font-semibold bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-400"
                >
                  {category}
                </Badge>
              )}
              {status && (
                <Badge
                  variant="outline"
                  className="text-xs capitalize"
                >
                  {status}
                </Badge>
              )}
            </div>

            {/* Title */}
            <h3 className="font-semibold text-base leading-snug line-clamp-2 group-hover:text-teal-700 dark:group-hover:text-teal-400 transition-colors">
              {displayTitle}
            </h3>

            {/* Template name (if different from title) */}
            {name !== displayTitle && (
              <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                {name}
              </p>
            )}
          </div>

          {/* Action buttons */}
          {showActions && (
            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
              {onPreview && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-teal-600 hover:text-teal-700 hover:bg-teal-50"
                  onClick={onPreview}
                  aria-label="Preview"
                  title="Preview"
                >
                  <Eye className="h-3.5 w-3.5" />
                </Button>
              )}
              {onEdit && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7"
                  onClick={onEdit}
                  aria-label="Edit"
                  title="Edit"
                >
                  <Edit className="h-3.5 w-3.5" />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={onCopy || handleCopy}
                aria-label="Copy"
                title="Copy"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-green-500" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </Button>
              {onDelete && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive"
                      aria-label="Delete"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete Blog Post?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This action cannot be undone. The blog post will be
                        permanently deleted.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={onDelete}
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      >
                        Delete
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </div>
          )}
        </div>
      </CardHeader>

      <CardContent className="pt-0">
        {/* Body excerpt */}
        <p className="text-sm text-muted-foreground leading-relaxed line-clamp-4 mb-3">
          {body}
        </p>

        {/* Tags */}
        {tags && tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-3">
            {tags.slice(0, 3).map((tag) => (
              <Badge
                key={tag}
                variant="outline"
                className="text-xs font-normal text-muted-foreground"
              >
                {tag}
              </Badge>
            ))}
            {tags.length > 3 && (
              <span className="text-xs text-muted-foreground self-center">
                +{tags.length - 3}
              </span>
            )}
          </div>
        )}

        {/* Footer: meta info */}
        <div className="flex items-center justify-between pt-3 border-t border-border/50">
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <BookOpen className="w-3 h-3" />
              {wordCount.toLocaleString()} words
            </span>
            <span className="flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {readTime} min read
            </span>
          </div>

          {onPreview && (
            <button
              onClick={onPreview}
              className="text-xs font-medium text-teal-600 hover:text-teal-700 dark:text-teal-400 flex items-center gap-1 transition-colors"
            >
              Read
              <ArrowRight className="w-3 h-3 group-hover:translate-x-0.5 transition-transform" />
            </button>
          )}
        </div>

        {/* Date */}
        {createdAt && (
          <p className="text-xs text-muted-foreground/50 mt-2 text-right">
            {new Date(createdAt).toLocaleDateString()}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
