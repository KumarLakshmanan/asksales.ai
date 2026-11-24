"use client";

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { LoadingState } from '@/components/ui/loading-state';
import { Mail, MessageSquare, Send, ArrowRight, Check } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { api } from '@/lib/api';
import LeadFileUpload from './LeadFileUpload';
import CampaignDeliveryReview from './outreach/CampaignDeliveryReview';

// API Response types
interface SequenceStep {
  subject?: string;
  body?: string;
  message?: string;
  delay_days?: number;
  [key: string]: unknown;
}

interface Sequence {
  id: number;
  steps?: SequenceStep[];
  [key: string]: unknown;
}

interface EmailSequenceResponse {
  sequence_id: number;
  email_sequence: { emails?: Array<SequenceStep & { day?: number }> };
}

interface SmsSequenceResponse {
  sequence_id: number;
  sms_sequence: { messages?: Array<SequenceStep & { day?: number }> };
}

interface Campaign {
  id: number;
  campaign_name?: string;
  campaign_type?: string;
  leads?: unknown[];
  status?: string;
  [key: string]: unknown;
}

interface CampaignResponse {
  campaign?: Campaign;
}

interface OutreachCampaignBuilderProps {
  icpId: number;
  onCampaignCreated?: (campaign: Campaign) => void;
}

export default function OutreachCampaignBuilder({ 
  icpId, 
  onCampaignCreated 
}: OutreachCampaignBuilderProps) {
  const { toast } = useToast();
  const [currentStep, setCurrentStep] = useState(1);
  const [loading, setLoading] = useState(false);

  // Campaign Data
  const [campaignName, setCampaignName] = useState('');
  const [campaignType, setCampaignType] = useState<'email' | 'sms' | 'both'>('email');
  const [autoReply, setAutoReply] = useState(false);
  const [leads, setLeads] = useState<unknown[]>([]);
  const [generatedSequence, setGeneratedSequence] = useState<Sequence | { email: Sequence; sms: Sequence } | null>(null);
  const [sequenceIds, setSequenceIds] = useState<{ email?: number; sms?: number }>({});
  const [createdCampaign, setCreatedCampaign] = useState<Campaign | null>(null);

  const handleLeadsUploaded = (uploadedLeads: unknown[]) => {
    setLeads(uploadedLeads);
    toast({
      title: 'Leads Loaded',
      description: `${uploadedLeads.length} leads ready for campaign`,
    });
  };

  const handleGenerateSequence = async () => {
    if (leads.length === 0) {
      toast({
        title: 'No Leads',
        description: 'Please upload leads before generating workflow',
        variant: 'destructive',
      });
      return;
    }

    setLoading(true);
    try {
      const leadSample = leads.slice(0, 5);
      const generateEmail = () => api.post<EmailSequenceResponse>('/api/outreach/sequences/email', {
        icp_id: icpId,
        leads: leadSample,
        total_emails: 5,
      });
      const generateSms = () => api.post<SmsSequenceResponse>('/api/outreach/sequences/sms', {
        icp_id: icpId,
        leads: leadSample,
        total_messages: 3,
      });

      if (campaignType === 'both') {
        const [emailData, smsData] = await Promise.all([generateEmail(), generateSms()]);
        const email: Sequence = {
          id: emailData.sequence_id,
          steps: (emailData.email_sequence.emails ?? []).map((step) => ({ ...step, delay_days: step.day ?? step.delay_days })),
        };
        const sms: Sequence = {
          id: smsData.sequence_id,
          steps: (smsData.sms_sequence.messages ?? []).map((step) => ({ ...step, delay_days: step.day ?? step.delay_days })),
        };
        setGeneratedSequence({ email, sms });
        setSequenceIds({ email: email.id, sms: sms.id });
      } else if (campaignType === 'email') {
        const emailData = await generateEmail();
        const email: Sequence = {
          id: emailData.sequence_id,
          steps: (emailData.email_sequence.emails ?? []).map((step) => ({ ...step, delay_days: step.day ?? step.delay_days })),
        };
        setGeneratedSequence(email);
        setSequenceIds({ email: email.id });
      } else {
        const smsData = await generateSms();
        const sms: Sequence = {
          id: smsData.sequence_id,
          steps: (smsData.sms_sequence.messages ?? []).map((step) => ({ ...step, delay_days: step.day ?? step.delay_days })),
        };
        setGeneratedSequence(sms);
        setSequenceIds({ sms: sms.id });
      }

      toast({
        title: 'Campaign Workflow Generated!',
        description: 'Your outreach process is ready for review',
      });
    } catch (error: unknown) {
      toast({
        title: 'Generation Failed',
        description: (error as Error)?.message || 'Failed to generate workflow',
        variant: 'destructive',
      });
    } finally {
      setLoading(false);
    }
  };

  const handleCreateCampaign = async () => {
    if (!campaignName.trim()) {
      toast({
        title: 'Campaign Name Required',
        description: 'Please provide a name for your campaign',
        variant: 'destructive',
      });
      return false;
    }

    setLoading(true);
    try {
      const data = await api.post<CampaignResponse>('/api/outreach/campaigns', {
        icp_id: icpId,
        campaign_name: campaignName,
        campaign_type: campaignType,
        auto_reply: campaignType !== 'sms' && autoReply,
        leads: leads,
        sequence_id: campaignType === 'email' ? sequenceIds.email : campaignType === 'sms' ? sequenceIds.sms : undefined,
        sequence_ids: campaignType === 'both' ? sequenceIds : undefined,
      });
      if (!data.campaign) throw new Error('The server did not return the created campaign');
      setCreatedCampaign(data.campaign);

      toast({
        title: 'Campaign Created!',
        description: 'Your outreach campaign is ready to schedule',
      });
      return true;
    } catch (error: unknown) {
      toast({
        title: 'Creation Failed',
        description: (error as Error)?.message || 'Failed to create campaign',
        variant: 'destructive',
      });
      return false;
    } finally {
      setLoading(false);
    }
  };

  const renderStepIndicator = () => (
    <div className="flex items-center justify-between mb-6">
      {[1, 2, 3, 4, 5, 6].map((step) => (
        <div key={step} className="flex items-center">
          <div
            className={`
              flex items-center justify-center w-8 h-8 rounded-full border-2 
              ${currentStep >= step 
                ? 'bg-primary text-primary-foreground border-primary' 
                : 'bg-background text-muted-foreground border-muted'
              }
            `}
          >
            {currentStep > step ? <Check className="h-4 w-4" /> : step}
          </div>
          {step < 6 && (
            <div
              className={`
                h-0.5 w-8 mx-1
                ${currentStep > step ? 'bg-primary' : 'bg-muted'}
              `}
            />
          )}
        </div>
      ))}
    </div>
  );

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Send className="h-5 w-5" />
          Outreach Campaign Builder
        </CardTitle>
        <CardDescription>
          Create and schedule automated email and SMS follow-ups
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {renderStepIndicator()}

        {/* Step 1: Upload Leads */}
        {currentStep === 1 && (
          <div className="space-y-4">
            <div>
              <h3 className="text-lg font-semibold mb-2">Step 1: Upload Leads</h3>
              <p className="text-sm text-muted-foreground mb-4">
                Upload a CSV or Excel file with your lead data
              </p>
            </div>
            
            <LeadFileUpload onUploadComplete={handleLeadsUploaded} />

            {leads.length > 0 && (
              <Button
                onClick={() => setCurrentStep(2)}
                className="w-full"
              >
                Continue to Campaign Config
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            )}
          </div>
        )}

        {/* Step 2: Campaign Config */}
        {currentStep === 2 && (
          <div className="space-y-4">
            <div>
              <h3 className="text-lg font-semibold mb-2">Step 2: Campaign Settings</h3>
              <p className="text-sm text-muted-foreground mb-4">
                Configure your campaign settings
              </p>
            </div>

            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="campaign-name">Campaign Name</Label>
                <Input
                  id="campaign-name"
                  value={campaignName}
                  onChange={(e) => setCampaignName(e.target.value)}
                  placeholder="e.g., Q1 Outbound Campaign"
                />
              </div>

              <div className="space-y-2">
                <Label>Campaign Type</Label>
                <RadioGroup value={campaignType} onValueChange={(v: string) => setCampaignType(v as 'email' | 'sms' | 'both')}>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="email" id="email" />
                    <Label htmlFor="email" className="font-normal cursor-pointer">
                      <Mail className="inline h-4 w-4 mr-2" />
                      Email Only
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="sms" id="sms" />
                    <Label htmlFor="sms" className="font-normal cursor-pointer">
                      <MessageSquare className="inline h-4 w-4 mr-2" />
                      SMS Only
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="both" id="both" />
                    <Label htmlFor="both" className="font-normal cursor-pointer">
                      <Mail className="inline h-4 w-4 mr-2" />
                      <MessageSquare className="inline h-4 w-4 mr-2" />
                      Email + SMS
                    </Label>
                  </div>
                </RadioGroup>
              </div>

              {campaignType !== 'sms' ? <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" checked={autoReply} onChange={event => setAutoReply(event.target.checked)} />
                <span>Automatically reply to eligible campaign emails. Replies that need review stay as drafts.</span>
              </label> : null}

              <div className="p-3 bg-secondary rounded-lg">
                <p className="text-sm font-medium">Leads: {leads.length}</p>
                <p className="text-xs text-muted-foreground">
                  Campaign will target all uploaded leads
                </p>
              </div>
            </div>

            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => setCurrentStep(1)}
                className="flex-1"
              >
                Back
              </Button>
              <Button
                onClick={() => setCurrentStep(3)}
                className="flex-1"
                disabled={!campaignName.trim()}
              >
                Continue to Follow-ups
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          </div>
        )}

        {/* Step 3: Generate Sequence */}
        {currentStep === 3 && (
          <div className="space-y-4">
            <div>
              <h3 className="text-lg font-semibold mb-2">Step 3: Generate Campaign Workflow</h3>
              <p className="text-sm text-muted-foreground mb-4">
                AI will generate personalized {campaignType === 'both' ? 'email and SMS' : campaignType} follow-ups
              </p>
            </div>

            <div className="p-4 bg-secondary rounded-lg space-y-2">
              <p className="text-sm font-medium">Follow-up Details:</p>
              <ul className="text-sm text-muted-foreground space-y-1">
                {(campaignType === 'email' || campaignType === 'both') && (
                  <li>• 5-email automated follow-up over 18 days</li>
                )}
                {(campaignType === 'sms' || campaignType === 'both') && (
                  <li>• 3-message SMS follow-up with compliance</li>
                )}
                <li>• Personalized for each lead</li>
                <li>• Optimized sending schedule</li>
              </ul>
            </div>

            <Button
              onClick={handleGenerateSequence}
              loading={loading}
              loadingText="Generating Workflow..."
              className="w-full"
            >
              Generate Workflow
            </Button>

            {generatedSequence && (
              <Button
                onClick={() => setCurrentStep(4)}
                className="w-full"
                variant="default"
              >
                Preview Workflow
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            )}

            <Button
              variant="outline"
              onClick={() => setCurrentStep(2)}
              className="w-full"
            >
              Back
            </Button>
          </div>
        )}

        {/* Step 4: Preview Sequence */}
        {currentStep === 4 && generatedSequence && (
          <div className="space-y-4">
            <div>
              <h3 className="text-lg font-semibold mb-2">Step 4: Preview Workflow</h3>
              <p className="text-sm text-muted-foreground mb-4">
                Review your generated outreach workflow
              </p>
            </div>

            <Tabs defaultValue={campaignType === 'sms' ? 'sms' : 'email'}>
              {campaignType === 'both' && (
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="email">Email Follow-ups</TabsTrigger>
                  <TabsTrigger value="sms">SMS Follow-ups</TabsTrigger>
                </TabsList>
              )}

              <TabsContent value="email" className="space-y-3">
                <ScrollArea className="h-96 rounded-md border p-4">
                  {((generatedSequence as { steps?: SequenceStep[]; email?: { steps: SequenceStep[] } }).steps || (generatedSequence as { email?: { steps: SequenceStep[] } }).email?.steps || []).map((step: SequenceStep, idx: number) => (
                    <div key={idx} className="mb-4 p-3 border rounded-lg">
                      <div className="flex items-center justify-between mb-2">
                        <p className="font-medium">Email {idx + 1}</p>
                        <Badge variant="outline">Day {step.delay_days ?? 0}</Badge>
                      </div>
                      <p className="text-sm font-medium mb-1">{step.subject}</p>
                      <p className="text-xs text-muted-foreground">{step.body?.substring(0, 150)}...</p>
                    </div>
                  ))}
                </ScrollArea>
              </TabsContent>

              <TabsContent value="sms" className="space-y-3">
                <ScrollArea className="h-96 rounded-md border p-4">
                  {((generatedSequence as { sms?: { steps: SequenceStep[] } }).sms?.steps || []).map((step: SequenceStep, idx: number) => (
                    <div key={idx} className="mb-4 p-3 border rounded-lg">
                      <div className="flex items-center justify-between mb-2">
                        <p className="font-medium">SMS {idx + 1}</p>
                        <div className="flex items-center gap-2">
                          <Badge variant="outline">Day {step.delay_days ?? 0}</Badge>
                          <Badge variant="secondary">{step.message?.length || 0} chars</Badge>
                        </div>
                      </div>
                      <p className="text-sm">{step.message}</p>
                    </div>
                  ))}
                </ScrollArea>
              </TabsContent>
            </Tabs>

            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => setCurrentStep(3)}
                className="flex-1"
              >
                Back
              </Button>
              <Button
                onClick={() => {
                  void (async () => {
                    if (await handleCreateCampaign()) setCurrentStep(5);
                  })();
                }}
                className="flex-1"
              >
                Create Campaign
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          </div>
        )}

        {/* Step 5: Create Campaign */}
        {currentStep === 5 && (
          <div className="space-y-4">
            <div>
              <h3 className="text-lg font-semibold mb-2">Step 5: Campaign Created</h3>
              <p className="text-sm text-muted-foreground mb-4">
                Your campaign is ready to schedule
              </p>
            </div>

            {loading ? (
              <LoadingState className="p-8" label="Creating campaign…" />
            ) : createdCampaign ? (
              <>
                <div className="p-4 bg-secondary rounded-lg space-y-2">
                  <p className="font-medium">{createdCampaign.campaign_name}</p>
                  <div className="flex items-center gap-2">
                    <Badge>{createdCampaign.campaign_type}</Badge>
                    <Badge variant="outline">
                      {createdCampaign.leads?.length || leads.length} leads
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Status: {createdCampaign.status}
                  </p>
                </div>

                <Button
                  onClick={() => setCurrentStep(6)}
                  className="w-full"
                >
                  Review Delivery
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </>
            ) : null}
          </div>
        )}

        {/* Step 6: Review and schedule delivery */}
        {currentStep === 6 && createdCampaign && (
          <div className="space-y-4">
            <CampaignDeliveryReview campaignId={createdCampaign.id} onScheduled={onCampaignCreated} />
            <Button variant="outline" onClick={() => setCurrentStep(5)} className="w-full">Back</Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
