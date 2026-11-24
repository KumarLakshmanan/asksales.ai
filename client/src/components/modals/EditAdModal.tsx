import { useState, useEffect, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Callout } from '@/components/ui/callout';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import api from '@/lib/api';
import { Pencil, Save, X } from 'lucide-react';

export interface AdContent {
  id: string;
  title: string;
  content: string;
  platform: string;
}

interface EditAdForm {
  headline: string;
  primaryText: string;
  description: string;
  callToAction: string;
  callToActionType: string;
  displayUrl: string;
}

interface EditAdModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ad: AdContent | null;
  onSaveSuccess?: (updatedAd: AdContent) => void;
  children?: ReactNode;
}

const CALL_TO_ACTION_TYPES = [
  { value: 'LEARN_MORE', label: 'Learn More' },
  { value: 'SHOP_NOW', label: 'Shop Now' },
  { value: 'SIGN_UP', label: 'Sign Up' },
  { value: 'DOWNLOAD', label: 'Download' },
  { value: 'CONTACT_US', label: 'Contact Us' },
  { value: 'GET_QUOTE', label: 'Get Quote' },
  { value: 'BOOK_TRAVEL', label: 'Book Now' },
  { value: 'SUBSCRIBE', label: 'Subscribe' },
  { value: 'WATCH_MORE', label: 'Watch More' },
  { value: 'APPLY_NOW', label: 'Apply Now' },
];

export default function EditAdModal({
  open,
  onOpenChange,
  ad,
  onSaveSuccess,
  children,
}: EditAdModalProps) {
  const { toast } = useToast();
  const [isSaving, setIsSaving] = useState(false);
  const [editForm, setEditForm] = useState<EditAdForm>({
    headline: '',
    primaryText: '',
    description: '',
    callToAction: '',
    callToActionType: 'LEARN_MORE',
    displayUrl: '',
  });

  // Initialize form when ad changes
  useEffect(() => {
    if (ad) {
      let parsedContent: Record<string, string> = {};
      try {
        parsedContent = JSON.parse(ad.content);
      } catch {
        parsedContent = { primaryText: ad.content };
      }
      setEditForm({
        headline: parsedContent.headline || ad.title || '',
        primaryText: parsedContent.primaryText || parsedContent.body || '',
        description: parsedContent.description || '',
        callToAction: parsedContent.callToAction || parsedContent.call_to_action || '',
        callToActionType: parsedContent.callToActionType || 'LEARN_MORE',
        displayUrl: parsedContent.displayUrl || '',
      });
    }
  }, [ad]);

  const handleSave = async () => {
    if (!ad) return;
    setIsSaving(true);
    try {
      let existingContent: Record<string, unknown> = {};
      try {
        existingContent = JSON.parse(ad.content);
      } catch {
        existingContent = {};
      }
      
      const updatedContent = {
        ...existingContent,
        headline: editForm.headline,
        primaryText: editForm.primaryText,
        description: editForm.description,
        callToAction: editForm.callToAction,
        callToActionType: editForm.callToActionType,
        displayUrl: editForm.displayUrl,
      };

      // Update in database if it's a saved ad
      if (ad.id.startsWith('db-')) {
        const dbId = parseInt(ad.id.replace('db-', ''), 10);
        if (!isNaN(dbId)) {
          await api.put(`/api/content/assets/${dbId}`, {
            title: editForm.headline,
            content: JSON.stringify(updatedContent),
          });
        }
      }

      const updatedAd: AdContent = {
        ...ad,
        title: editForm.headline,
        content: JSON.stringify(updatedContent),
      };

      toast({
        title: 'Saved',
        description: 'Ad copy updated successfully',
      });
      
      onSaveSuccess?.(updatedAd);
      onOpenChange(false);
    } catch (error) {
      console.error('Save error:', error);
      toast({
        title: 'Error',
        description: 'Failed to save changes',
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="w-5 h-5" />
            Edit Ad Copy
          </DialogTitle>
          <DialogDescription>
            Make changes to your ad copy for Meta Ads (Facebook/Instagram).
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="edit-headline">
              Headline
              <span className="text-xs text-muted-foreground ml-2">(max 40 chars recommended)</span>
            </Label>
            <Input
              id="edit-headline"
              value={editForm.headline}
              onChange={(e) => setEditForm(prev => ({ ...prev, headline: e.target.value }))}
              placeholder="Short, punchy headline"
              maxLength={100}
            />
            <p className="text-xs text-muted-foreground text-right">
              {editForm.headline.length}/40 chars
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-primaryText">
              Primary Text
              <span className="text-xs text-muted-foreground ml-2">(appears above image)</span>
            </Label>
            <Textarea
              id="edit-primaryText"
              value={editForm.primaryText}
              onChange={(e) => setEditForm(prev => ({ ...prev, primaryText: e.target.value }))}
              placeholder="Engaging text that hooks attention..."
              rows={3}
              maxLength={500}
            />
            <p className="text-xs text-muted-foreground text-right">
              {editForm.primaryText.length}/125 chars (recommended)
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="edit-description">
              Link Description
              <span className="text-xs text-muted-foreground ml-2">(appears below headline)</span>
            </Label>
            <Input
              id="edit-description"
              value={editForm.description}
              onChange={(e) => setEditForm(prev => ({ ...prev, description: e.target.value }))}
              placeholder="Brief description of the offer"
              maxLength={100}
            />
            <p className="text-xs text-muted-foreground text-right">
              {editForm.description.length}/30 chars (recommended)
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="edit-cta-type">Call to Action Button</Label>
              <Select
                value={editForm.callToActionType}
                onValueChange={(value) => setEditForm(prev => ({ ...prev, callToActionType: value }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select CTA" />
                </SelectTrigger>
                <SelectContent>
                  {CALL_TO_ACTION_TYPES.map(cta => (
                    <SelectItem key={cta.value} value={cta.value}>
                      {cta.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-url">Display URL</Label>
              <Input
                id="edit-url"
                value={editForm.displayUrl}
                onChange={(e) => setEditForm(prev => ({ ...prev, displayUrl: e.target.value }))}
                placeholder="yoursite.com/offer"
              />
            </div>
          </div>

          <Callout tone="info" title="Meta Ads Best Practices:">
            <ul className="list-disc list-inside text-xs space-y-1">
              <li>Keep headlines short and punchy (under 40 chars)</li>
              <li>Primary text should be 125 chars or less for full visibility</li>
              <li>Use action words and create urgency</li>
              <li>Match the CTA button to your campaign objective</li>
            </ul>
          </Callout>
        </div>
        {children}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            <X className="w-4 h-4 mr-1" />
            Cancel
          </Button>
          <Button onClick={handleSave} loading={isSaving}>
            <Save className="w-4 h-4 mr-1" />
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
