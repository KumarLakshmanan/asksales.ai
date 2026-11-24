/**
 * Send SMS Modal Component
 * Allows sending SMS messages to leads using Twilio/MSG91 gateway
 */

import { useState, useEffect } from 'react';
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
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import api from '@/lib/api';
import { MessageSquare, Send, User, CheckCircle2, XCircle } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { renderTemplateVariableMap } from '@/utils/templateVariables';

interface Lead {
  id: number;
  name?: string;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  companyName?: string;
  role?: string;
  phone?: string;
}

interface SendSMSModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leads: Lead[];
  onSuccess?: () => void;
  initialMessage?: string;
  threadId?: number;
}

function smsTemplateValues(lead: Lead) {
  const fullName = lead.fullName || lead.name || `${lead.firstName || ''} ${lead.lastName || ''}`.trim();
  return {
    first_name: lead.firstName || fullName.split(' ')[0],
    last_name: lead.lastName || fullName.split(' ').slice(1).join(' '),
    full_name: fullName,
    company_name: lead.companyName || lead.company,
    job_title: lead.role,
  };
}

export function SendSMSModal({
  open,
  onOpenChange,
  leads,
  onSuccess,
  initialMessage = '',
  threadId,
}: SendSMSModalProps) {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState('compose');
  const [message, setMessage] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [allLeads, setAllLeads] = useState<Lead[]>([]);
  const [leadSearchQuery, setLeadSearchQuery] = useState('');
  const [localSelectedLeads, setLocalSelectedLeads] = useState<Lead[]>([]);
  const [sendResults, setSendResults] = useState<
    Array<{ phone: string; name: string; success: boolean; error?: string }>
  >([]);

  // Template variables
  const TEMPLATE_VARIABLES = [
    { key: 'first_name', label: 'First Name', example: 'John' },
    { key: 'last_name', label: 'Last Name', example: 'Doe' },
    { key: 'full_name', label: 'Full Name', example: 'John Doe' },
    { key: 'company_name', label: 'Company', example: 'Acme Inc' },
    { key: 'job_title', label: 'Role', example: 'Marketing Manager' },
  ];

  useEffect(() => {
    if (open) {
      if (initialMessage) {
        setMessage(initialMessage);
      }
      setLocalSelectedLeads(leads);
      if (leads.length === 0) {
        fetchLeads();
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialMessage, leads]);

  const fetchLeads = async () => {
    try {
      const url = threadId ? `/api/leads/thread/${threadId}` : '/api/leads';
      const response = await api.get<Lead[]>(url);
      if (Array.isArray(response)) {
        setAllLeads(response);
      }
    } catch (error) {
      console.error('Failed to fetch leads:', error);
    }
  };

  const insertVariable = (variable: string) => {
    setMessage((prev) => prev + `{{${variable}}}`);
  };

  const handleSendSMS = async () => {
    if (!message.trim()) {
      toast({
        title: 'Error',
        description: 'Please enter a message',
        variant: 'destructive',
      });
      return;
    }

    const leadsWithPhone = (leads && leads.length > 0 ? leads : localSelectedLeads).filter((lead) => lead.phone);

    if (leadsWithPhone.length === 0) {
      toast({
        title: 'Error',
        description: 'No leads with phone numbers selected',
        variant: 'destructive',
      });
      return;
    }

    const unresolved = new Set<string>();
    leadsWithPhone.forEach((lead) => {
      renderTemplateVariableMap(message, smsTemplateValues(lead)).unresolved.forEach((token) => unresolved.add(token));
    });
    if (unresolved.size > 0) {
      toast({
        title: 'Resolve template variables',
        description: `Missing recipient data for ${[...unresolved].map((token) => `{{${token}}}`).join(', ')}. No messages were sent.`,
        variant: 'destructive',
      });
      return;
    }

    setIsSending(true);
    const results: typeof sendResults = [];

    // Send messages sequentially
    for (const lead of leadsWithPhone) {
      const leadName = lead.fullName || lead.name || `${lead.firstName || ''} ${lead.lastName || ''}`.trim() || 'Lead';
      const leadPhone = lead.phone || '';
      
      // Personalize message for this lead
      const personalizedMsg = renderTemplateVariableMap(message, smsTemplateValues(lead)).content;

      try {
        const response = await api.post<{ success: boolean; error?: string }>('/api/outreach/send', {
          leadId: lead.id,
          leadName,
          channel: 'sms',
          message: personalizedMsg,
        });

        results.push({
          phone: leadPhone,
          name: leadName,
          success: response.success,
          error: response.error,
        });
      } catch (err) {
        results.push({
          phone: leadPhone,
          name: leadName,
          success: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    }

    setSendResults(results);
    setActiveTab('results');
    setIsSending(false);

    const successfulCount = results.filter((r) => r.success).length;
    toast({
      title: 'SMS Campaign Completed',
      description: `Sent ${successfulCount} of ${results.length} messages successfully`,
    });

    if (onSuccess && successfulCount > 0) {
      onSuccess();
    }
  };

  const leadsWithPhone = (leads && leads.length > 0 ? leads : localSelectedLeads).filter((lead) => lead.phone);
  const unresolvedForSelectedLeads = [...new Set(leadsWithPhone.flatMap((lead) => (
    renderTemplateVariableMap(message, smsTemplateValues(lead)).unresolved
  )))];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquare className="w-5 h-5 text-green-500" />
            Send SMS Outreach
          </DialogTitle>
          <DialogDescription>
            Send personalized text messages to your leads.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="compose">Compose</TabsTrigger>
            <TabsTrigger value="results" disabled={sendResults.length === 0}>
              Results
            </TabsTrigger>
          </TabsList>

          <TabsContent value="compose" className="space-y-4 mt-4">
            {/* Recipients */}
            <div>
              <Label>Recipients ({leadsWithPhone.length})</Label>
              <div className="mt-2 flex flex-wrap gap-2 max-h-24 overflow-y-auto p-2 border rounded-md bg-muted/50">
                {leadsWithPhone.length > 0 ? (
                  leadsWithPhone.map((lead) => (
                    <Badge key={lead.id} variant="secondary" className="flex items-center gap-1">
                      <User className="w-3 h-3" />
                      {lead.name || lead.fullName} ({lead.phone})
                    </Badge>
                  ))
                ) : (
                  <span className="text-sm text-muted-foreground">No leads with phone numbers selected</span>
                )}
              </div>
              {leads && leads.length > 0 && leads.length > leadsWithPhone.length && (
                <p className="text-xs text-amber-600 mt-1">
                  {leads.length - leadsWithPhone.length} lead(s) don&apos;t have phone numbers
                </p>
              )}
            </div>

            {/* Recipient Selection Dropdown/Box (if no leads passed by parent) */}
            {(!leads || leads.length === 0) && (
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Select Leads</Label>
                <Input
                  placeholder="Search leads by name or phone..."
                  value={leadSearchQuery}
                  onChange={(e) => setLeadSearchQuery(e.target.value)}
                  className="h-8 text-sm"
                />
                <div className="border rounded-md p-2 max-h-40 overflow-y-auto space-y-1.5 bg-background">
                  {allLeads
                    .filter((lead) => 
                      !leadSearchQuery ||
                      (lead.name || lead.fullName || '').toLowerCase().includes(leadSearchQuery.toLowerCase()) ||
                      (lead.phone || '').toLowerCase().includes(leadSearchQuery.toLowerCase())
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
                          <span className="text-xs text-muted-foreground">({lead.phone || 'no phone'})</span>
                        </div>
                      );
                    })}
                  {allLeads.length === 0 && (
                    <p className="text-xs text-muted-foreground text-center py-2">No leads available</p>
                  )}
                </div>
              </div>
            )}

            {/* SMS Body */}
            <div className="space-y-2">
              <Label htmlFor="sms-message">Message</Label>
              <Textarea
                id="sms-message"
                placeholder="Type your message here..."
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                className="min-h-[120px] text-sm"
              />
            </div>

            {/* Template Variables */}
            <div>
              <Label className="text-xs text-muted-foreground">Insert Variables</Label>
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {TEMPLATE_VARIABLES.map((variable) => (
                  <Button
                    key={variable.key}
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs border-dashed"
                    onClick={() => insertVariable(variable.key)}
                  >
                    +{variable.label}
                  </Button>
                ))}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="results" className="space-y-3 mt-4">
            <div className="space-y-2 max-h-[300px] overflow-y-auto">
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
                    <div>
                      <span className="font-medium text-sm block">{result.name}</span>
                      <span className="text-xs text-muted-foreground">{result.phone}</span>
                    </div>
                  </div>
                  <span className={`text-sm ${result.success ? 'text-green-600' : 'text-red-600'}`}>
                    {result.success ? 'Sent' : result.error || 'Failed'}
                  </span>
                </div>
              ))}
            </div>
            <div className="flex justify-between pt-4 border-t text-sm text-muted-foreground">
              <div>
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
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {activeTab !== 'results' && (
            <Button
              onClick={handleSendSMS}
              loading={isSending}
              loadingText="Sending..."
              disabled={leadsWithPhone.length === 0 || !message.trim() || unresolvedForSelectedLeads.length > 0}
            >
              <Send className="w-4 h-4 mr-2" />
              Send SMS to {leadsWithPhone.length} Lead{leadsWithPhone.length !== 1 ? 's' : ''}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
