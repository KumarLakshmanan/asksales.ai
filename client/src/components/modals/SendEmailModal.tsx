/**
 * Send Email Modal Component
 * Allows sending emails directly to leads with personalization
 */

import { useState, useEffect, useRef } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import api from '@/lib/api';
import {
  Mail,
  Send,
  User,
  CheckCircle2,
  XCircle,
  Eye,
  Sparkles,
} from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import DOMPurify from 'dompurify';
import { renderTemplateVariableMap } from '@/utils/templateVariables';
import { useEmailDraftGeneration } from '@/hooks/use-email-draft-generation';

interface Lead {
  id: number;
  name?: string;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  company?: string;
  companyName?: string;
  role?: string;
  headline?: string;
  industry?: string;
}

interface EmailTemplate {
  id: number;
  name: string;
  subject: string;
  body: string;
}

interface SendEmailModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leads: Lead[];
  onSuccess?: () => void;
  initialSubject?: string;
  initialBody?: string;
}

function emailTemplateValues(lead: Lead) {
  return {
    first_name: lead.firstName || lead.fullName?.split(' ')[0] || lead.name?.split(' ')[0],
    last_name: lead.lastName || lead.fullName?.split(' ').slice(1).join(' '),
    full_name: lead.fullName || lead.name,
    company_name: lead.companyName || lead.company,
    job_title: lead.role,
    industry: lead.industry,
    headline: lead.headline,
  };
}

export function SendEmailModal({
  open,
  onOpenChange,
  leads,
  onSuccess,
  initialSubject = '',
  initialBody = '',
}: SendEmailModalProps) {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState('compose');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [_isLoadingTemplates, setIsLoadingTemplates] = useState(false);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('');
  const [sendResults, setSendResults] = useState<
    Array<{ email: string; success: boolean; error?: string }>
  >([]);
  const [previewHtml, setPreviewHtml] = useState('');
  const sendAttemptRef = useRef<{ fingerprint: string; keys: Map<number, string> } | null>(null);

  // Template variables
  const TEMPLATE_VARIABLES = [
    { key: 'first_name', label: 'First Name', example: 'John' },
    { key: 'last_name', label: 'Last Name', example: 'Doe' },
    { key: 'full_name', label: 'Full Name', example: 'John Doe' },
    { key: 'company_name', label: 'Company', example: 'Acme Inc' },
    { key: 'job_title', label: 'Role', example: 'Marketing Manager' },
    { key: 'industry', label: 'Industry', example: 'Technology' },
    { key: 'headline', label: 'Headline', example: 'CEO at Acme' },
  ];

  // Local lead selection states
  const [allLeads, setAllLeads] = useState<Lead[]>([]);
  const [leadSearchQuery, setLeadSearchQuery] = useState('');
  const [localSelectedLeads, setLocalSelectedLeads] = useState<Lead[]>([]);
  const generationLeads = leads.length > 0 ? leads : localSelectedLeads;
  const { isGenerating, generationError, generateEmailDraft, cancelGeneration } = useEmailDraftGeneration({
    open,
    scopeKey: JSON.stringify({ activeTab, isSending, leads: generationLeads }),
    draftKey: JSON.stringify({ subject, body }),
  });
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) cancelGeneration();
    onOpenChange(nextOpen);
  };

  const fetchLeads = async () => {
    try {
      const url = '/api/leads';
      const response = await api.get<Lead[]>(url);
      if (Array.isArray(response)) {
        setAllLeads(response);
      }
    } catch {
      toast({ title: 'Could not load leads', description: 'Please close the dialog and try again.', variant: 'destructive' });
    }
  };

  const loadTemplates = async () => {
    setIsLoadingTemplates(true);
    try {
      // Fetch from both email-outreach templates and email builder templates
      const [outreachRes, builderRes] = await Promise.all([
        api.get<EmailTemplate[]>('/api/email-outreach/templates').catch(() => [] as EmailTemplate[]),
        api.get<Array<{ id: number; name: string; subject?: string; content: string; htmlContent?: string }>>(
          '/api/content/templates?type=email&includePredefined=true'
        ).catch(() => []),
      ]);
      // Merge: outreach templates + builder templates (with offset IDs to avoid collisions)
      const builderMapped = (builderRes || []).map((t) => ({
        id: t.id + 100000,
        name: `[Builder] ${t.name}`,
        subject: t.subject || t.name,
        body: t.htmlContent || t.content,
      }));
      setTemplates([...(outreachRes || []), ...builderMapped]);
    } catch {
      toast({ title: 'Could not load templates', description: 'You can still write the email manually.', variant: 'destructive' });
    } finally {
      setIsLoadingTemplates(false);
    }
  };

  // Reload dialog data for each open. These functions intentionally stay
  // local because they update this dialog's transient state only.
  useEffect(() => {
    if (open) {
      void loadTemplates();
      if (initialSubject) setSubject(initialSubject);
      if (initialBody) setBody(initialBody);
      setLocalSelectedLeads(leads);
      if (leads.length === 0) {
        void fetchLeads();
      }
    }
    // The loaders are recreated with dialog state; rerunning on those function
    // identities would loop. The real reload inputs are listed below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialSubject, initialBody, leads]);

  const handleTemplateSelect = (templateId: string) => {
    setSelectedTemplateId(templateId);
    const template = templates.find((t) => t.id.toString() === templateId);
    if (template) {
      setSubject(template.subject);
      setBody(template.body);
    }
  };

  const handleGenerateEmail = async () => {
    if (!generationLeads.length || isSending) return;
    const sampleLead = generationLeads[0];
    await generateEmailDraft({
      prompt: `Generate a professional cold outreach email for ${sampleLead.name || 'a potential customer'} who is ${sampleLead.role || 'a decision maker'} at ${sampleLead.company || sampleLead.companyName || 'their company'}`,
      tone: 'professional',
    }, draft => {
      setSubject(draft.subject);
      setBody(draft.body);
      toast({ title: 'Email Generated', description: 'AI-generated email content is ready for review' });
    });
  };

  const handleSendEmails = async () => {
    if (!subject.trim() || !body.trim()) {
      toast({
        title: 'Error',
        description: 'Please enter subject and body',
        variant: 'destructive',
      });
      return;
    }

    const selectedLeads = leads.length > 0 ? leads : localSelectedLeads;
    const leadsWithEmail = selectedLeads.filter((lead) => lead.email);

    if (leadsWithEmail.length === 0) {
      toast({
        title: 'Error',
        description: 'No leads have email addresses',
        variant: 'destructive',
      });
      return;
    }

    const unresolved = new Set<string>();
    leadsWithEmail.forEach((lead) => {
      renderTemplateVariableMap(subject, emailTemplateValues(lead)).unresolved.forEach((token) => unresolved.add(token));
      renderTemplateVariableMap(body, emailTemplateValues(lead)).unresolved.forEach((token) => unresolved.add(token));
    });
    if (unresolved.size > 0) {
      toast({
        title: 'Resolve template variables',
        description: `Missing recipient data for ${[...unresolved].map((token) => `{{${token}}}`).join(', ')}. No emails were sent.`,
        variant: 'destructive',
      });
      return;
    }

    setIsSending(true);

    try {
      const fingerprint = JSON.stringify({
        subject: subject.trim(),
        body: body.trim(),
        leadIds: leadsWithEmail.map((lead) => lead.id).sort((a, b) => a - b),
      });
      const sameAttempt = sendAttemptRef.current?.fingerprint === fingerprint;
      if (!sameAttempt) {
        sendAttemptRef.current = { fingerprint, keys: new Map() };
      }
      const keys = sendAttemptRef.current!.keys;
      const previousSuccesses = sameAttempt
        ? new Set(sendResults.filter((result) => result.success).map((result) => result.email))
        : new Set<string>();
      const results: Array<{ email: string; success: boolean; error?: string }> = [];

      for (const lead of leadsWithEmail) {
        const email = lead.email || '';
        if (previousSuccesses.has(email)) {
          results.push({ email, success: true });
          continue;
        }

        const personalize = (value: string) => renderTemplateVariableMap(value, emailTemplateValues(lead)).content;
        const idempotencyKey = keys.get(lead.id) || crypto.randomUUID();
        keys.set(lead.id, idempotencyKey);

        try {
          await api.post('/api/outreach/send', {
            leadId: lead.id,
            channel: 'email',
            subject: personalize(subject.trim()),
            message: personalize(body.trim()),
            idempotencyKey,
          });
          results.push({ email, success: true });
        } catch (error) {
          results.push({ email, success: false, error: error instanceof Error ? error.message : 'Send failed' });
        }
      }

      const sent = results.filter((result) => result.success).length;
      setSendResults(results);
      setActiveTab('results');
      toast({
        title: sent === results.length ? 'Emails sent' : 'Email send completed with issues',
        description: `${sent} of ${results.length} emails sent successfully. Failed recipients can be retried safely.`,
        variant: sent === 0 ? 'destructive' : 'default',
      });
      if (sent > 0) onSuccess?.();
    } finally {
      setIsSending(false);
    }
  };

  const insertVariable = (variable: string) => {
    setBody((prev) => prev + `{{${variable}}}`);
  };

  const generatePreview = () => {
    const activeLeads = leads && leads.length > 0 ? leads : localSelectedLeads;
    if (activeLeads.length === 0) return;
    
    const sampleLead = activeLeads[0];
    setPreviewHtml(renderTemplateVariableMap(body, emailTemplateValues(sampleLead)).content);
    setActiveTab('preview');
  };

  // Get leads with emails
  const leadsWithEmail = (leads && leads.length > 0 ? leads : localSelectedLeads).filter((lead) => lead.email);
  const unresolvedForSelectedLeads = [...new Set(leadsWithEmail.flatMap((lead) => [
    ...renderTemplateVariableMap(subject, emailTemplateValues(lead)).unresolved,
    ...renderTemplateVariableMap(body, emailTemplateValues(lead)).unresolved,
  ]))];

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Mail className="w-5 h-5 text-green-500" />
            Send Email
          </DialogTitle>
          <DialogDescription>
            Send personalized emails to selected leads
          </DialogDescription>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="compose">Compose</TabsTrigger>
            <TabsTrigger value="preview">Preview</TabsTrigger>
            <TabsTrigger value="results" disabled={sendResults.length === 0}>
              Results
            </TabsTrigger>
          </TabsList>

          <TabsContent value="compose" className="space-y-4 mt-4">
            {/* Recipients */}
            <div>
              <Label>Recipients ({leadsWithEmail.length})</Label>
              <div className="mt-2 flex flex-wrap gap-2 max-h-24 overflow-y-auto p-2 border rounded-md bg-muted/50">
                {leadsWithEmail.length > 0 ? (
                  leadsWithEmail.map((lead) => (
                    <Badge key={lead.id} variant="secondary" className="flex items-center gap-1">
                      <User className="w-3 h-3" />
                      {lead.email}
                    </Badge>
                  ))
                ) : (
                  <span className="text-sm text-muted-foreground">No leads with email addresses selected</span>
                )}
              </div>
              {leads && leads.length > 0 && leads.length > leadsWithEmail.length && (
                <p className="text-xs text-amber-600 mt-1">
                  {leads.length - leadsWithEmail.length} lead(s) don&apos;t have email addresses
                </p>
              )}
            </div>

            {/* Recipient Selection Dropdown/Box (if no leads passed by parent) */}
            {(!leads || leads.length === 0) && (
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Select Leads</Label>
                <Input
                  placeholder="Search leads by name or email..."
                  value={leadSearchQuery}
                  onChange={(e) => setLeadSearchQuery(e.target.value)}
                  className="h-8 text-sm"
                />
                <div className="border rounded-md p-2 max-h-40 overflow-y-auto space-y-1.5 bg-background">
                  {allLeads
                    .filter((lead) => 
                      !leadSearchQuery ||
                      (lead.name || lead.fullName || '').toLowerCase().includes(leadSearchQuery.toLowerCase()) ||
                      (lead.email || '').toLowerCase().includes(leadSearchQuery.toLowerCase())
                    )
                    .map((lead) => {
                      const isSelected = localSelectedLeads.some((l) => l.id === lead.id);
                      return (
                        <div key={lead.id} className="flex items-center gap-2 text-sm hover:bg-muted/50 p-1 rounded">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={(e) => {
                              if (e.target.checked) {
                                setLocalSelectedLeads((prev) => [...prev, lead]);
                              } else {
                                setLocalSelectedLeads((prev) => prev.filter((l) => l.id !== lead.id));
                              }
                            }}
                            className="h-4 w-4 rounded border-border"
                          />
                          <span className="font-medium">{lead.name || lead.fullName}</span>
                          <span className="text-xs text-muted-foreground">({lead.email || 'no email'})</span>
                        </div>
                      );
                    })}
                  {allLeads.length === 0 && (
                    <p className="text-xs text-muted-foreground text-center py-2">No leads available</p>
                  )}
                </div>
              </div>
            )}

            {/* Template Selection */}
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Label>Use Template</Label>
                <Select value={selectedTemplateId} onValueChange={handleTemplateSelect}>
                  <SelectTrigger className="mt-2">
                    <SelectValue placeholder="Select a template" />
                  </SelectTrigger>
                  <SelectContent>
                    {templates.map((template) => (
                      <SelectItem key={template.id} value={template.id.toString()}>
                        {template.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button
                variant="outline"
                onClick={handleGenerateEmail}
                loading={isGenerating}
                loadingText="Generating..."
                disabled={isSending || generationLeads.length === 0}
              >
                <Sparkles className="w-4 h-4 mr-2" />
                AI Generate
              </Button>
            </div>

            {isGenerating && <Button type="button" variant="outline" onClick={() => cancelGeneration('Stopped waiting for email generation. Your draft has been kept.')}>Stop waiting</Button>}
            {generationError && <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-destructive">
              <p>{generationError}</p>
              {!isGenerating && <Button type="button" variant="outline" size="sm" onClick={handleGenerateEmail} disabled={isSending || generationLeads.length === 0}>Try again</Button>}
            </div>}

            {/* Subject */}
            <div>
              <Label htmlFor="subject">Subject</Label>
              <Input
                id="subject"
                placeholder="Quick question about {{company}}"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className="mt-2"
              />
            </div>

            {/* Template Variables */}
            <div>
              <Label>Template Variables</Label>
              <div className="mt-2 flex flex-wrap gap-2">
                {TEMPLATE_VARIABLES.map((variable) => (
                  <Button
                    key={variable.key}
                    variant="outline"
                    size="sm"
                    onClick={() => insertVariable(variable.key)}
                    title={`Example: ${variable.example}`}
                  >
                    {`{{${variable.key}}}`}
                  </Button>
                ))}
              </div>
            </div>

            {/* Body */}
            <div>
              <Label htmlFor="body">Email Body</Label>
              <Textarea
                id="body"
                placeholder="Hi {{first_name}},

I noticed you're the {{role}} at {{company}} and thought our solution could help with..."
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={10}
                className="mt-2 font-mono text-sm"
              />
            </div>

            <div className="rounded-lg border bg-muted/40 p-3">
              <p className="text-sm font-medium">Need automatic follow-ups?</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Use New Email Campaign from Outreach to build and schedule a multi-step sequence.
              </p>
            </div>

            {/* Action buttons */}
            <div className="flex gap-2">
              <Button variant="outline" onClick={generatePreview} className="flex-1">
                <Eye className="w-4 h-4 mr-2" />
                Preview
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="preview" className="space-y-4 mt-4">
            <div className="border rounded-lg overflow-hidden">
              {/* Email Header */}
              <div className="bg-muted p-4 border-b">
                <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
                  <span className="font-medium">To:</span>
                  {leadsWithEmail[0]?.email || 'recipient@example.com'}
                </div>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span className="font-medium">Subject:</span>
                  {leadsWithEmail[0]
                    ? renderTemplateVariableMap(subject, emailTemplateValues(leadsWithEmail[0])).content
                    : subject}
                </div>
              </div>
              {/* Email Body */}
              <div className="p-4 min-h-[200px] bg-background">
                <div
                  className="prose prose-sm max-w-none whitespace-pre-wrap"
                  dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(previewHtml || body) }}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground text-center">
              Preview uses data from the first selected lead
            </p>
          </TabsContent>

          <TabsContent value="results" className="space-y-4 mt-4">
            <div className="space-y-2 max-h-64 overflow-y-auto">
              {sendResults.map((result, index) => (
                <div
                  key={index}
                  className={`flex items-center justify-between p-3 rounded-lg ${
                    result.success ? 'bg-green-50 dark:bg-green-950/30' : 'bg-red-50 dark:bg-red-950/30'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    {result.success ? (
                      <CheckCircle2 className="w-5 h-5 text-green-600" />
                    ) : (
                      <XCircle className="w-5 h-5 text-red-600" />
                    )}
                    <span className="font-medium">{result.email}</span>
                  </div>
                  <span className={`text-sm ${result.success ? 'text-green-600' : 'text-red-600'}`}>
                    {result.success ? 'Sent' : result.error || 'Failed'}
                  </span>
                </div>
              ))}
            </div>
            <div className="flex justify-between pt-4 border-t">
              <div className="text-sm text-muted-foreground">
                Total: {sendResults.length} | Sent: {sendResults.filter((r) => r.success).length} |
                Failed: {sendResults.filter((r) => !r.success).length}
              </div>
            </div>
          </TabsContent>
        </Tabs>

        <DialogFooter className="mt-4">
          {unresolvedForSelectedLeads.length > 0 && (
            <p className="mr-auto text-xs text-destructive">
              Resolve {unresolvedForSelectedLeads.map((token) => `{{${token}}}`).join(', ')} before sending.
            </p>
          )}
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Close
          </Button>
          {activeTab !== 'results' && (
            <Button
              onClick={handleSendEmails}
              loading={isSending}
              loadingText="Sending..."
              disabled={leadsWithEmail.length === 0 || !subject.trim() || !body.trim() || unresolvedForSelectedLeads.length > 0}
            >
              <Send className="w-4 h-4 mr-2" />
              Send to {leadsWithEmail.length} Lead{leadsWithEmail.length !== 1 ? 's' : ''}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
