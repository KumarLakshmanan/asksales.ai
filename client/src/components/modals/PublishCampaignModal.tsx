import { useState, useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Slider } from '@/components/ui/slider';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import api from '@/lib/api';
import { normalizeUploadUrl } from '@/lib/utils';
import {
  buildAutonomousCampaignPayload,
  campaignPublishState,
  CAMPAIGN_STATE_COPY,
  type CampaignPublishResponse,
  type CampaignPublishState,
} from '@/lib/adCampaignPublishing';
import { Megaphone, Send, X, CircleDollarSign, Calendar, Users, Target, Globe, Info, Save } from 'lucide-react';

export interface AdItem {
  id: string;
  title: string;
  content: string;
  platform: string;
  imageUrl?: string;
  videoUrl?: string;
  sourceAssetId?: number;
  sourceVersion?: number;
  sourceUpdatedAt?: string;
}

interface PublishCampaignForm {
  selectedAds: string[];
  campaignName: string;
  // Platform selection
  publishPlatforms: ('meta' | 'google')[];
  // Budget settings
  budgetType: 'DAILY' | 'LIFETIME';
  dailyBudget: string;
  lifetimeBudget: string;
  currency: 'USD' | 'EUR' | 'GBP' | 'INR' | 'CAD' | 'AUD' | 'JPY' | 'BRL' | 'MXN' | 'SGD' | 'AED';
  bidStrategy: string;
  bidAmount: string;
  // Schedule
  startDate: string;
  endDate: string;
  // Targeting
  ageMin: number;
  ageMax: number;
  genders: string[];
  countries: string[];
  // Campaign settings
  objective: string;
  optimizationGoal: string;
  billingEvent: string;
  callToAction: string;
  placements: string[];
  specialAdCategories: string[];
  metaPixelId: string;
  metaCustomConversionId: string;
  metaApplicationId: string;
  metaObjectStoreUrl: string;
  googleBudgetMode: 'CAMPAIGN_TOTAL' | 'AVERAGE_DAILY';
  googleBiddingStrategy: string;
  googleKeywordMatchType: 'BROAD' | 'PHRASE' | 'EXACT';
  googleKeywords: string[];
  googleNegativeKeywords: string[];
  googleLanguageIds: string[];
  googleTrackingTemplate: string;
  googleFinalUrlSuffix: string;
  googlePath1: string;
  googlePath2: string;
  // Landing page
  linkUrl: string;
  allowAiPause: boolean;
  activationConfirmed: boolean;
}

interface PublishCampaignModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ads: AdItem[];
  icpId?: number;
  businessProfileId?: number;
  brandToolkitId?: number;
  threadId?: number;
  onPublishSuccess?: (campaignId?: string, state?: CampaignPublishState) => void;
}

const CAMPAIGN_OBJECTIVES = [
  { value: 'traffic', label: 'Traffic (Link Clicks)' },
  { value: 'sales', label: 'Sales (Conversions)' },
  { value: 'leads', label: 'Leads (Lead Generation)' },
  { value: 'engagement', label: 'Engagement' },
  { value: 'awareness', label: 'Awareness (Reach & Brand Awareness)' },
  { value: 'app_promotion', label: 'App Promotion' },
];

const OPTIMIZATION_GOALS = [
  { value: 'LINK_CLICKS', label: 'Link Clicks' },
  { value: 'LANDING_PAGE_VIEWS', label: 'Landing Page Views' },
  { value: 'IMPRESSIONS', label: 'Impressions' },
  { value: 'REACH', label: 'Reach' },
  { value: 'LEAD_GENERATION', label: 'Lead Generation' },
  { value: 'OFFSITE_CONVERSIONS', label: 'Offsite Conversions' },
];

const BILLING_EVENTS = [
  { value: 'IMPRESSIONS', label: 'Impressions (CPM)' },
  { value: 'LINK_CLICKS', label: 'Link Clicks (CPC)' },
];

const BID_STRATEGIES = [
  { value: 'LOWEST_COST_WITHOUT_CAP', label: 'Lowest Cost (Automatic)' },
  { value: 'COST_CAP', label: 'Cost Cap' },
  { value: 'BID_CAP', label: 'Bid Cap' },
];

const CALL_TO_ACTIONS = [
  { value: 'LEARN_MORE', label: 'Learn More' },
  { value: 'SHOP_NOW', label: 'Shop Now' },
  { value: 'SIGN_UP', label: 'Sign Up' },
  { value: 'DOWNLOAD', label: 'Download' },
  { value: 'CONTACT_US', label: 'Contact Us' },
  { value: 'GET_QUOTE', label: 'Get Quote' },
  { value: 'BOOK_TRAVEL', label: 'Book Now' },
  { value: 'SUBSCRIBE', label: 'Subscribe' },
  { value: 'GET_OFFER', label: 'Get Offer' },
  { value: 'APPLY_NOW', label: 'Apply Now' },
  { value: 'BUY_NOW', label: 'Buy Now' },
  { value: 'WATCH_MORE', label: 'Watch More' },
];

const COUNTRIES = [
  { value: 'US', label: 'United States' },
  { value: 'IN', label: 'India' },
  { value: 'GB', label: 'United Kingdom' },
  { value: 'CA', label: 'Canada' },
  { value: 'AU', label: 'Australia' },
  { value: 'DE', label: 'Germany' },
  { value: 'FR', label: 'France' },
];

const GOOGLE_GEO_TARGETS: Record<string, string> = {
  US: 'geoTargetConstants/2840', IN: 'geoTargetConstants/2356',
  GB: 'geoTargetConstants/2826', CA: 'geoTargetConstants/2124',
  AU: 'geoTargetConstants/2036', DE: 'geoTargetConstants/2276',
  FR: 'geoTargetConstants/2250',
};

export default function PublishCampaignModal({
  open,
  onOpenChange,
  ads,
  icpId,
  businessProfileId: selectedBusinessProfileId,
  brandToolkitId,
  threadId,
  onPublishSuccess,
}: PublishCampaignModalProps) {
  const { toast } = useToast();
  const [isPublishing, setIsPublishing] = useState(false);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [activeTab, setActiveTab] = useState('ads');
  const [locationInput, setLocationInput] = useState('');
  const [objectiveRationale, setObjectiveRationale] = useState('');
  const [objectiveInferred, setObjectiveInferred] = useState(false);
  const [conversationContext, setConversationContext] = useState('');
  const [prefillNotice, setPrefillNotice] = useState<string | null>(null);
  const [businessProfileId, setBusinessProfileId] = useState<number | undefined>();
  const [accountSnapshot, setAccountSnapshot] = useState<CampaignPublishResponse['accountSnapshot']>();
  const [adSettingLocations, setAdSettingLocations] = useState<Array<{
    countryCode: string;
    region?: string;
    city?: string;
    googleGeoTargetId?: string;
    metaLocationKey?: string;
  }>>([]);
  const [campaignRequestKey, setCampaignRequestKey] = useState(() =>
    `content-studio-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const [publishForm, setPublishForm] = useState<PublishCampaignForm>({
    selectedAds: [],
    campaignName: '',
    publishPlatforms: ['meta'],
    budgetType: 'LIFETIME',
    dailyBudget: '1000',
    lifetimeBudget: '100',
    currency: 'USD',
    bidStrategy: 'LOWEST_COST_WITHOUT_CAP',
    bidAmount: '',
    startDate: new Date().toISOString().split('T')[0],
    endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    ageMin: 18,
    ageMax: 65,
    genders: ['1', '2'],
    countries: ['IN'],
    objective: '',
    optimizationGoal: 'LINK_CLICKS',
    billingEvent: 'IMPRESSIONS',
    callToAction: 'LEARN_MORE',
    placements: [],
    specialAdCategories: [],
    metaPixelId: '',
    metaCustomConversionId: '',
    metaApplicationId: '',
    metaObjectStoreUrl: '',
    googleBudgetMode: 'CAMPAIGN_TOTAL',
    googleBiddingStrategy: 'MAXIMIZE_CONVERSIONS',
    googleKeywordMatchType: 'BROAD',
    googleKeywords: [],
    googleNegativeKeywords: [],
    googleLanguageIds: ['languageConstants/1000'],
    googleTrackingTemplate: '',
    googleFinalUrlSuffix: '',
    googlePath1: '',
    googlePath2: '',
    linkUrl: '',
    allowAiPause: false,
    activationConfirmed: false,
  });
  const [draftAds, setDraftAds] = useState<AdItem[]>(ads);
  
  // Track if form has been initialized to prevent re-initialization on re-renders
  const [formInitialized, setFormInitialized] = useState(false);

  // Reset form when modal opens (only on first open)
  useEffect(() => {
    if (open && !formInitialized) {
      setActiveTab('ads');
      setPrefillNotice(null);
      setFormInitialized(true);
      setDraftAds(ads);
      
      // Generate campaign name from first ad's headline
      let defaultCampaignName = 'My Ad Campaign';
      if (ads.length > 0) {
        try {
          const parsed = JSON.parse(ads[0].content);
          defaultCampaignName = parsed.headline || ads[0].title || 'My Ad Campaign';
        } catch {
          defaultCampaignName = ads[0].title || 'My Ad Campaign';
        }
        defaultCampaignName = `${defaultCampaignName} Campaign`;
      }

      // Get link URL from first ad's displayUrl if available
      let defaultLinkUrl = '';
      if (ads.length > 0) {
        try {
          const parsed = JSON.parse(ads[0].content);
          if (parsed.displayUrl) {
            defaultLinkUrl = parsed.displayUrl.startsWith('http') ? parsed.displayUrl : `https://${parsed.displayUrl}`;
          }
        } catch {
          // Ignore parsing errors for default URL extraction
        }
      }

      // Get CTA from first ad if available
      let defaultCta = 'LEARN_MORE';
      if (ads.length > 0) {
        try {
          const parsed = JSON.parse(ads[0].content);
          if (parsed.callToAction) {
            // Convert CTA text to Meta API format
            const ctaMap: Record<string, string> = {
              'Learn More': 'LEARN_MORE',
              'Shop Now': 'SHOP_NOW',
              'Sign Up': 'SIGN_UP',
              'Download': 'DOWNLOAD',
              'Contact Us': 'CONTACT_US',
              'Get Quote': 'GET_QUOTE',
              'Book Now': 'BOOK_TRAVEL',
            };
            defaultCta = ctaMap[parsed.callToAction] || parsed.callToAction.toUpperCase().replace(/\s+/g, '_');
          }
        } catch {
          // Ignore parsing errors for CTA extraction
        }
      }
      const defaultGoogleKeywords = Array.from(new Set(ads.flatMap((ad) => {
        try {
          const parsed = JSON.parse(ad.content) as { keywords?: unknown };
          return Array.isArray(parsed.keywords)
            ? parsed.keywords.map(String).map((keyword) => keyword.trim()).filter(Boolean)
            : [];
        } catch {
          return [];
        }
      })));

      setPublishForm({
        selectedAds: ads.map(ad => ad.id), // Pre-select all ads
        campaignName: defaultCampaignName,
        publishPlatforms: ['meta'],
        budgetType: 'LIFETIME',
        dailyBudget: '1000',
        lifetimeBudget: '100',
        currency: 'USD',
        bidStrategy: 'LOWEST_COST_WITHOUT_CAP',
        bidAmount: '',
        startDate: new Date().toISOString().split('T')[0],
        endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
        ageMin: 18,
        ageMax: 65,
        genders: ['1', '2'],
        countries: ['US'],
        objective: '',
        optimizationGoal: 'LINK_CLICKS',
        billingEvent: 'IMPRESSIONS',
        callToAction: defaultCta,
        placements: [],
        specialAdCategories: [],
        metaPixelId: '',
        metaCustomConversionId: '',
        metaApplicationId: '',
        metaObjectStoreUrl: '',
        googleBudgetMode: 'CAMPAIGN_TOTAL',
        googleBiddingStrategy: 'MAXIMIZE_CONVERSIONS',
        googleKeywordMatchType: 'BROAD',
        googleKeywords: defaultGoogleKeywords,
        googleNegativeKeywords: [],
        googleLanguageIds: ['languageConstants/1000'],
        googleTrackingTemplate: '',
        googleFinalUrlSuffix: '',
        googlePath1: '',
        googlePath2: '',
        linkUrl: defaultLinkUrl,
        allowAiPause: false,
        activationConfirmed: false,
      });

      const contentStudioContext = ads.map((ad) => `${ad.title}\n${ad.content}`).join('\n\n').slice(0, 100_000);
      const conversationRequest = threadId
        ? api.get<{ messages?: Array<{ role?: string; content?: string }> }>(
            `/api/chat/threads/${threadId}/messages?limit=50`,
          ).then((response) => (response.messages || [])
            .map((message) => `${message.role || 'participant'}: ${message.content || ''}`)
            .join('\n')
            .slice(0, 100_000))
          .catch(() => '')
        : Promise.resolve('');
      void Promise.all([
        api.get<{
          settings: {
            defaultLifetimeBudget: number;
            currency: PublishCampaignForm['currency'];
            locations: Array<{
              countryCode: string;
              region?: string;
              city?: string;
              googleGeoTargetId?: string;
              metaLocationKey?: string;
            }>;
          };
          readiness?: { accounts?: CampaignPublishResponse['accountSnapshot'] };
        }>('/api/settings/ads'),
        conversationRequest,
      ]).then(async ([settingsResponse, loadedConversationContext]) => {
        const inferenceResponse = await api.post<{
          inference: { objective: string; rationale: string } | null;
        }>('/api/campaigns/autonomous/infer-objective', {
          contentStudioContext,
          conversationContext: loadedConversationContext || undefined,
        });
        setConversationContext(loadedConversationContext);
        setAdSettingLocations(settingsResponse.settings.locations);
        setAccountSnapshot(settingsResponse.readiness?.accounts);
        setPublishForm((previous) => ({
          ...previous,
          lifetimeBudget: String(settingsResponse.settings.defaultLifetimeBudget),
          currency: settingsResponse.settings.currency,
          countries: settingsResponse.settings.locations.length
            ? settingsResponse.settings.locations.map((location) => location.countryCode)
            : previous.countries,
          objective: inferenceResponse.inference?.objective || previous.objective,
        }));
        setObjectiveRationale(inferenceResponse.inference?.rationale || 'Objective could not be inferred. Select one before publishing.');
        setObjectiveInferred(Boolean(inferenceResponse.inference));
      }).catch(() => {
        setPrefillNotice('Some campaign settings or the AI objective prefill could not be loaded. Review every field before publishing.');
      });
      
      // Load business profile to get website URL
      loadBusinessProfile();
      
      // Load ICP data to prefill targeting if available
      if (icpId) {
        loadIcpData(icpId);
      }
    }
    
    // Reset formInitialized when modal closes
    if (!open) {
      setFormInitialized(false);
      setCampaignRequestKey(`content-studio-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      setObjectiveInferred(false);
      setObjectiveRationale('');
      setConversationContext('');
      setPrefillNotice(null);
    }
  }, [open, ads, icpId, threadId, selectedBusinessProfileId, formInitialized]);

  // Load Business Profile to get website URL
  const loadBusinessProfile = async () => {
    try {
      const response = await api.get<Array<{
        id: number;
        companyName?: string;
        website?: string;
        targetMarket?: string;
        industry?: string;
      }>>('/api/settings/business-profiles');
      
      if (Array.isArray(response) && response.length > 0) {
        const profile = selectedBusinessProfileId
          ? response.find((candidate) => candidate.id === selectedBusinessProfileId)
          : response[0];
        if (!profile) throw new Error('The selected business profile is no longer available.');
        setBusinessProfileId(profile.id);
        setPublishForm(prev => {
          const updates: Partial<PublishCampaignForm> = {};
          
          // Set link URL from website if not already set
          if (profile.website && !prev.linkUrl) {
            const website = profile.website.startsWith('http') ? profile.website : `https://${profile.website}`;
            updates.linkUrl = website;
          }
          
          return { ...prev, ...updates };
        });
      }
    } catch (error) {
      console.error('Error loading business profile:', error);
      setPrefillNotice('The selected business profile could not be loaded. Review the landing URL and campaign context before publishing.');
    }
  };

  // Load ICP data to prefill targeting
  const loadIcpData = async (id: number) => {
    try {
      const response = await api.get<{
        id: number;
        name?: string;
        campaignName?: string;
        targetAudience?: {
          ageRange?: { min?: number; max?: number };
          gender?: string[];
          locations?: string[];
          countries?: string[];
        };
        demographics?: {
          ageRange?: { min?: number; max?: number };
          gender?: string;
          location?: string;
        };
      }>(`/api/icps/${id}`);
      
      if (response) {
        // Update targeting from ICP data
        setPublishForm(prev => {
          const updates: Partial<PublishCampaignForm> = {};
          
          // Set campaign name from ICP name or campaignName
          const icpName = response.campaignName || response.name;
          if (icpName) {
            updates.campaignName = icpName.includes('Campaign') ? icpName : `${icpName} Campaign`;
          }
          
          // Age range
          if (response.targetAudience?.ageRange || response.demographics?.ageRange) {
            const ageRange = response.targetAudience?.ageRange || response.demographics?.ageRange;
            if (ageRange?.min) updates.ageMin = ageRange.min;
            if (ageRange?.max) updates.ageMax = ageRange.max;
          }
          
          // Gender
          if (response.targetAudience?.gender) {
            const genderMap: Record<string, string> = { 'male': '1', 'female': '2', 'Male': '1', 'Female': '2' };
            const genders = response.targetAudience.gender.map(g => genderMap[g] || g).filter(Boolean);
            if (genders.length > 0) updates.genders = genders;
          } else if (response.demographics?.gender) {
            const genderMap: Record<string, string[]> = { 
              'male': ['1'], 
              'female': ['2'], 
              'Male': ['1'], 
              'Female': ['2'],
              'all': ['1', '2'],
              'both': ['1', '2']
            };
            const genders = genderMap[response.demographics.gender] || ['1', '2'];
            updates.genders = genders;
          }
          
          // Countries/Locations
          if (response.targetAudience?.countries && response.targetAudience.countries.length > 0) {
            updates.countries = response.targetAudience.countries;
          } else if (response.targetAudience?.locations && response.targetAudience.locations.length > 0) {
            // Try to map location names to country codes
            const countryCodeMap: Record<string, string> = {
              'united states': 'US', 'usa': 'US', 'us': 'US', 'america': 'US',
              'india': 'IN', 'in': 'IN',
              'united kingdom': 'GB', 'uk': 'GB', 'england': 'GB', 'britain': 'GB',
              'canada': 'CA', 'ca': 'CA',
              'australia': 'AU', 'au': 'AU',
              'germany': 'DE', 'de': 'DE',
              'france': 'FR', 'fr': 'FR',
            };
            const countries = response.targetAudience.locations
              .map(loc => countryCodeMap[loc.toLowerCase()] || loc.toUpperCase())
              .filter(c => COUNTRIES.some(country => country.value === c));
            if (countries.length > 0) updates.countries = countries;
          }
          
          return { ...prev, ...updates };
        });
      }
    } catch (error) {
      console.error('Error loading ICP data:', error);
      setPrefillNotice('The selected audience profile could not be loaded. Review targeting before publishing.');
    }
  };

  const handlePublishCampaign = async () => {
    // Validate selected ads
    if (publishForm.selectedAds.length === 0) {
      toast({
        title: 'Error',
        description: 'Please select at least one ad to publish',
        variant: 'destructive',
      });
      setActiveTab('ads');
      return;
    }

    // Validate campaign name
    if (!publishForm.campaignName.trim()) {
      toast({
        title: 'Error',
        description: 'Please enter a campaign name',
        variant: 'destructive',
      });
      setActiveTab('ads');
      return;
    }

    if (publishForm.campaignName.trim().length < 3) {
      toast({
        title: 'Error',
        description: 'Campaign name must be at least 3 characters long',
        variant: 'destructive',
      });
      setActiveTab('ads');
      return;
    }

    const lifetimeBudget = Number(publishForm.lifetimeBudget);
    if (!Number.isFinite(lifetimeBudget) || lifetimeBudget <= 0) {
      toast({
        title: 'Error',
        description: 'Lifetime budget must be greater than zero.',
        variant: 'destructive',
      });
      setActiveTab('budget');
      return;
    }

    // Validate dates
    const startDate = new Date(publishForm.startDate);
    const endDate = new Date(publishForm.endDate);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    if (startDate < today) {
      toast({
        title: 'Error',
        description: 'Start date cannot be in the past',
        variant: 'destructive',
      });
      setActiveTab('budget');
      return;
    }

    if (endDate <= startDate) {
      toast({
        title: 'Error',
        description: 'End date must be after start date',
        variant: 'destructive',
      });
      setActiveTab('budget');
      return;
    }

    // Validate minimum 24 hours between start and end date
    const timeDiff = endDate.getTime() - startDate.getTime();
    const hoursDiff = timeDiff / (1000 * 60 * 60);
    if (hoursDiff < 24) {
      toast({
        title: 'Error',
        description: 'Campaign must run for at least 24 hours. Please ensure end date is at least 24 hours after start date.',
        variant: 'destructive',
      });
      setActiveTab('budget');
      return;
    }

    // Validate targeting
    if (publishForm.countries.length === 0) {
      toast({
        title: 'Error',
        description: 'Please select at least one country for targeting',
        variant: 'destructive',
      });
      setActiveTab('targeting');
      return;
    }

    if (publishForm.publishPlatforms.includes('meta') && publishForm.genders.length === 0) {
      toast({
        title: 'Error',
        description: 'Please select at least one gender for targeting',
        variant: 'destructive',
      });
      setActiveTab('targeting');
      return;
    }
    if (publishForm.publishPlatforms.includes('google')) {
      const missingGeoTargets = publishForm.countries.filter((countryCode) => !/^geoTargetConstants\/\d+$/.test(
        adSettingLocations.find((location) => location.countryCode === countryCode)?.googleGeoTargetId
        || GOOGLE_GEO_TARGETS[countryCode]
        || '',
      ));
      if (missingGeoTargets.length) {
        toast({
          title: 'Google location mapping required',
          description: `Add a geoTargetConstants ID for: ${missingGeoTargets.join(', ')}.`,
          variant: 'destructive',
        });
        setActiveTab('targeting');
        return;
      }
    }

    if (publishForm.publishPlatforms.includes('meta') && publishForm.ageMin >= publishForm.ageMax) {
      toast({
        title: 'Error',
        description: 'Minimum age must be less than maximum age',
        variant: 'destructive',
      });
      setActiveTab('targeting');
      return;
    }

    if (!publishForm.objective) {
      toast({
        title: 'Objective required',
        description: 'Review the inferred objective or select one before publishing.',
        variant: 'destructive',
      });
      setActiveTab('settings');
      return;
    }

    if (!publishForm.linkUrl.trim()) {
      toast({
        title: 'Error',
        description: 'Please enter a landing page URL.',
        variant: 'destructive',
      });
      setActiveTab('settings');
      return;
    }

    // Validate URL format if provided
    if (publishForm.linkUrl.trim()) {
      try {
        new URL(publishForm.linkUrl);
      } catch {
        toast({
          title: 'Error',
          description: 'Please enter a valid URL (e.g., https://example.com)',
          variant: 'destructive',
        });
        setActiveTab('settings');
        return;
      }
    }

    if (!publishForm.activationConfirmed) {
      toast({
        title: 'Live activation confirmation required',
        description: 'Confirm the selected accounts, lifetime budget, and live activation scope before publishing.',
        variant: 'destructive',
      });
      setActiveTab('settings');
      return;
    }

    setIsPublishing(true);
    try {
      // Get selected ad data
      const selectedAdData = draftAds.filter(ad => publishForm.selectedAds.includes(ad.id)).map(ad => ({
        id: ad.id,
        title: ad.title,
        content: ad.content,
        platform: ad.platform,
        imageUrl: ad.imageUrl,
        videoUrl: ad.videoUrl,
        sourceAssetId: ad.sourceAssetId,
        sourceVersion: ad.sourceVersion,
        sourceUpdatedAt: ad.sourceUpdatedAt,
      }));

      const platformCreatives = selectedAdData.map((ad) => {
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(ad.content); } catch { parsed = { body: ad.content }; }
        return {
          ...parsed,
          name: ad.title,
          imageUrl: ad.imageUrl,
          videoUrl: ad.videoUrl,
          callToAction: publishForm.callToAction,
        };
      });
      const googleCreatives = platformCreatives.map((creative) => ({
        ...creative,
        keywords: publishForm.googleKeywords.length
          ? publishForm.googleKeywords
          : Array.isArray((creative as Record<string, unknown>).keywords)
            ? (creative as Record<string, unknown>).keywords
            : [],
      }));

      const response = await api.post<{
        success: boolean;
        campaign: CampaignPublishResponse;
        error?: string;
      }>('/api/campaigns/autonomous', buildAutonomousCampaignPayload({
        form: {
          ...publishForm,
          objectiveRationale,
        },
        creatives: {
          meta: publishForm.publishPlatforms.includes('meta') ? platformCreatives : undefined,
          google: publishForm.publishPlatforms.includes('google') ? googleCreatives : undefined,
        },
        contentStudioContext: selectedAdData.map((ad) => `${ad.title}\n${ad.content}`).join('\n\n'),
        conversationContext,
        context: {
          businessProfileId,
          brandToolkitId,
          icpId,
          threadId,
          creativeSources: selectedAdData.flatMap((ad) => ad.sourceAssetId ? [{
            sourceType: 'content_asset' as const,
            sourceId: ad.sourceAssetId,
            sourceVersion: ad.sourceVersion || 1,
            updatedAt: ad.sourceUpdatedAt,
          }] : []),
          scheduleDates: { startDate: publishForm.startDate, endDate: publishForm.endDate },
        },
        locations: publishForm.countries.map((countryCode) => ({
          ...adSettingLocations.find((location) => location.countryCode === countryCode),
          countryCode,
          googleGeoTargetId: adSettingLocations.find((location) => location.countryCode === countryCode)?.googleGeoTargetId
            || GOOGLE_GEO_TARGETS[countryCode],
        })),
        idempotencyKey: campaignRequestKey,
        publish: true,
      }));

      if (response.success) {
        const state = campaignPublishState(response.campaign);
        const stateCopy = CAMPAIGN_STATE_COPY[state];
        toast({
          title: stateCopy.title,
          description: response.campaign.validationErrors?.length
            ? response.campaign.validationErrors.join(' ')
            : stateCopy.description,
          variant: ['validation_failed', 'provider_failed'].includes(state) ? 'destructive' : 'default',
        });
        if (state === 'validation_failed') {
          setCampaignRequestKey(`content-studio-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        }
        if (state !== 'validation_failed') onOpenChange(false);
        onPublishSuccess?.(String(response.campaign.id), state);
      } else {
        throw new Error(response.error || 'Failed to publish campaign');
      }
    } catch (error) {
      console.error('Publish error:', error);
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to publish campaign',
        variant: 'destructive',
      });
    } finally {
      setIsPublishing(false);
    }
  };

  const handleSaveAsDraft = async () => {
    // Validate selected ads
    if (publishForm.selectedAds.length === 0) {
      toast({
        title: 'Error',
        description: 'Please select at least one ad to save',
        variant: 'destructive',
      });
      setActiveTab('ads');
      return;
    }

    // Validate campaign name
    if (!publishForm.campaignName.trim()) {
      toast({
        title: 'Error',
        description: 'Please enter a campaign name',
        variant: 'destructive',
      });
      setActiveTab('ads');
      return;
    }

    if (publishForm.campaignName.trim().length < 3) {
      toast({
        title: 'Error',
        description: 'Campaign name must be at least 3 characters long',
        variant: 'destructive',
      });
      setActiveTab('ads');
      return;
    }

    const lifetimeBudget = Number(publishForm.lifetimeBudget);
    if (!Number.isFinite(lifetimeBudget) || lifetimeBudget <= 0) {
      toast({
        title: 'Error',
        description: 'Lifetime budget must be greater than zero.',
        variant: 'destructive',
      });
      setActiveTab('budget');
      return;
    }

    setIsSavingDraft(true);
    try {
      // Get selected ad data
      const selectedAdData = draftAds.filter(ad => publishForm.selectedAds.includes(ad.id)).map(ad => ({
        id: ad.id,
        title: ad.title,
        content: ad.content,
        platform: ad.platform,
        imageUrl: ad.imageUrl,
        videoUrl: ad.videoUrl,
        sourceAssetId: ad.sourceAssetId,
        sourceVersion: ad.sourceVersion,
        sourceUpdatedAt: ad.sourceUpdatedAt,
      }));

      const platformCreatives = selectedAdData.map((ad) => {
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(ad.content); } catch { parsed = { body: ad.content }; }
        return { ...parsed, name: ad.title, imageUrl: ad.imageUrl, videoUrl: ad.videoUrl };
      });
      const googleCreatives = platformCreatives.map((creative) => ({
        ...creative,
        keywords: publishForm.googleKeywords.length
          ? publishForm.googleKeywords
          : Array.isArray((creative as Record<string, unknown>).keywords)
            ? (creative as Record<string, unknown>).keywords
            : [],
      }));
      const response = await api.post<{
        success: boolean;
        campaign: CampaignPublishResponse;
        error?: string;
      }>('/api/campaigns/autonomous', buildAutonomousCampaignPayload({
        form: {
          ...publishForm,
          objectiveRationale: objectiveRationale || 'Objective has not yet been reviewed.',
        },
        creatives: {
          meta: publishForm.publishPlatforms.includes('meta') ? platformCreatives : undefined,
          google: publishForm.publishPlatforms.includes('google') ? googleCreatives : undefined,
        },
        contentStudioContext: selectedAdData.map((ad) => `${ad.title}\n${ad.content}`).join('\n\n'),
        conversationContext,
        context: {
          businessProfileId,
          brandToolkitId,
          icpId,
          threadId,
          creativeSources: selectedAdData.flatMap((ad) => ad.sourceAssetId ? [{
            sourceType: 'content_asset' as const,
            sourceId: ad.sourceAssetId,
            sourceVersion: ad.sourceVersion || 1,
            updatedAt: ad.sourceUpdatedAt,
          }] : []),
          scheduleDates: { startDate: publishForm.startDate, endDate: publishForm.endDate },
        },
        locations: publishForm.countries.map((countryCode) => ({
          ...adSettingLocations.find((location) => location.countryCode === countryCode),
          countryCode,
        })),
        idempotencyKey: `${campaignRequestKey}-draft`,
        publish: false,
      }));

      if (response.success) {
        const state = campaignPublishState(response.campaign);
        toast({
          title: CAMPAIGN_STATE_COPY[state].title,
          description: CAMPAIGN_STATE_COPY[state].description,
        });
        onOpenChange(false);
        onPublishSuccess?.(String(response.campaign.id), state);
      } else {
        throw new Error(response.error || 'Failed to save draft');
      }
    } catch (error) {
      console.error('Save draft error:', error);
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to save draft',
        variant: 'destructive',
      });
    } finally {
      setIsSavingDraft(false);
    }
  };

  const toggleAdSelection = (adId: string) => {
    setPublishForm(prev => ({
      ...prev,
      selectedAds: prev.selectedAds.includes(adId)
        ? prev.selectedAds.filter(id => id !== adId)
        : [...prev.selectedAds, adId],
    }));
  };

  const selectAllAds = () => {
    setPublishForm(prev => ({
      ...prev,
      selectedAds: prev.selectedAds.length === draftAds.length
        ? [] 
        : draftAds.map(ad => ad.id),
    }));
  };

  const updateDraftAd = (adId: string, field: 'headline' | 'primaryText', value: string) => {
    setDraftAds((previous) => previous.map((ad) => {
      if (ad.id !== adId) return ad;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(ad.content) as Record<string, unknown>;
      } catch {
        parsed = { primaryText: ad.content };
      }
      if (field === 'headline') {
        parsed.headline = value;
        return { ...ad, title: value, content: JSON.stringify(parsed) };
      }
      parsed.primaryText = value;
      if ('body' in parsed) parsed.body = value;
      return { ...ad, content: JSON.stringify(parsed) };
    }));
  };

  const toggleGender = (gender: string) => {
    setPublishForm(prev => ({
      ...prev,
      genders: prev.genders.includes(gender)
        ? prev.genders.filter(g => g !== gender)
        : [...prev.genders, gender],
    }));
  };

  const toggleCountry = (country: string) => {
    setPublishForm(prev => ({
      ...prev,
      countries: prev.countries.includes(country)
        ? prev.countries.filter(c => c !== country)
        : [...prev.countries, country],
    }));
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="w-5 h-5 text-green-600" />
            Publish Campaign
          </DialogTitle>
          <DialogDescription>
            Configure your campaign settings and publish to your selected ad platforms.
          </DialogDescription>
          {prefillNotice && (
            <Callout tone="warning" size="sm" announce>
              {prefillNotice}
            </Callout>
          )}
        </DialogHeader>
        
        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 overflow-hidden flex flex-col">
          <TabsList className="grid grid-cols-4 w-full">
            <TabsTrigger value="ads" className="flex items-center gap-1">
              <Megaphone className="w-4 h-4" />
              Ads
            </TabsTrigger>
            <TabsTrigger value="budget" className="flex items-center gap-1">
              <CircleDollarSign className="w-4 h-4" />
              Budget
            </TabsTrigger>
            <TabsTrigger value="targeting" className="flex items-center gap-1">
              <Users className="w-4 h-4" />
              Targeting
            </TabsTrigger>
            <TabsTrigger value="settings" className="flex items-center gap-1">
              <Target className="w-4 h-4" />
              Settings
            </TabsTrigger>
          </TabsList>

          <div className="flex-1 overflow-y-auto py-4">
            {/* Ads Selection Tab */}
            <TabsContent value="ads" className="mt-0 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="campaign-name">Campaign Name *</Label>
                <Input
                  id="campaign-name"
                  value={publishForm.campaignName}
                  onChange={(e) => setPublishForm(prev => ({ ...prev, campaignName: e.target.value }))}
                  placeholder="My Ad Campaign"
                />
              </div>

              {/* Platform Selection */}
              <div className="space-y-3">
                <Label>Publish To *</Label>
                <div className="flex gap-4">
                  <div
                    className="flex items-center gap-2 cursor-pointer"
                    onClick={() => {
                      setPublishForm(prev => {
                        const has = prev.publishPlatforms.includes('meta');
                        const updated = has
                          ? prev.publishPlatforms.filter(p => p !== 'meta')
                          : [...prev.publishPlatforms, 'meta' as const];
                        return { ...prev, publishPlatforms: updated.length > 0 ? updated : prev.publishPlatforms };
                      });
                    }}
                  >
                    <Checkbox
                      checked={publishForm.publishPlatforms.includes('meta')}
                      onCheckedChange={(checked) => {
                        setPublishForm(prev => {
                          const updated = checked
                            ? [...prev.publishPlatforms, 'meta' as const]
                            : prev.publishPlatforms.filter(p => p !== 'meta');
                          return { ...prev, publishPlatforms: updated.length > 0 ? updated : prev.publishPlatforms };
                        });
                      }}
                    />
                    <span className="text-sm font-medium">Meta Ads</span>
                    <Badge variant="outline" className="text-xs">Facebook & Instagram</Badge>
                  </div>
                  <div
                    className="flex items-center gap-2 cursor-pointer"
                    onClick={() => {
                      setPublishForm(prev => {
                        const has = prev.publishPlatforms.includes('google');
                        const updated = has
                          ? prev.publishPlatforms.filter(p => p !== 'google')
                          : [...prev.publishPlatforms, 'google' as const];
                        return { ...prev, publishPlatforms: updated.length > 0 ? updated : prev.publishPlatforms };
                      });
                    }}
                  >
                    <Checkbox
                      checked={publishForm.publishPlatforms.includes('google')}
                      onCheckedChange={(checked) => {
                        setPublishForm(prev => {
                          const updated = checked
                            ? [...prev.publishPlatforms, 'google' as const]
                            : prev.publishPlatforms.filter(p => p !== 'google');
                          return { ...prev, publishPlatforms: updated.length > 0 ? updated : prev.publishPlatforms };
                        });
                      }}
                    />
                    <span className="text-sm font-medium">Google Ads</span>
                    <Badge variant="outline" className="text-xs">Search Network</Badge>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Select at least one platform to publish your campaign to.
                </p>
                <div className="grid gap-2 rounded-lg border bg-muted/20 p-3 text-xs">
                  {publishForm.publishPlatforms.includes('meta') && (
                    <div>
                      <span className="font-medium">Meta identity: </span>
                      {accountSnapshot?.meta
                        ? `${accountSnapshot.meta.adAccountName || accountSnapshot.meta.adAccountId} · ${accountSnapshot.meta.pageName || accountSnapshot.meta.pageId}${accountSnapshot.meta.instagramUsername ? ` · @${accountSnapshot.meta.instagramUsername}` : ''}`
                        : 'No ready ad account and Page selected in Integrations.'}
                    </div>
                  )}
                  {publishForm.publishPlatforms.includes('google') && (
                    <div>
                      <span className="font-medium">Google Ads customer: </span>
                      {accountSnapshot?.google
                        ? `${accountSnapshot.google.accountName || 'Customer'} · ${accountSnapshot.google.customerId}`
                        : 'No ready customer selected in Integrations.'}
                    </div>
                  )}
                  <p className="text-muted-foreground">This identity is snapshotted on approval. Publishing stops if the connected account changes before execution.</p>
                </div>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <Label>Select Ads to Publish *</Label>
                  <Button variant="ghost" size="sm" onClick={selectAllAds}>
                    {publishForm.selectedAds.length === draftAds.length ? 'Deselect All' : 'Select All'}
                  </Button>
                </div>
                <div className="border rounded-lg max-h-72 overflow-y-auto">
                  {draftAds.map((ad) => {
                    let headline = ad.title;
                    let primaryText = ad.content;
                    try {
                      const parsed = JSON.parse(ad.content);
                      headline = parsed.headline || ad.title;
                      primaryText = parsed.primaryText || parsed.body || parsed.content || ad.content;
                    } catch {
                      // Ignore parsing errors for headline extraction
                    }
                    return (
                      <div
                        key={ad.id}
                        className="flex items-center gap-3 p-3 border-b last:border-b-0 hover:bg-gray-50 cursor-pointer"
                        onClick={() => toggleAdSelection(ad.id)}
                      >
                        <div onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            checked={publishForm.selectedAds.includes(ad.id)}
                            onCheckedChange={() => toggleAdSelection(ad.id)}
                          />
                        </div>
                        <Megaphone className="w-4 h-4 text-orange-500 self-start mt-2" />
                        <div className="flex-1 min-w-0 space-y-2" onClick={(event) => event.stopPropagation()}>
                          <Input
                            value={headline}
                            onChange={(event) => updateDraftAd(ad.id, 'headline', event.target.value)}
                            aria-label={`Headline for ${ad.id}`}
                            className="h-8 text-xs font-semibold"
                          />
                          <Textarea
                            value={primaryText}
                            onChange={(event) => updateDraftAd(ad.id, 'primaryText', event.target.value)}
                            aria-label={`Primary text for ${ad.id}`}
                            className="min-h-16 text-xs"
                          />
                        </div>
                        {ad.imageUrl && (
                          <img src={normalizeUploadUrl(ad.imageUrl)} alt="" className="w-10 h-10 rounded object-cover" />
                        )}
                      </div>
                    );
                  })}
                </div>
                <p className="text-xs text-muted-foreground">
                  {publishForm.selectedAds.length} of {draftAds.length} ads selected. Headline and primary text edits apply to this campaign snapshot only.
                </p>
              </div>
            </TabsContent>

            {/* Budget Tab */}
            <TabsContent value="budget" className="mt-0 space-y-4">
              <div className="space-y-2">
                <Label>Budget Type</Label>
                <Select
                  value={publishForm.budgetType}
                  onValueChange={(value: 'DAILY' | 'LIFETIME') => setPublishForm(prev => ({ ...prev, budgetType: value }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="LIFETIME">Lifetime Budget</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {publishForm.budgetType === 'DAILY' ? (
                <div className="space-y-2">
                  <Label htmlFor="daily-budget">Daily Budget (₹)</Label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">₹</span>
                    <Input
                      id="daily-budget"
                      type="number"
                      min="100"
                      max="1000000"
                      value={publishForm.dailyBudget}
                      onChange={(e) => setPublishForm(prev => ({ ...prev, dailyBudget: e.target.value }))}
                      placeholder="1000"
                      className="pl-8"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <Info className="w-3 h-3" />
                    Meta requires a minimum daily budget of ₹100 INR
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  <Label htmlFor="lifetime-budget">Lifetime Budget ({publishForm.currency})</Label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{publishForm.currency}</span>
                    <Input
                      id="lifetime-budget"
                      type="number"
                      min="1"
                      max="10000000"
                      value={publishForm.lifetimeBudget}
                      onChange={(e) => setPublishForm(prev => ({ ...prev, lifetimeBudget: e.target.value }))}
                      placeholder="100"
                      className="pl-14"
                    />
                  </div>
                  <p className="text-xs text-muted-foreground flex items-center gap-1">
                    <Info className="w-3 h-3" />
                    Hard campaign cap shared by every Meta ad set and Google ad group. Default: USD 100.
                  </p>
                </div>
              )}

              {publishForm.publishPlatforms.includes('meta') && <div className="space-y-2">
                <Label>Meta Bid Strategy</Label>
                <Select
                  value={publishForm.bidStrategy}
                  onValueChange={(value) => setPublishForm(prev => ({ ...prev, bidStrategy: value }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BID_STRATEGIES.map(strategy => (
                      <SelectItem key={strategy.value} value={strategy.value}>{strategy.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {publishForm.bidStrategy !== 'LOWEST_COST_WITHOUT_CAP' && (
                  <Input
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={publishForm.bidAmount}
                    onChange={(event) => setPublishForm((previous) => ({ ...previous, bidAmount: event.target.value }))}
                    placeholder={`Bid/cost cap (${publishForm.currency})`}
                  />
                )}
              </div>}

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="start-date">
                    <Calendar className="w-4 h-4 inline mr-1" />
                    Start Date
                  </Label>
                  <Input
                    id="start-date"
                    type="date"
                    value={publishForm.startDate}
                    onChange={(e) => setPublishForm(prev => ({ ...prev, startDate: e.target.value }))}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="end-date">
                    <Calendar className="w-4 h-4 inline mr-1" />
                    End Date
                  </Label>
                  <Input
                    id="end-date"
                    type="date"
                    value={publishForm.endDate}
                    onChange={(e) => setPublishForm(prev => ({ ...prev, endDate: e.target.value }))}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                <Info className="w-3 h-3" />
                Campaign must run for at least 24 hours between start and end date
              </p>
            </TabsContent>

            {/* Targeting Tab */}
            <TabsContent value="targeting" className="mt-0 space-y-4">
              {publishForm.publishPlatforms.includes('meta') ? <>
              <div className="space-y-3">
                <Label>Age Range: {publishForm.ageMin} - {publishForm.ageMax === 65 ? '65+' : publishForm.ageMax}</Label>
                <div className="px-3 py-2">
                  <Slider
                    value={[publishForm.ageMin, publishForm.ageMax]}
                    onValueChange={([min, max]) => setPublishForm(prev => ({ ...prev, ageMin: min, ageMax: max }))}
                    min={18}
                    max={65}
                    step={1}
                    className="w-full [&_[role=slider]]:w-5 [&_[role=slider]]:h-5"
                  />
                  <div className="flex justify-between text-xs text-muted-foreground mt-1">
                    <span>18</span>
                    <span>65+</span>
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Gender</Label>
                <div className="flex gap-2">
                  <Badge
                    variant={publishForm.genders.includes('1') ? 'default' : 'outline'}
                    className="cursor-pointer"
                    onClick={() => toggleGender('1')}
                  >
                    Male
                  </Badge>
                  <Badge
                    variant={publishForm.genders.includes('2') ? 'default' : 'outline'}
                    className="cursor-pointer"
                    onClick={() => toggleGender('2')}
                  >
                    Female
                  </Badge>
                </div>
              </div>
              </> : (
                <div className="rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
                  Google Search campaigns use the reviewed keywords, locations, languages, and network settings below. Age and gender controls apply only to Meta campaigns.
                </div>
              )}

              <div className="space-y-2">
                <Label>
                  <Globe className="w-4 h-4 inline mr-1" />
                  Countries / Locations
                </Label>
                
                {/* Display selected countries as chips */}
                {publishForm.countries.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-2">
                    {publishForm.countries.map(countryCode => {
                      const country = COUNTRIES.find(c => c.value === countryCode);
                      return (
                        <Badge
                          key={countryCode}
                          variant="secondary"
                          className="cursor-pointer hover:bg-destructive hover:text-destructive-foreground transition-colors"
                          onClick={() => toggleCountry(countryCode)}
                        >
                          {country?.label || countryCode}
                          <X className="w-3 h-3 ml-1" />
                        </Badge>
                      );
                    })}
                  </div>
                )}

                {/* Input field with suggestions */}
                <div className="relative">
                  <Input
                    type="text"
                    placeholder="Type country name and press Enter..."
                    value={locationInput}
                    onChange={(e) => setLocationInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && locationInput.trim()) {
                        e.preventDefault();
                        const input = locationInput.trim().toLowerCase();
                        // Try to match with known countries
                        const countryCodeMap: Record<string, string> = {
                          'united states': 'US', 'usa': 'US', 'us': 'US', 'america': 'US',
                          'india': 'IN', 'in': 'IN',
                          'united kingdom': 'GB', 'uk': 'GB', 'england': 'GB', 'britain': 'GB',
                          'canada': 'CA', 'ca': 'CA',
                          'australia': 'AU', 'au': 'AU',
                          'germany': 'DE', 'de': 'DE',
                          'france': 'FR', 'fr': 'FR',
                          'japan': 'JP', 'jp': 'JP',
                          'brazil': 'BR', 'br': 'BR',
                          'mexico': 'MX', 'mx': 'MX',
                          'italy': 'IT', 'it': 'IT',
                          'spain': 'ES', 'es': 'ES',
                          'netherlands': 'NL', 'nl': 'NL',
                          'singapore': 'SG', 'sg': 'SG',
                          'uae': 'AE', 'united arab emirates': 'AE', 'ae': 'AE',
                          'saudi arabia': 'SA', 'sa': 'SA',
                        };
                        const countryCode = countryCodeMap[input] || input.toUpperCase().slice(0, 2);
                        if (!publishForm.countries.includes(countryCode)) {
                          setPublishForm(prev => ({
                            ...prev,
                            countries: [...prev.countries, countryCode],
                          }));
                        }
                        setLocationInput('');
                      }
                    }}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Type country name (e.g., &quot;India&quot;, &quot;United States&quot;) and press Enter to add
                </p>

                {/* Suggested countries as quick-add chips */}
                <div className="flex flex-wrap gap-1 mt-2">
                  <span className="text-xs text-muted-foreground mr-1">Quick add:</span>
                  {COUNTRIES.filter(c => !publishForm.countries.includes(c.value)).slice(0, 5).map(country => (
                    <Badge
                      key={country.value}
                      variant="outline"
                      className="cursor-pointer hover:bg-primary hover:text-primary-foreground transition-colors text-xs"
                      onClick={() => {
                        setPublishForm(prev => ({
                          ...prev,
                          countries: [...prev.countries, country.value],
                        }));
                      }}
                    >
                      + {country.label}
                    </Badge>
                  ))}
                </div>
                {publishForm.publishPlatforms.includes('google') && (
                  <div className="space-y-2 rounded-lg border p-3">
                    <Label>Google location resource IDs</Label>
                    {publishForm.countries.map((countryCode) => (
                      <div key={countryCode} className="grid grid-cols-[3rem_1fr] items-center gap-2">
                        <span className="text-xs font-medium">{countryCode}</span>
                        <Input
                          value={adSettingLocations.find((location) => location.countryCode === countryCode)?.googleGeoTargetId
                            || GOOGLE_GEO_TARGETS[countryCode]
                            || ''}
                          onChange={(event) => setAdSettingLocations((previous) => {
                            const existing = previous.find((location) => location.countryCode === countryCode);
                            const next = {
                              ...(existing || { countryCode }),
                              googleGeoTargetId: event.target.value.trim() || undefined,
                            };
                            return existing
                              ? previous.map((location) => location.countryCode === countryCode ? next : location)
                              : [...previous, next];
                          })}
                          placeholder="geoTargetConstants/…"
                        />
                      </div>
                    ))}
                    <p className="text-xs text-muted-foreground">
                      Required for every Google country and persisted in the approved location snapshot.
                    </p>
                  </div>
                )}
              </div>
            </TabsContent>

            {/* Settings Tab */}
            <TabsContent value="settings" className="mt-0 space-y-4">
              <div className="rounded-lg border border-primary/20 bg-primary/[0.03] p-4">
                <div className="flex items-start gap-3">
                  <Checkbox
                    id="modal-campaign-ai-pause-consent"
                    checked={publishForm.allowAiPause}
                    onCheckedChange={(checked) => setPublishForm((previous) => ({ ...previous, allowAiPause: checked === true }))}
                  />
                  <div className="space-y-1">
                    <Label htmlFor="modal-campaign-ai-pause-consent">Allow AI to pause underperforming ads</Label>
                    <p className="text-xs text-muted-foreground">Optional and off by default. AI may pause only after fresh evidence and can never resume, increase spend, edit targeting, or publish replacements. Revoke anytime in Ad Performance.</p>
                  </div>
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label>Campaign Objective</Label>
                  <Badge variant={objectiveInferred ? 'secondary' : 'outline'}>
                    {objectiveInferred ? 'AI inferred · editable' : 'Client selection required'}
                  </Badge>
                </div>
                <Select
                  value={publishForm.objective}
                  onValueChange={(value) => {
                    setPublishForm(prev => ({ ...prev, objective: value }));
                    setObjectiveInferred(false);
                    setObjectiveRationale('Objective selected by the client in Content Studio.');
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Review or select the campaign objective" />
                  </SelectTrigger>
                  <SelectContent>
                    {CAMPAIGN_OBJECTIVES.map(obj => (
                      <SelectItem key={obj.value} value={obj.value}>{obj.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {objectiveRationale || 'The AI uses the brief, Content Studio creative, and campaign conversation. There is no global fallback objective.'}
                </p>
              </div>

              {publishForm.publishPlatforms.includes('meta') && <div className="space-y-2">
                <Label>Optimization Goal</Label>
                <Select
                  value={publishForm.optimizationGoal}
                  onValueChange={(value) => setPublishForm(prev => ({ ...prev, optimizationGoal: value }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {OPTIMIZATION_GOALS.map(goal => (
                      <SelectItem key={goal.value} value={goal.value}>{goal.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>}

              {publishForm.publishPlatforms.includes('meta') && <div className="space-y-2">
                <Label>Billing Event</Label>
                <Select
                  value={publishForm.billingEvent}
                  onValueChange={(value) => setPublishForm(prev => ({ ...prev, billingEvent: value }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BILLING_EVENTS.map(event => (
                      <SelectItem key={event.value} value={event.value}>{event.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>}

              {publishForm.publishPlatforms.includes('meta') && (
                <div className="space-y-3 rounded-lg border p-3">
                  <div className="space-y-2">
                    <Label>Meta Special Ad Category</Label>
                    <Select
                      value={publishForm.specialAdCategories[0] || 'NONE'}
                      onValueChange={(value) => setPublishForm((previous) => ({
                        ...previous,
                        specialAdCategories: value === 'NONE' ? [] : [value],
                      }))}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="NONE">None</SelectItem>
                        <SelectItem value="HOUSING">Housing</SelectItem>
                        <SelectItem value="EMPLOYMENT">Employment</SelectItem>
                        <SelectItem value="CREDIT">Credit</SelectItem>
                        <SelectItem value="ISSUES_ELECTIONS_POLITICS">Issues, elections or politics</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Meta Placements</Label>
                    <div className="flex flex-wrap gap-2">
                      {[
                        ['facebook_feed', 'Facebook Feed'],
                        ['instagram_stream', 'Instagram Feed'],
                        ['instagram_story', 'Instagram Stories'],
                        ['instagram_reels', 'Instagram Reels'],
                      ].map(([value, label]) => (
                        <Badge
                          key={value}
                          variant={publishForm.placements.includes(value) ? 'default' : 'outline'}
                          className="cursor-pointer"
                          onClick={() => setPublishForm((previous) => ({
                            ...previous,
                            placements: previous.placements.includes(value)
                              ? previous.placements.filter((placement) => placement !== value)
                              : [...previous.placements, value],
                          }))}
                        >
                          {label}
                        </Badge>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">Leave all unselected to use Meta automatic placements.</p>
                  </div>
                  {['sales', 'app_promotion'].includes(publishForm.objective) && (
                    <div className="space-y-2 border-t pt-3">
                      <Label>Meta conversion destination</Label>
                      {publishForm.objective === 'sales' ? (
                        <>
                          <Input
                            value={publishForm.metaPixelId}
                            onChange={(event) => setPublishForm((previous) => ({ ...previous, metaPixelId: event.target.value }))}
                            placeholder="Meta Pixel ID"
                          />
                          <Input
                            value={publishForm.metaCustomConversionId}
                            onChange={(event) => setPublishForm((previous) => ({ ...previous, metaCustomConversionId: event.target.value }))}
                            placeholder="Custom conversion ID (optional)"
                          />
                        </>
                      ) : (
                        <>
                          <Input
                            value={publishForm.metaApplicationId}
                            onChange={(event) => setPublishForm((previous) => ({ ...previous, metaApplicationId: event.target.value }))}
                            placeholder="Meta application ID"
                          />
                          <Input
                            type="url"
                            value={publishForm.metaObjectStoreUrl}
                            onChange={(event) => setPublishForm((previous) => ({ ...previous, metaObjectStoreUrl: event.target.value }))}
                            placeholder="App Store or Play Store URL"
                          />
                        </>
                      )}
                      <p className="text-xs text-muted-foreground">
                        Required for conversion or app optimization and snapshotted with the approved campaign.
                      </p>
                    </div>
                  )}
                </div>
              )}

              {publishForm.publishPlatforms.includes('google') && (
                <div className="space-y-3 rounded-lg border p-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-2">
                      <Label>Google Budget</Label>
                      <Select
                        value={publishForm.googleBudgetMode}
                        onValueChange={(value: 'CAMPAIGN_TOTAL' | 'AVERAGE_DAILY') => setPublishForm((previous) => ({ ...previous, googleBudgetMode: value }))}
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="CAMPAIGN_TOTAL">Dated campaign total</SelectItem>
                          <SelectItem value="AVERAGE_DAILY">Average daily derived from total</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Keyword Match</Label>
                      <Select
                        value={publishForm.googleKeywordMatchType}
                        onValueChange={(value: 'BROAD' | 'PHRASE' | 'EXACT') => setPublishForm((previous) => ({ ...previous, googleKeywordMatchType: value }))}
                      >
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="BROAD">Broad</SelectItem>
                          <SelectItem value="PHRASE">Phrase</SelectItem>
                          <SelectItem value="EXACT">Exact</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label>Google Bidding</Label>
                    <Select
                      value={publishForm.googleBiddingStrategy}
                      onValueChange={(value) => setPublishForm((previous) => ({ ...previous, googleBiddingStrategy: value }))}
                    >
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="MAXIMIZE_CONVERSIONS">Maximize conversions</SelectItem>
                        <SelectItem value="MAXIMIZE_CONVERSION_VALUE">Maximize conversion value</SelectItem>
                        <SelectItem value="MAXIMIZE_CLICKS">Maximize clicks</SelectItem>
                        <SelectItem value="MANUAL_CPC">Manual CPC</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Reviewed Google keywords</Label>
                    <Input
                      value={publishForm.googleKeywords.join(', ')}
                      onChange={(event) => setPublishForm((previous) => ({
                        ...previous,
                        googleKeywords: event.target.value.split(',').map((keyword) => keyword.trim()).filter(Boolean),
                      }))}
                      placeholder="keyword one, keyword two"
                    />
                    <p className="text-xs text-muted-foreground">
                      Required for Search. These editable values override AI-generated creative keywords.
                    </p>
                  </div>
                  <Input
                    value={publishForm.googleNegativeKeywords.join(', ')}
                    onChange={(event) => setPublishForm((previous) => ({
                      ...previous,
                      googleNegativeKeywords: event.target.value.split(',').map((keyword) => keyword.trim()).filter(Boolean),
                    }))}
                    placeholder="Negative keywords, comma separated"
                  />
                  <div className="grid grid-cols-2 gap-3">
                    <Input
                      value={publishForm.googlePath1}
                      maxLength={15}
                      onChange={(event) => setPublishForm((previous) => ({ ...previous, googlePath1: event.target.value }))}
                      placeholder="Display path 1"
                    />
                    <Input
                      value={publishForm.googlePath2}
                      maxLength={15}
                      onChange={(event) => setPublishForm((previous) => ({ ...previous, googlePath2: event.target.value }))}
                      placeholder="Display path 2"
                    />
                  </div>
                  <Input
                    value={publishForm.googleTrackingTemplate}
                    onChange={(event) => setPublishForm((previous) => ({ ...previous, googleTrackingTemplate: event.target.value }))}
                    placeholder="Tracking template (optional)"
                  />
                  <Input
                    value={publishForm.googleFinalUrlSuffix}
                    onChange={(event) => setPublishForm((previous) => ({ ...previous, googleFinalUrlSuffix: event.target.value }))}
                    placeholder="Final URL suffix (optional)"
                  />
                </div>
              )}

              <div className="space-y-2">
                <Label>Call to Action</Label>
                <Select
                  value={publishForm.callToAction}
                  onValueChange={(value) => setPublishForm(prev => ({ ...prev, callToAction: value }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CALL_TO_ACTIONS.map(cta => (
                      <SelectItem key={cta.value} value={cta.value}>{cta.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="link-url">Landing Page URL</Label>
                <Input
                  id="link-url"
                  type="url"
                  value={publishForm.linkUrl}
                  onChange={(e) => setPublishForm(prev => ({ ...prev, linkUrl: e.target.value }))}
                  placeholder="https://yoursite.com/landing-page"
                />
              </div>
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
                <div className="flex items-start gap-3">
                  <Checkbox
                    id="modal-live-activation-confirmation"
                    checked={publishForm.activationConfirmed}
                    onCheckedChange={(checked) => setPublishForm((previous) => ({ ...previous, activationConfirmed: checked === true }))}
                  />
                  <div className="space-y-1">
                    <Label htmlFor="modal-live-activation-confirmation">Confirm live activation and spend</Label>
                    <p className="text-xs text-muted-foreground">
                      I reviewed {publishForm.publishPlatforms.map((platform) => platform === 'google' ? 'Google Ads' : 'Meta Ads').join(' + ')}, the selected provider account{publishForm.publishPlatforms.length > 1 ? 's' : ''}, and the {publishForm.currency} {publishForm.lifetimeBudget || '0'} lifetime cap. Publishing may activate provider resources and begin spend.
                    </p>
                  </div>
                </div>
              </div>
            </TabsContent>
          </div>
        </Tabs>

        <DialogFooter className="border-t pt-4">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            <X className="w-4 h-4 mr-1" />
            Cancel
          </Button>
          {/* Show Next button on non-settings tabs, Publish button only on settings tab */}
          {activeTab !== 'settings' ? (
            <Button 
              onClick={() => {
                const tabs = ['ads', 'budget', 'targeting', 'settings'];
                const currentIndex = tabs.indexOf(activeTab);
                
                // Validate current tab before moving to next
                if (activeTab === 'ads') {
                  if (publishForm.selectedAds.length === 0) {
                    toast({
                      title: 'Error',
                      description: 'Please select at least one ad to publish',
                      variant: 'destructive',
                    });
                    return;
                  }
                  if (!publishForm.campaignName.trim()) {
                    toast({
                      title: 'Error',
                      description: 'Please enter a campaign name',
                      variant: 'destructive',
                    });
                    return;
                  }
                  if (publishForm.campaignName.trim().length < 3) {
                    toast({
                      title: 'Error',
                      description: 'Campaign name must be at least 3 characters long',
                      variant: 'destructive',
                    });
                    return;
                  }
                }
                
                if (activeTab === 'budget') {
                  if (publishForm.budgetType === 'DAILY') {
                    const dailyBudget = parseInt(publishForm.dailyBudget, 10);
                    if (isNaN(dailyBudget) || dailyBudget < 100) {
                      toast({
                        title: 'Error',
                        description: 'Daily budget must be at least ₹100',
                        variant: 'destructive',
                      });
                      return;
                    }
                  } else {
                    const lifetimeBudget = Number(publishForm.lifetimeBudget);
                    if (!Number.isFinite(lifetimeBudget) || lifetimeBudget <= 0) {
                      toast({
                        title: 'Error',
                        description: 'Lifetime budget must be greater than zero.',
                        variant: 'destructive',
                      });
                      return;
                    }
                  }
                  
                  // Date validation
                  const startDate = new Date(publishForm.startDate);
                  const endDate = new Date(publishForm.endDate);
                  const today = new Date();
                  today.setHours(0, 0, 0, 0);

                  if (startDate < today) {
                    toast({
                      title: 'Error',
                      description: 'Start date cannot be in the past',
                      variant: 'destructive',
                    });
                    return;
                  }

                  if (endDate <= startDate) {
                    toast({
                      title: 'Error',
                      description: 'End date must be after start date',
                      variant: 'destructive',
                    });
                    return;
                  }

                  const timeDiff = endDate.getTime() - startDate.getTime();
                  const hoursDiff = timeDiff / (1000 * 60 * 60);
                  if (hoursDiff < 24) {
                    toast({
                      title: 'Error',
                      description: 'Campaign must run for at least 24 hours',
                      variant: 'destructive',
                    });
                    return;
                  }
                }
                
                if (activeTab === 'targeting') {
                  if (publishForm.countries.length === 0) {
                    toast({
                      title: 'Error',
                      description: 'Please add at least one country for targeting',
                      variant: 'destructive',
                    });
                    return;
                  }
                  if (publishForm.genders.length === 0) {
                    toast({
                      title: 'Error',
                      description: 'Please select at least one gender for targeting',
                      variant: 'destructive',
                    });
                    return;
                  }
                  if (publishForm.ageMin >= publishForm.ageMax) {
                    toast({
                      title: 'Error',
                      description: 'Minimum age must be less than maximum age',
                      variant: 'destructive',
                    });
                    return;
                  }
                }
                
                // Move to next tab
                if (currentIndex < tabs.length - 1) {
                  setActiveTab(tabs[currentIndex + 1]);
                }
              }}
            >
              Next
            </Button>
          ) : (
            <>
              <Button 
                variant="outline"
                onClick={handleSaveAsDraft} 
                loading={isSavingDraft}
                disabled={isPublishing || publishForm.selectedAds.length === 0 || !publishForm.campaignName}
              >
                <Save className="w-4 h-4 mr-1" />
                Save as Draft
              </Button>
              <Button 
                onClick={handlePublishCampaign} 
                loading={isPublishing}
                disabled={isSavingDraft || publishForm.selectedAds.length === 0 || !publishForm.campaignName || publishForm.publishPlatforms.length === 0 || !publishForm.activationConfirmed}
                className="bg-green-600 hover:bg-green-700"
              >
                <Send className="w-4 h-4 mr-1" />
                {publishForm.publishPlatforms.length === 2
                  ? 'Publish to Meta & Google'
                  : publishForm.publishPlatforms.includes('google')
                    ? 'Publish to Google Ads'
                    : 'Publish to Meta'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
