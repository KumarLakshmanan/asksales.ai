/**
 * Instagram DM Modal Component
 * Allows sending Instagram direct messages to leads
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
import { Callout } from '@/components/ui/callout';
import { Spinner } from '@/components/ui/spinner';
import { LoadingState } from '@/components/ui/loading-state';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import api from '@/lib/api';
import { Instagram, Send, Settings2, User, CheckCircle2, XCircle } from 'lucide-react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface Lead {
  id: number;
  name?: string;
  fullName?: string;
  firstName?: string;
  lastName?: string;
  company?: string;
  companyName?: string;
  role?: string;
  instagramHandle?: string;
  instagram?: string;
  socialHandle?: string;
}

interface InstagramDMModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leads: Lead[];
  onSuccess?: () => void;
  initialMessage?: string;
}

export function InstagramDMModal({
  open,
  onOpenChange,
  leads,
  onSuccess,
  initialMessage = '',
}: InstagramDMModalProps) {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState('compose');
  const [message, setMessage] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [_isConfiguring, _setIsConfiguring] = useState(false);
  const [credentialsConfigured, setCredentialsConfigured] = useState(false);
  const [statusLoading, setStatusLoading] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [instagramUsername, setInstagramUsername] = useState('');
  const [sendResults, setSendResults] = useState<Array<{ username: string; success: boolean; error?: string }>>([]);
  const [allLeads, setAllLeads] = useState<Lead[]>([]);
  const [leadsLoading, setLeadsLoading] = useState(false);
  const [leadsError, setLeadsError] = useState<string | null>(null);
  const [leadSearchQuery, setLeadSearchQuery] = useState('');
  const [localSelectedLeads, setLocalSelectedLeads] = useState<Lead[]>([]);
  const sendKeyRef = useRef(crypto.randomUUID());

  // Template variables
  const TEMPLATE_VARIABLES = [
    { key: 'first_name', label: 'First Name', example: 'John' },
    { key: 'last_name', label: 'Last Name', example: 'Doe' },
    { key: 'full_name', label: 'Full Name', example: 'John Doe' },
    { key: 'company', label: 'Company', example: 'Acme Inc' },
    { key: 'role', label: 'Role', example: 'Marketing Manager' },
  ];

  // Check if Instagram is configured on mount
  useEffect(() => {
    if (open) {
      checkInstagramStatus();
      if (initialMessage) {
        setMessage(initialMessage);
      }
      setLocalSelectedLeads(leads || []);
      if (!leads || leads.length === 0) {
        fetchLeads();
      }
    }
  }, [open, initialMessage, leads]);

  const fetchLeads = async () => {
    setLeadsLoading(true);
    setLeadsError(null);
    try {
      const response = await api.get<{ data?: Lead[] }>('/api/leads?pageSize=100');
      setAllLeads(response.data || []);
    } catch (error) {
      setLeadsError(error instanceof Error ? error.message : 'Leads could not be loaded.');
    } finally {
      setLeadsLoading(false);
    }
  };

  const checkInstagramStatus = async () => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      const response = await api.get<{ officialApi?: { connected: boolean; username?: string } }>('/api/instagram/oauth/status');
      setCredentialsConfigured(Boolean(response.officialApi?.connected));
      if (response.officialApi?.username) {
        setInstagramUsername(response.officialApi.username);
      }
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : 'Instagram status could not be checked.');
    } finally {
      setStatusLoading(false);
    }
  };

  const handleSendDMs = async () => {
    if (!message.trim()) {
      toast({
        title: 'Error',
        description: 'Please enter a message',
        variant: 'destructive',
      });
      return;
    }

    const activeLeads = leads && leads.length > 0 ? leads : localSelectedLeads;
    // Filter leads with Instagram handles
    const leadsWithInstagram = activeLeads.filter(
      (lead) => lead.instagramHandle || lead.instagram || lead.socialHandle
    );

    if (leadsWithInstagram.length === 0) {
      toast({
        title: 'Error',
        description: 'No leads have Instagram handles',
        variant: 'destructive',
      });
      return;
    }

    setIsSending(true);
    setSendResults([]);

    try {
      const response = await api.post<{
        success: boolean;
        inProgress?: boolean;
        message?: string;
        results?: Array<{ username: string; success: boolean; error?: string }>;
        summary?: { total: number; sent: number; failed: number };
        error?: string;
      }>('/api/instagram/dm/bulk', {
        leads: leadsWithInstagram.map((lead) => ({
          id: lead.id,
          firstName: lead.firstName || lead.name?.split(' ')[0],
          lastName: lead.lastName || lead.name?.split(' ').slice(1).join(' '),
          fullName: lead.fullName || lead.name,
          company: lead.company || lead.companyName,
          role: lead.role,
          instagramHandle: lead.instagramHandle || lead.instagram || lead.socialHandle,
        })),
        message,
        personalize: true,
        idempotencyKey: sendKeyRef.current,
      });

      if (response.inProgress) {
        toast({ title: 'Send already in progress', description: response.message });
      } else if (response.success && response.results && response.summary) {
        setSendResults(response.results);
        setActiveTab('results');
        toast({
          title: 'Messages Sent',
          description: `${response.summary.sent} of ${response.summary.total} messages sent successfully`,
        });
        if (onSuccess) {
          onSuccess();
        }
        sendKeyRef.current = crypto.randomUUID();
      } else {
        toast({
          title: 'Error',
          description: response.error || 'Failed to send messages',
          variant: 'destructive',
        });
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to send messages';
      toast({
        title: 'Error',
        description: errorMessage,
        variant: 'destructive',
      });
    } finally {
      setIsSending(false);
    }
  };

  const insertVariable = (variable: string) => {
    setMessage((prev) => prev + `{{${variable}}}`);
  };

  const activeLeads = leads && leads.length > 0 ? leads : localSelectedLeads;
  // Get leads with Instagram handles
  const leadsWithInstagram = activeLeads.filter(
    (lead) => lead.instagramHandle || lead.instagram || lead.socialHandle
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Instagram className="w-5 h-5 text-violet-500" />
            Send Instagram DMs
          </DialogTitle>
          <DialogDescription>
            Send personalized direct messages to selected leads via Instagram
          </DialogDescription>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="compose">Compose</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
            <TabsTrigger value="results" disabled={sendResults.length === 0}>
              Results
            </TabsTrigger>
          </TabsList>

          <TabsContent value="compose" className="space-y-4 mt-4">
            {statusLoading ? (
              <LoadingState className="py-10" label="Checking Instagram connection…" showLabel />
            ) : statusError ? (
              <Callout
                tone="danger"
                title="Instagram status could not be checked"
                actions={<Button variant="outline" size="sm" onClick={() => void checkInstagramStatus()}>Try again</Button>}
              >
                {statusError}
              </Callout>
            ) : !credentialsConfigured ? (
              <div className="text-center py-8 space-y-4">
                <Settings2 className="w-12 h-12 mx-auto text-muted-foreground/60" />
                <div>
                  <h3 className="font-medium text-foreground">Configure Instagram First</h3>
                  <p className="text-sm text-muted-foreground mt-1">
                    Please connect your Instagram account in Settings tab
                  </p>
                </div>
                <Button variant="outline" onClick={() => setActiveTab('settings')}>
                  <Settings2 className="w-4 h-4 mr-2" />
                  Configure Instagram
                </Button>
              </div>
            ) : (
              <>
                {/* Recipients */}
                <div>
                  <Label>Recipients ({leadsWithInstagram.length})</Label>
                  <div className="mt-2 flex flex-wrap gap-2 max-h-24 overflow-y-auto p-2 border rounded-md bg-muted/50">
                    {leadsWithInstagram.length > 0 ? (
                      leadsWithInstagram.map((lead) => (
                        <Badge key={lead.id} variant="secondary" className="flex items-center gap-1">
                          <User className="w-3 h-3" />@
                          {lead.instagramHandle || lead.instagram || lead.socialHandle}
                        </Badge>
                      ))
                    ) : (
                      <span className="text-sm text-muted-foreground">
                        No leads with Instagram handles selected
                      </span>
                    )}
                  </div>
                  {activeLeads.length > leadsWithInstagram.length && (
                    <p className="text-xs text-amber-600 mt-1">
                      {activeLeads.length - leadsWithInstagram.length} lead(s) don&apos;t have Instagram handles
                    </p>
                  )}
                </div>

                {/* Recipient Selection Dropdown/Box (if no leads passed by parent) */}
                {(!leads || leads.length === 0) && (
                  <div className="space-y-2">
                    <Label className="text-xs text-muted-foreground">Select Leads</Label>
                    <Input
                      placeholder="Search leads by name or Instagram handle..."
                      value={leadSearchQuery}
                      onChange={(e) => setLeadSearchQuery(e.target.value)}
                      className="h-8 text-sm"
                    />
                    <div className="border rounded-md p-2 max-h-40 overflow-y-auto space-y-1.5 bg-background">
                      {leadsLoading && (
                        <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground" role="status">
                          <Spinner size="sm" label={null} /> Loading leads…
                        </div>
                      )}
                      {leadsError && !leadsLoading && (
                        <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-center">
                          <p className="text-xs text-destructive">{leadsError}</p>
                          <Button variant="ghost" size="sm" className="mt-1 h-7" onClick={() => void fetchLeads()}>
                            Try again
                          </Button>
                        </div>
                      )}
                      {allLeads
                        .filter((lead) => 
                          !leadSearchQuery ||
                          (lead.name || lead.fullName || '').toLowerCase().includes(leadSearchQuery.toLowerCase()) ||
                          (lead.instagramHandle || lead.instagram || lead.socialHandle || '').toLowerCase().includes(leadSearchQuery.toLowerCase())
                        )
                        .map((lead) => {
                          const isSelected = localSelectedLeads.some((l) => l.id === lead.id);
                          const handle = lead.instagramHandle || lead.instagram || lead.socialHandle;
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
                              <span className="text-xs text-muted-foreground">({handle ? `@${handle}` : 'no Instagram handle'})</span>
                            </div>
                          );
                        })}
                      {!leadsLoading && !leadsError && allLeads.length === 0 && (
                        <p className="text-xs text-muted-foreground text-center py-2">No leads available</p>
                      )}
                    </div>
                  </div>
                )}

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

                {/* Message */}
                <div>
                  <Label htmlFor="message">Message</Label>
                  <Textarea
                    id="message"
                    placeholder="Hey {{first_name}}! I noticed you work at {{company}} and thought we could connect..."
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    rows={6}
                    className="mt-2"
                  />
                  <p className="text-xs text-muted-foreground mt-1">
                    Use personalization tokens to customize each message
                  </p>
                </div>
              </>
            )}
          </TabsContent>

          <TabsContent value="settings" className="space-y-4 mt-4">
            <div className="space-y-4">
              {statusLoading ? (
                <LoadingState className="py-8" label="Checking connection…" showLabel />
              ) : statusError ? (
                <Callout
                  tone="danger"
                  title="Instagram status could not be checked"
                  actions={<Button variant="outline" size="sm" onClick={() => void checkInstagramStatus()}>Try again</Button>}
                >
                  {statusError}
                </Callout>
              ) : credentialsConfigured ? (
                <div className="flex items-center gap-2 p-3 bg-green-50 dark:bg-green-950/30 text-green-700 dark:text-green-300 rounded-lg">
                  <CheckCircle2 className="w-5 h-5" />
                  <span className="text-sm">Instagram connected as @{instagramUsername}</span>
                </div>
              ) : (
                <div className="text-center py-8 space-y-4">
                  <Instagram className="w-12 h-12 mx-auto text-violet-400" />
                  <div>
                    <h3 className="font-medium text-foreground">Connect Instagram via OAuth</h3>
                    <p className="text-sm text-muted-foreground mt-1">
                      Go to the Integrations page and use the &quot;Connect Instagram&quot; button to connect your account securely via OAuth.
                    </p>
                  </div>
                </div>
              )}

              <Callout tone="warning" title="Important Notes" className="mt-4">
                <ul className="space-y-1">
                  <li>• Send messages sparingly to avoid account restrictions</li>
                  <li>• Wait 5+ seconds between messages to avoid spam detection</li>
                </ul>
              </Callout>
            </div>
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
                    <span className="font-medium">@{result.username}</span>
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
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          {activeTab === 'compose' && credentialsConfigured && (
            <Button
              onClick={handleSendDMs}
              loading={isSending}
              loadingText="Sending..."
              disabled={leadsWithInstagram.length === 0 || !message.trim()}
            >
              <Send className="w-4 h-4 mr-2" />
              Send to {leadsWithInstagram.length} Lead{leadsWithInstagram.length !== 1 ? 's' : ''}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
