import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { LoadingState } from "@/components/ui/loading-state";
import {
  Mail,
  Sparkles,
  FileText,
  CheckCircle,
  Users,
  Send,
  RefreshCw,
} from "lucide-react";
import api from "@/lib/api";
import { useEmailDraftGeneration } from '@/hooks/use-email-draft-generation';

interface Lead {
  id: number;
  name: string | null;
  company: string | null;
  role: string | null;
  email: string;
}

interface EmailTemplate {
  id: number;
  name: string;
  subject: string;
  body: string;
  createdAt: string;
}

interface OutreachDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leads: Lead[];
  onConfirm: (subject: string, body: string) => Promise<void>;
}

export function OutreachDialog({
  open,
  onOpenChange,
  leads,
  onConfirm,
}: OutreachDialogProps) {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<"template" | "generate" | "custom">("generate");
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [isLoadingTemplates, setIsLoadingTemplates] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState<EmailTemplate | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [isSending, setIsSending] = useState(false);
  const { isGenerating, generationError, generateEmailDraft, cancelGeneration } = useEmailDraftGeneration({
    open,
    scopeKey: JSON.stringify({ activeTab, isSending, leads }),
    draftKey: JSON.stringify({ subject, body }),
  });
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) cancelGeneration();
    onOpenChange(nextOpen);
  };

  // Get first lead for personalization preview
  const firstLead = leads[0];
  const isMultipleLeads = leads.length > 1;

  // Load templates when dialog opens
  useEffect(() => {
    if (open) {
      loadTemplates();
      // Reset state when opening
      setSelectedTemplate(null);
      setSubject("");
      setBody("");
    }
  }, [open]);

  const loadTemplates = async () => {
    try {
      setIsLoadingTemplates(true);
      const response = await api.get<{ templates: EmailTemplate[] }>("/api/email-outreach/templates");
      setTemplates(response.templates || []);
    } catch (error) {
      console.error("Failed to load templates:", error);
    } finally {
      setIsLoadingTemplates(false);
    }
  };

  const handleSelectTemplate = (template: EmailTemplate) => {
    setSelectedTemplate(template);
    setSubject(template.subject);
    setBody(template.body);
  };

  const handleGenerateEmail = async () => {
    if (!leads.length || isSending) return;
    await generateEmailDraft({
        prompt: isMultipleLeads
          ? `Create a professional outreach email template for ${leads.length} selected leads.`
          : `Create a professional outreach email for ${firstLead?.name || firstLead?.email || 'this lead'}${firstLead?.role ? `, ${firstLead.role}` : ''}${firstLead?.company ? ` at ${firstLead.company}` : ''}.`,
    }, draft => {
      setSubject(draft.subject);
      setBody(draft.body);
      toast({ title: 'Email Generated', description: 'AI-generated email content is ready for review' });
    });
  };

  const handleConfirm = async () => {
    if (!subject.trim() || !body.trim()) {
      toast({
        title: "Missing Content",
        description: "Please provide both subject and body for the email",
        variant: "destructive",
      });
      return;
    }

    try {
      setIsSending(true);
      await onConfirm(subject, body);
      onOpenChange(false);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to start outreach';
      toast({
        title: "Error",
        description: errorMessage,
        variant: "destructive",
      });
    } finally {
      setIsSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="w-5 h-5 text-purple-500" />
            Start Outreach
          </DialogTitle>
          <DialogDescription>
            {isMultipleLeads ? (
              <span className="flex items-center gap-2">
                <Users className="w-4 h-4" />
                Sending to {leads.length} leads
              </span>
            ) : (
              <span>
                Sending to {firstLead?.name || firstLead?.email}
                {firstLead?.company && ` at ${firstLead.company}`}
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "template" | "generate" | "custom")} className="flex-1 flex flex-col min-h-0">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="generate" className="gap-2">
              <Sparkles className="w-4 h-4" />
              Generate with AI
            </TabsTrigger>
            <TabsTrigger value="template" className="gap-2">
              <FileText className="w-4 h-4" />
              Use Template
            </TabsTrigger>
            <TabsTrigger value="custom" className="gap-2">
              <Mail className="w-4 h-4" />
              Custom Email
            </TabsTrigger>
          </TabsList>

          <div className="flex-1 min-h-0 mt-4">
            <TabsContent value="generate" className="h-full flex flex-col gap-4 mt-0">
              <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                  Generate a personalized email using AI based on the lead&apos;s information
                </p>
                <Button
                  onClick={handleGenerateEmail}
                  loading={isGenerating}
                  loadingText="Generating..."
                  disabled={isSending || leads.length === 0}
                  size="sm"
                  className="gap-2 bg-gradient-to-r from-purple-500 to-violet-500"
                >
                  <Sparkles className="w-4 h-4" />
                  Generate Email
                </Button>
              </div>

              {isGenerating && <Button type="button" variant="outline" onClick={() => cancelGeneration('Stopped waiting for email generation. Your draft has been kept.')}>Stop waiting</Button>}
              {generationError && <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive">
                <p>{generationError}</p>
                {!isGenerating && <Button type="button" variant="outline" size="sm" onClick={handleGenerateEmail} disabled={isSending || leads.length === 0}>Try again</Button>}
              </div>}

              {(subject || body) && (
                <div className="flex-1 space-y-4 overflow-auto">
                  <div className="space-y-2">
                    <Label htmlFor="generated-subject">Subject</Label>
                    <Input
                      id="generated-subject"
                      value={subject}
                      onChange={(e) => setSubject(e.target.value)}
                      placeholder="Email subject..."
                    />
                  </div>
                  <div className="space-y-2 flex-1">
                    <Label htmlFor="generated-body">Body</Label>
                    <Textarea
                      id="generated-body"
                      value={body}
                      onChange={(e) => setBody(e.target.value)}
                      placeholder="Email body..."
                      className="min-h-[200px] resize-none"
                    />
                  </div>
                </div>
              )}
            </TabsContent>

            <TabsContent value="template" className="h-full mt-0">
              <div className="flex flex-col h-full gap-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm text-muted-foreground">
                    Select from your saved email templates
                  </p>
                  <Button
                    onClick={loadTemplates}
                    variant="outline"
                    size="sm"
                    disabled={isLoadingTemplates}
                    className="gap-2"
                  >
                    <RefreshCw className={`w-4 h-4 ${isLoadingTemplates ? "animate-spin" : ""}`} />
                    Refresh
                  </Button>
                </div>

                {isLoadingTemplates ? (
                  <LoadingState className="py-8" label="Loading templates…" />
                ) : templates.length === 0 ? (
                  <div className="text-center py-8 text-muted-foreground">
                    <FileText className="w-12 h-12 mx-auto mb-4 opacity-20" />
                    <p>No email templates found</p>
                    <p className="text-sm">Create templates in the Content Studio</p>
                  </div>
                ) : (
                  <ScrollArea className="flex-1 border rounded-lg p-2">
                    <div className="space-y-2">
                      {templates.map((template) => (
                        <div
                          key={template.id}
                          onClick={() => handleSelectTemplate(template)}
                          className={`p-3 rounded-lg border cursor-pointer transition-all ${
                            selectedTemplate?.id === template.id
                              ? "border-purple-500 bg-purple-50 dark:bg-purple-950"
                              : "hover:border-gray-300 hover:bg-gray-50 dark:hover:bg-gray-900"
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="flex-1 min-w-0">
                              <p className="font-medium truncate">{template.name}</p>
                              <p className="text-sm text-muted-foreground truncate">
                                {template.subject}
                              </p>
                            </div>
                            {selectedTemplate?.id === template.id && (
                              <CheckCircle className="w-5 h-5 text-purple-500 flex-shrink-0" />
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </ScrollArea>
                )}

                {selectedTemplate && (
                  <div className="space-y-4 pt-4 border-t">
                    <div className="space-y-2">
                      <Label>Subject</Label>
                      <Input
                        value={subject}
                        onChange={(e) => setSubject(e.target.value)}
                        placeholder="Email subject..."
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Body</Label>
                      <Textarea
                        value={body}
                        onChange={(e) => setBody(e.target.value)}
                        className="min-h-[150px] resize-none"
                        placeholder="Email body..."
                      />
                    </div>
                  </div>
                )}
              </div>
            </TabsContent>

            <TabsContent value="custom" className="h-full space-y-4 mt-0">
              <p className="text-sm text-muted-foreground">
                Write a custom email for your outreach
              </p>
              <div className="space-y-2">
                <Label htmlFor="custom-subject">Subject</Label>
                <Input
                  id="custom-subject"
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  placeholder="Email subject..."
                />
              </div>
              <div className="space-y-2 flex-1">
                <Label htmlFor="custom-body">Body</Label>
                <Textarea
                  id="custom-body"
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder="Write your email here..."
                  className="min-h-[250px] resize-none"
                />
              </div>
              <div className="text-xs text-muted-foreground space-y-1">
                <p className="font-medium">Available variables:</p>
                <p>{`{{name}}`} - Full name of the lead (e.g., &quot;{firstLead?.name || 'John Doe'}&quot;)</p>
                <p>{`{{first_name}}`} - First name (e.g., &quot;{firstLead?.name?.split(' ')[0] || 'John'}&quot;)</p>
                <p>{`{{company}}`} - Company name (e.g., &quot;{firstLead?.company || 'Acme Inc'}&quot;)</p>
                <p>{`{{role}}`} - Job role (e.g., &quot;{firstLead?.role || 'Manager'}&quot;)</p>
                <p>{`{{email}}`} - Email address</p>
              </div>
            </TabsContent>
          </div>
        </Tabs>

        <DialogFooter className="mt-4 pt-4 border-t">
          <div className="flex items-center justify-between w-full">
            <div className="flex items-center gap-2">
              {isMultipleLeads && (
                <Badge variant="outline" className="gap-1">
                  <Users className="w-3 h-3" />
                  {leads.length} leads
                </Badge>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleConfirm}
                loading={isSending}
                loadingText="Sending..."
                disabled={!subject.trim() || !body.trim()}
                className="gap-2 bg-gradient-to-r from-purple-500 to-violet-500"
              >
                <Send className="w-4 h-4" />
                {isMultipleLeads ? `Send to ${leads.length} Leads` : "Send Email"}
              </Button>
            </div>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
