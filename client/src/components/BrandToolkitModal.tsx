import { useState, useRef, useEffect, useLayoutEffect, useId, useSyncExternalStore, type RefObject } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';
import api, { ApiError } from '@/lib/api';
import { normalizeUploadUrl } from '@/lib/utils';
import { selectedBusinessProfileId, subscribeBusinessProfile } from '@/lib/business-profile';
import { 
  Upload, 
  X, 
  Plus,
  Save,
  ChevronRight,
  ChevronLeft,
  Palette,
  MessageSquare,
  Target,
  PenTool,
  Type
} from 'lucide-react';

interface BrandToolkit {
  id?: number;
  brandName: string;
  description?: string;
  tagline?: string;
  missionStatement?: string;
  brandValues?: string[];
  brandKeywords?: string[];
  primaryColors?: string[];
  secondaryColors?: string[];
  accentColor?: string;
  additionalColors?: string[];
  fonts?: { heading?: string; body?: string; accent?: string };
  logoUrls?: string[];
  imageStyleReference?: string;
  voiceType?: string;
  customToneGuidelines?: string;
  voicePersonalityTraits?: string[];
  voiceDos?: string[];
  voiceDonts?: string[];
  voiceKeywords?: string[];
  contentPillars?: string[];
  contentFormats?: string[];
  hashtags?: string[];
  ctas?: string[];
  audiencePainPoints?: string[];
  audienceGoals?: string[];
  audienceLanguageStyle?: string[];
  audienceTriggers?: string[];
  isDefault?: boolean;
  isActive?: boolean;
}

interface BrandToolkitModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave?: () => void;
  initialData?: BrandToolkit | null;
}

interface EditorGeneration {
  retired: boolean;
  workspaceId: number | null;
}

type BrandToolkitEditorProps = BrandToolkitModalProps & {
  workspaceId: number | null;
  generationRef: RefObject<EditorGeneration | null>;
};

function isCurrentEditor(generation: EditorGeneration | null, generationRef: RefObject<EditorGeneration | null>) {
  return generation !== null && !generation.retired && generationRef.current === generation &&
    generation.workspaceId === selectedBusinessProfileId();
}

type TagField = 'brandValues' | 'brandKeywords' | 'voicePersonalityTraits' | 'voiceDos' |
  'voiceDonts' | 'voiceKeywords' | 'contentPillars' | 'contentFormats' | 'hashtags' |
  'ctas' | 'audiencePainPoints' | 'audienceGoals' | 'audienceLanguageStyle' | 'audienceTriggers';
type ColorField = 'primaryColors' | 'secondaryColors' | 'additionalColors';
type ArrayField = TagField | ColorField | 'logoUrls';

function TagInput({ label, field, placeholder, idPrefix, toolkit, drafts, onDraftChange, onAdd, onRemove }: {
  label: string;
  field: TagField;
  placeholder: string;
  idPrefix: string;
  toolkit: BrandToolkit;
  drafts: Partial<Record<TagField, string>>;
  onDraftChange: (field: TagField, value: string) => void;
  onAdd: (field: TagField, value: string) => void;
  onRemove: (field: ArrayField, index: number) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const input = drafts[field] || '';
  const values = toolkit[field] || [];
  const inputId = `${idPrefix}-${field}`;
  const handleAdd = () => {
    if (!input.trim()) return;
    onAdd(field, input);
    onDraftChange(field, '');
  };

  return (
    <div className="space-y-2">
      <Label htmlFor={inputId}>{label}</Label>
      <div className="flex gap-2">
        <Input
          id={inputId}
          ref={inputRef}
          value={input}
          onChange={(event) => onDraftChange(field, event.target.value)}
          placeholder={placeholder}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault();
              handleAdd();
            }
          }}
        />
        <Button type="button" size="sm" onClick={handleAdd} aria-label={`Add ${label}`}>
          <Plus className="w-4 h-4" aria-hidden="true" />
        </Button>
      </div>
      {values.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {values.map((value, index) => (
            <Badge key={index} variant="secondary" className="pr-1">
              {value}
              <button
                type="button"
                aria-label={`Remove ${value} from ${label}`}
                onClick={() => {
                  onRemove(field, index);
                  inputRef.current?.focus();
                }}
                className="ml-1 hover:text-destructive"
              >
                <X className="w-3 h-3" aria-hidden="true" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

function ColorInput({ label, field, colors, onChange }: {
  label: string;
  field: ColorField;
  colors: string[];
  onChange: (field: ColorField, colors: string[]) => void;
}) {
  const addButtonRef = useRef<HTMLButtonElement>(null);
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium leading-none">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {colors.map((color, index) => (
          <div key={index} className="relative group">
            <input
              type="color"
              aria-label={`${label} ${index + 1} color picker`}
              value={color}
              onChange={(event) => onChange(field, colors.map((value, i) => i === index ? event.target.value : value))}
              className="w-10 h-10 rounded cursor-pointer border"
            />
            <button
              type="button"
              aria-label={`Remove ${label} color ${index + 1} (${color})`}
              onClick={() => {
                onChange(field, colors.filter((_, i) => i !== index));
                addButtonRef.current?.focus();
              }}
              className="absolute -top-1 -right-1 w-4 h-4 bg-destructive text-white rounded-full text-xs opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity"
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
        ))}
        <Button ref={addButtonRef} type="button" variant="outline" size="icon" onClick={() => onChange(field, [...colors, '#000000'])} aria-label={`Add ${label}`}>
          <Plus className="w-4 h-4" aria-hidden="true" />
        </Button>
      </div>
    </fieldset>
  );
}

const STEPS = [
  { id: 1, title: 'Brand Identity', icon: Palette },
  { id: 2, title: 'Visual Identity', icon: PenTool },
  { id: 3, title: 'Voice & Tone', icon: MessageSquare },
  { id: 4, title: 'Content Style', icon: Type },
  { id: 5, title: 'Target Audience', icon: Target },
];

const DEFAULT_TOOLKIT: BrandToolkit = {
  brandName: '',
  description: '',
  tagline: '',
  missionStatement: '',
  brandValues: [],
  brandKeywords: [],
  primaryColors: ['#3B82F6'],
  secondaryColors: ['#10B981'],
  accentColor: '',
  additionalColors: [],
  fonts: { heading: 'Inter', body: 'Inter', accent: 'Inter' },
  logoUrls: [],
  imageStyleReference: '',
  voiceType: '',
  customToneGuidelines: '',
  voicePersonalityTraits: [],
  voiceDos: [],
  voiceDonts: [],
  voiceKeywords: [],
  contentPillars: [],
  contentFormats: [],
  hashtags: [],
  ctas: [],
  audiencePainPoints: [],
  audienceGoals: [],
  audienceLanguageStyle: [],
  audienceTriggers: [],
  isDefault: false,
  isActive: true,
};

export default function BrandToolkitModal(props: BrandToolkitModalProps) {
  const workspaceId = useSyncExternalStore(subscribeBusinessProfile, selectedBusinessProfileId, () => null);
  const generationRef = useRef<EditorGeneration | null>(null);
  const handleClose = () => {
    // Retire immediately, even if the controlled parent closes on a later render.
    if (generationRef.current) generationRef.current.retired = true;
    props.onClose();
  };
  return (
    <Dialog open={props.isOpen} onOpenChange={(open) => !open && handleClose()}>
      {props.isOpen && (
        <BrandToolkitEditor key={`${workspaceId}:${props.initialData?.id ?? 'new'}`} {...props} onClose={handleClose} workspaceId={workspaceId} generationRef={generationRef} />
      )}
    </Dialog>
  );
}

function BrandToolkitEditor({
  onClose, 
  onSave,
  initialData,
  workspaceId,
  generationRef
}: BrandToolkitEditorProps) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const brandNameRef = useRef<HTMLInputElement>(null);
  const idPrefix = useId();
  const [isLoading, setIsLoading] = useState(false);
  const creationRequestKey = useRef<string | null>(null);
  const pendingUploads = useRef(0);
  const saveBusy = useRef(false);
  const [isUploadingLogo, setIsUploadingLogo] = useState(false);
  const [currentStep, setCurrentStep] = useState(1);
  const [toolkit, setToolkit] = useState<BrandToolkit>(() => initialData || DEFAULT_TOOLKIT);
  // Drafts belong to the form session, including fields on inactive steps.
  // The editor unmounts on close and is keyed by workspace and record above.
  const [tagDrafts, setTagDrafts] = useState<Partial<Record<TagField, string>>>({});
  const [brandNameError, setBrandNameError] = useState(false);

  useLayoutEffect(() => {
    // Each committed editor lifetime gets its own token, including Strict Mode
    // effect replay. Old continuations never become current again after reopen.
    const generation: EditorGeneration = { retired: false, workspaceId };
    generationRef.current = generation;
    return () => {
      generation.retired = true;
      if (generationRef.current === generation) generationRef.current = null;
    };
  }, [generationRef, workspaceId]);

  useEffect(() => {
    if (brandNameError && currentStep === 1) brandNameRef.current?.focus();
  }, [brandNameError, currentStep]);

  const updateField = <K extends keyof BrandToolkit>(field: K, value: BrandToolkit[K]) => {
    setToolkit(prev => ({ ...prev, [field]: value }));
  };

  const addToArray = (field: TagField, value: string) => {
    if (!value.trim()) return;
    setToolkit(prev => ({ ...prev, [field]: [...(prev[field] || []), value.trim()] }));
  };

  const removeFromArray = (field: ArrayField, index: number) => {
    setToolkit(prev => ({ ...prev, [field]: (prev[field] || []).filter((_, i) => i !== index) }));
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const generation = generationRef.current;
    if (!isCurrentEditor(generation, generationRef) || saveBusy.current) return;
    const file = e.target.files?.[0];
    if (file) {
      pendingUploads.current += 1;
      setIsUploadingLogo(true);
      try {
        // Upload to server instead of storing base64 locally
        const formData = new FormData();
        formData.append('logo', file);
        
        const uploadPath = toolkit.id
          ? `/api/content/brand-toolkits/${toolkit.id}/logo`
          : '/api/content/brand-toolkits/upload-logo';
        const data = await api.postForm<{ url: string }>(uploadPath, formData);
        if (!isCurrentEditor(generation, generationRef)) return;
        setToolkit(prev => ({ ...prev, logoUrls: [data.url, ...(prev.logoUrls || []).filter(url => url !== data.url)] }));
        if (!isCurrentEditor(generation, generationRef)) return;
        toast({
          title: 'Logo Uploaded',
          description: 'Your logo has been uploaded successfully.',
        });
      } catch (error) {
        if (!isCurrentEditor(generation, generationRef)) return;
        toast({
          title: 'Upload Failed',
          description: error instanceof Error ? error.message : 'Failed to upload logo',
          variant: 'destructive',
        });
      } finally {
        if (isCurrentEditor(generation, generationRef)) {
          pendingUploads.current = Math.max(0, pendingUploads.current - 1);
          setIsUploadingLogo(pendingUploads.current > 0);
        }
        e.target.value = '';
      }
    }
  };

  const handleSave = async () => {
    const generation = generationRef.current;
    if (!isCurrentEditor(generation, generationRef) || pendingUploads.current > 0 || saveBusy.current) return;
    if (!toolkit.brandName?.trim()) {
      setBrandNameError(true);
      setCurrentStep(1);
      toast({
        title: 'Brand Name Required',
        description: 'Please enter a brand name.',
        variant: 'destructive',
      });
      return;
    }

    saveBusy.current = true;
    setIsLoading(true);
    try {
      if (!toolkit.id) creationRequestKey.current ??= crypto.randomUUID();
      const { hashtags, ctas, ...canonicalFields } = toolkit;
      const payload = {
        ...canonicalFields,
        ...(!toolkit.id ? { idempotencyKey: creationRequestKey.current } : {}),
        name: toolkit.brandName.trim(),
        defaultHashtags: hashtags || [],
        defaultCtas: ctas || [],
      };
      if (toolkit.id) {
        await api.put(`/api/content/brand-toolkits/${toolkit.id}`, payload);
      } else {
        await api.post('/api/content/brand-toolkits', payload);
      }
      if (!isCurrentEditor(generation, generationRef)) return;
      toast(toolkit.id
        ? { title: 'Toolkit Updated', description: 'Your brand toolkit has been updated.' }
        : { title: 'Toolkit Created', description: 'Your brand toolkit has been created.' });
      if (!isCurrentEditor(generation, generationRef)) return;
      onSave?.();
      if (!isCurrentEditor(generation, generationRef)) return;
      onClose();
    } catch (error: unknown) {
      if (!isCurrentEditor(generation, generationRef)) return;
      const errorMessage = error instanceof ApiError ? error.message : 'Failed to save brand toolkit';
      toast({
        title: 'Error',
        description: errorMessage,
        variant: 'destructive',
      });
    } finally {
      if (isCurrentEditor(generation, generationRef)) { saveBusy.current = false; setIsLoading(false); }
    }
  };

  const nextStep = () => setCurrentStep(s => Math.min(s + 1, 5));
  const prevStep = () => setCurrentStep(s => Math.max(s - 1, 1));

  const tagInputProps = {
    idPrefix, toolkit, drafts: tagDrafts,
    onDraftChange: (field: TagField, value: string) => setTagDrafts(prev => ({ ...prev, [field]: value })),
    onAdd: addToArray, onRemove: removeFromArray,
  };

  return (
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {toolkit.id ? 'Edit Brand Toolkit' : 'Create Brand Toolkit'}
          </DialogTitle>
          <DialogDescription className="sr-only">Define your brand identity, visuals, voice, content and audience across five steps.</DialogDescription>
        </DialogHeader>

        {/* Step Indicator */}
        <div className="flex items-center justify-between mb-6 px-2">
          {STEPS.map((step, i) => (
            <div key={step.id} className="flex items-center">
              <button
                type="button"
                aria-label={step.title}
                aria-current={currentStep === step.id ? 'step' : undefined}
                onClick={() => setCurrentStep(step.id)}
                className={`flex flex-col items-center gap-1 transition-colors ${
                  currentStep === step.id
                    ? 'text-primary'
                    : currentStep > step.id
                    ? 'text-primary/60'
                    : 'text-muted-foreground'
                }`}
              >
                <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                  currentStep === step.id
                    ? 'bg-primary text-white'
                    : currentStep > step.id
                    ? 'bg-primary/20 text-primary'
                    : 'bg-muted'
                }`}>
                  <step.icon className="w-4 h-4" />
                </div>
                <span className="text-xs hidden sm:block">{step.title}</span>
              </button>
              {i < STEPS.length - 1 && (
                <div className={`w-8 h-0.5 mx-1 ${
                  currentStep > step.id ? 'bg-primary/60' : 'bg-muted'
                }`} />
              )}
            </div>
          ))}
        </div>

        {/* Step Content */}
        <div className="space-y-4 min-h-[300px]">
          {/* Step 1: Brand Identity */}
          {currentStep === 1 && (
            <div className="space-y-4">
              <div>
                <Label htmlFor={`${idPrefix}-brandName`}>Brand Name *</Label>
                <Input
                  id={`${idPrefix}-brandName`}
                  value={toolkit.brandName}
                  ref={brandNameRef}
                  required
                  aria-invalid={brandNameError || undefined}
                  aria-describedby={brandNameError ? `${idPrefix}-brandName-error` : undefined}
                  onChange={(e) => {
                    updateField('brandName', e.target.value);
                    if (e.target.value.trim()) setBrandNameError(false);
                  }}
                  placeholder="e.g., Acme Inc."
                />
                {brandNameError && (
                  <p id={`${idPrefix}-brandName-error`} role="alert" className="text-sm text-destructive mt-1">Please enter a brand name.</p>
                )}
              </div>
              <div>
                <Label htmlFor={`${idPrefix}-tagline`}>Tagline</Label>
                <Input
                  id={`${idPrefix}-tagline`}
                  value={toolkit.tagline || ''}
                  onChange={(e) => updateField('tagline', e.target.value)}
                  placeholder="e.g., Innovation for Tomorrow"
                />
              </div>
              <div>
                <Label htmlFor={`${idPrefix}-description`}>Description</Label>
                <Textarea
                  id={`${idPrefix}-description`}
                  value={toolkit.description || ''}
                  onChange={(e) => updateField('description', e.target.value)}
                  placeholder="A brief description of your brand..."
                  rows={2}
                />
              </div>
              <div>
                <Label htmlFor={`${idPrefix}-missionStatement`}>Mission Statement</Label>
                <Textarea
                  id={`${idPrefix}-missionStatement`}
                  value={toolkit.missionStatement || ''}
                  onChange={(e) => updateField('missionStatement', e.target.value)}
                  placeholder="What does your brand stand for?"
                  rows={3}
                />
              </div>
              <TagInput
                {...tagInputProps}
                label="Brand Values"
                field="brandValues"
                placeholder="e.g., Innovation, Trust, Quality"
              />
              <TagInput
                {...tagInputProps}
                label="Brand Keywords"
                field="brandKeywords"
                placeholder="e.g., SaaS, AI, Marketing"
              />
            </div>
          )}

          {/* Step 2: Visual Identity */}
          {currentStep === 2 && (
            <div className="space-y-4">
              <ColorInput label="Primary Colors" field="primaryColors" colors={toolkit.primaryColors || []} onChange={updateField} />
              <ColorInput label="Secondary Colors" field="secondaryColors" colors={toolkit.secondaryColors || []} onChange={updateField} />
              
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor={`${idPrefix}-accentColor`}>Accent Color</Label>
                  <div className="flex items-center gap-2 mt-1">
                    <input
                      type="color"
                      aria-label="Accent Color color picker"
                      value={toolkit.accentColor || '#F59E0B'}
                      onChange={(e) => updateField('accentColor', e.target.value)}
                      className="w-10 h-10 rounded cursor-pointer border"
                    />
                    <Input
                      id={`${idPrefix}-accentColor`}
                      value={toolkit.accentColor || ''}
                      onChange={(e) => updateField('accentColor', e.target.value)}
                      placeholder="#F59E0B"
                      className="flex-1"
                    />
                  </div>
                </div>
                <div>
                  <Label htmlFor={`${idPrefix}-imageStyleReference`}>Image Style Reference</Label>
                  <Input
                    id={`${idPrefix}-imageStyleReference`}
                    value={toolkit.imageStyleReference || ''}
                    onChange={(e) => updateField('imageStyleReference', e.target.value)}
                    placeholder="e.g., Minimalist, Corporate, Playful"
                    className="mt-1"
                  />
                </div>
              </div>
              
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <Label htmlFor={`${idPrefix}-headingFont`}>Heading Font</Label>
                  <Input
                    id={`${idPrefix}-headingFont`}
                    value={toolkit.fonts?.heading || ''}
                    onChange={(e) => updateField('fonts', { ...toolkit.fonts, heading: e.target.value })}
                    placeholder="e.g., Inter"
                  />
                </div>
                <div>
                  <Label htmlFor={`${idPrefix}-bodyFont`}>Body Font</Label>
                  <Input
                    id={`${idPrefix}-bodyFont`}
                    value={toolkit.fonts?.body || ''}
                    onChange={(e) => updateField('fonts', { ...toolkit.fonts, body: e.target.value })}
                    placeholder="e.g., Inter"
                  />
                </div>
                <div>
                  <Label htmlFor={`${idPrefix}-accentFont`}>Accent Font</Label>
                  <Input
                    id={`${idPrefix}-accentFont`}
                    value={toolkit.fonts?.accent || ''}
                    onChange={(e) => updateField('fonts', { ...toolkit.fonts, accent: e.target.value })}
                    placeholder="e.g., Inter"
                  />
                </div>
              </div>

              <div>
                <Label htmlFor={`${idPrefix}-logo`}>Logo</Label>
                <input
                  type="file"
                  id={`${idPrefix}-logo`}
                  ref={fileInputRef}
                  disabled={isLoading}
                  onChange={handleLogoUpload}
                  accept="image/*"
                  className="hidden"
                />
                <div className="flex gap-2 flex-wrap mt-2">
                  {(toolkit.logoUrls || []).map((url, i) => (
                    <div key={i} className="relative group">
                      <img src={normalizeUploadUrl(url)} alt="Logo" className="w-16 h-16 object-contain border rounded" />
                      <button
                        type="button"
                        aria-label={`Remove logo ${i + 1}`}
                        onClick={() => removeFromArray('logoUrls', i)}
                        className="absolute -top-1 -right-1 w-4 h-4 bg-destructive text-white rounded-full text-xs"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    disabled={isLoading}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <Upload className="w-4 h-4 mr-2" />
                    Upload Logo
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Step 3: Voice & Tone */}
          {currentStep === 3 && (
            <div className="space-y-4">
              <div>
                <Label htmlFor={`${idPrefix}-voiceType`}>Voice Type</Label>
                <Input
                  id={`${idPrefix}-voiceType`}
                  value={toolkit.voiceType || ''}
                  onChange={(e) => updateField('voiceType', e.target.value)}
                  placeholder="e.g., Professional, Casual, Authoritative"
                />
              </div>
              <div>
                <Label htmlFor={`${idPrefix}-customToneGuidelines`}>Custom Tone Guidelines</Label>
                <Textarea
                  id={`${idPrefix}-customToneGuidelines`}
                  value={toolkit.customToneGuidelines || ''}
                  onChange={(e) => updateField('customToneGuidelines', e.target.value)}
                  placeholder="Describe your brand's tone and communication style..."
                  rows={3}
                />
              </div>
              <TagInput
                {...tagInputProps}
                label="Personality Traits"
                field="voicePersonalityTraits"
                placeholder="e.g., Friendly, Professional"
              />
              <TagInput
                {...tagInputProps}
                label="Voice Do's"
                field="voiceDos"
                placeholder="e.g., Use active voice"
              />
              <TagInput
                {...tagInputProps}
                label="Voice Don'ts"
                field="voiceDonts"
                placeholder="e.g., Avoid jargon"
              />
              <TagInput
                {...tagInputProps}
                label="Keywords to Use"
                field="voiceKeywords"
                placeholder="e.g., innovative, seamless"
              />
            </div>
          )}

          {/* Step 4: Content Style */}
          {currentStep === 4 && (
            <div className="space-y-4">
              <TagInput
                {...tagInputProps}
                label="Content Pillars"
                field="contentPillars"
                placeholder="e.g., Thought Leadership"
              />
              <TagInput
                {...tagInputProps}
                label="Content Formats"
                field="contentFormats"
                placeholder="e.g., Blog Posts, Videos"
              />
              <TagInput
                {...tagInputProps}
                label="Hashtags"
                field="hashtags"
                placeholder="e.g., #Innovation"
              />
              <TagInput
                {...tagInputProps}
                label="Call-to-Actions (CTAs)"
                field="ctas"
                placeholder="e.g., Learn More, Get Started"
              />
            </div>
          )}

          {/* Step 5: Target Audience */}
          {currentStep === 5 && (
            <div className="space-y-4">
              <TagInput
                {...tagInputProps}
                label="Pain Points"
                field="audiencePainPoints"
                placeholder="e.g., Time constraints"
              />
              <TagInput
                {...tagInputProps}
                label="Goals"
                field="audienceGoals"
                placeholder="e.g., Increase productivity"
              />
              <TagInput
                {...tagInputProps}
                label="Language Style"
                field="audienceLanguageStyle"
                placeholder="e.g., Professional, Technical"
              />
              <TagInput
                {...tagInputProps}
                label="Emotional Triggers"
                field="audienceTriggers"
                placeholder="e.g., FOMO, Trust"
              />
            </div>
          )}
        </div>

        {/* Navigation */}
        <div className="flex items-center justify-between pt-4 border-t">
          <Button
            variant="outline"
            onClick={prevStep}
            disabled={currentStep === 1}
          >
            <ChevronLeft className="w-4 h-4 mr-1" />
            Previous
          </Button>
          
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            {currentStep < 5 ? (
              <Button onClick={nextStep}>
                Next
                <ChevronRight className="w-4 h-4 ml-1" />
              </Button>
            ) : (
              <Button onClick={handleSave} loading={isLoading || isUploadingLogo} loadingText="Save Toolkit">
                <Save className="w-4 h-4 mr-2" />
                Save Toolkit
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
  );
}
