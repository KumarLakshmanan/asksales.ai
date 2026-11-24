import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import api from '@/lib/api';
import { normalizeUploadUrl } from '@/lib/utils';
import { LoadingState } from '@/components/ui/loading-state';
import { Check, Palette, Star } from 'lucide-react';

interface BrandToolkit {
  id: number;
  name: string; // Database uses 'name' not 'brandName'
  tagline?: string;
  primaryBrandColor?: string;
  secondaryBrandColor?: string;
  logoUrl?: string;
  isDefault?: boolean;
}

interface BrandToolkitSelectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (toolkitId: number, toolkitName: string) => void;
}

export default function BrandToolkitSelectorModal({ 
  isOpen, 
  onClose, 
  onSelect 
}: BrandToolkitSelectorModalProps) {
  const { toast } = useToast();
  const [toolkits, setToolkits] = useState<BrandToolkit[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);

   
  useEffect(() => {
    if (isOpen) {
      loadToolkits();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const loadToolkits = async () => {
    try {
      setLoading(true);
      const response = await api.get<BrandToolkit[]>('/api/content/brand-toolkits');
      const data = Array.isArray(response) ? response : [];
      setToolkits(data);
      
      // Pre-select default if exists
      const defaultToolkit = data.find(t => t.isDefault);
      if (defaultToolkit) {
        setSelectedId(defaultToolkit.id);
      }
    } catch (error) {
      console.error('Failed to load brand toolkits:', error);
      toast({
        title: 'Error',
        description: 'Failed to load brand toolkits',
        variant: 'destructive'
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSelect = () => {
    if (selectedId) {
      const toolkit = toolkits.find(t => t.id === selectedId);
      if (toolkit) {
        onSelect(toolkit.id, toolkit.name);
        onClose();
      }
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Palette className="w-5 h-5" />
            Choose Brand Toolkit
          </DialogTitle>
          <DialogDescription>
            Select a brand toolkit to use for your content and campaigns
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <LoadingState className="py-8" label="Loading brand toolkits…" />
        ) : toolkits.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Palette className="w-12 h-12 mx-auto mb-4 opacity-50" />
            <p>No brand toolkits found.</p>
            <p className="text-sm mt-2">Create one first to continue.</p>
          </div>
        ) : (
          <div className="space-y-3 py-4">
            {toolkits.map((toolkit) => (
              <Card 
                key={toolkit.id}
                className={`cursor-pointer transition-all hover:border-primary/50 ${
                  selectedId === toolkit.id ? 'border-primary ring-2 ring-primary/20' : ''
                }`}
                onClick={() => setSelectedId(toolkit.id)}
              >
                <CardContent className="p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      {toolkit.logoUrl ? (
                        <img 
                          src={normalizeUploadUrl(toolkit.logoUrl)}
                          alt={toolkit.name} 
                          className="w-10 h-10 object-contain rounded"
                        />
                      ) : (
                        <div 
                          className="w-10 h-10 rounded flex items-center justify-center text-white font-bold"
                          style={{ backgroundColor: toolkit.primaryBrandColor || '#3B82F6' }}
                        >
                          {toolkit.name?.charAt(0)?.toUpperCase() || '?'}
                        </div>
                      )}
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{toolkit.name}</span>
                          {toolkit.isDefault && (
                            <Badge variant="secondary" className="text-xs">
                              <Star className="w-3 h-3 mr-1" />
                              Default
                            </Badge>
                          )}
                        </div>
                        {toolkit.tagline && (
                          <p className="text-sm text-muted-foreground">{toolkit.tagline}</p>
                        )}
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-2">
                      {/* Color preview */}
                      <div className="flex gap-1">
                        {toolkit.primaryBrandColor && (
                          <div 
                            className="w-4 h-4 rounded-full border"
                            style={{ backgroundColor: toolkit.primaryBrandColor }}
                          />
                        )}
                        {toolkit.secondaryBrandColor && (
                          <div 
                            className="w-4 h-4 rounded-full border"
                            style={{ backgroundColor: toolkit.secondaryBrandColor }}
                          />
                        )}
                      </div>
                      
                      {/* Selection indicator */}
                      {selectedId === toolkit.id && (
                        <div className="w-6 h-6 rounded-full bg-primary flex items-center justify-center">
                          <Check className="w-4 h-4 text-white" />
                        </div>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-4 border-t">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button 
            onClick={handleSelect} 
            disabled={!selectedId || loading}
          >
            Use This Toolkit
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
