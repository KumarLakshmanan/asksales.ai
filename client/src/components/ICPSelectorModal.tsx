import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import api from '@/lib/api';
import { LoadingState } from '@/components/ui/loading-state';
import { Check, Target, Users, Building2 } from 'lucide-react';

interface ICPProfile {
  id: number;
  campaignName: string;
  campaignObjective?: string;
  targetAudience?: string;
  industry?: string;
  businessId?: number;
  businessName?: string;
  fitScore?: number;
  status?: string;
  createdAt?: string;
}

interface ICPSelectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (icpId: number, icpName: string) => void;
  onCreateNew?: () => void;
}

export default function ICPSelectorModal({ 
  isOpen, 
  onClose, 
  onSelect,
  onCreateNew,
}: ICPSelectorModalProps) {
  const { toast } = useToast();
  const [icps, setIcps] = useState<ICPProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);

   
  useEffect(() => {
    if (isOpen) {
      loadICPs();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const loadICPs = async () => {
    try {
      setLoading(true);
      const response = await api.get<{ icpProfiles?: ICPProfile[], icps?: ICPProfile[] }>('/api/icp');
      const data = response.icpProfiles || response.icps || [];
      setIcps(data);
    } catch (error) {
      console.error('Failed to load ICPs:', error);
      toast({
        title: 'Error',
        description: 'Failed to load ICP profiles',
        variant: 'destructive'
      });
    } finally {
      setLoading(false);
    }
  };

  const handleSelect = () => {
    if (selectedId) {
      const icp = icps.find(i => i.id === selectedId);
      if (icp) {
        onSelect(icp.id, icp.campaignName || 'Untitled ICP');
        onClose();
      }
    }
  };

  const getFitScoreColor = (score: number = 0) => {
    if (score >= 80) return 'bg-green-500';
    if (score >= 50) return 'bg-yellow-500';
    return 'bg-red-500';
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Target className="w-5 h-5" />
            Choose ICP Profile
          </DialogTitle>
          <DialogDescription>
            Select an existing ICP profile to use for this chat session
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <LoadingState className="py-8" label="Loading ICP profiles…" />
        ) : icps.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <Target className="w-12 h-12 mx-auto mb-4 opacity-50" />
            <p>No ICP profiles found.</p>
            <p className="text-sm mt-2">Create one by starting a new chat.</p>
            {onCreateNew && (
              <Button 
                className="mt-4" 
                onClick={() => {
                  onClose();
                  onCreateNew();
                }}
              >
                Create New ICP
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-3 py-4">
            {icps.map((icp) => (
              <Card 
                key={icp.id}
                className={`cursor-pointer transition-all hover:border-primary/50 ${
                  selectedId === icp.id ? 'border-primary ring-2 ring-primary/20' : ''
                }`}
                onClick={() => setSelectedId(icp.id)}
              >
                <CardContent className="p-4">
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3">
                      <div 
                        className="w-10 h-10 rounded flex items-center justify-center text-white font-bold bg-gradient-to-br from-primary to-[#F5A5A5]"
                      >
                        <Target className="w-5 h-5" />
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium">{icp.campaignName || 'Untitled ICP'}</span>
                          {icp.fitScore !== undefined && (
                            <Badge 
                              variant="secondary" 
                              className={`text-xs text-white ${getFitScoreColor(icp.fitScore)}`}
                            >
                              {icp.fitScore}% Fit
                            </Badge>
                          )}
                          {icp.status && (
                            <Badge variant="outline" className="text-xs capitalize">
                              {icp.status}
                            </Badge>
                          )}
                        </div>
                        
                        {icp.targetAudience && (
                          <p className="text-sm text-muted-foreground mt-1 flex items-center gap-1">
                            <Users className="w-3 h-3" />
                            {icp.targetAudience.substring(0, 100)}
                            {icp.targetAudience.length > 100 && '...'}
                          </p>
                        )}
                        
                        <div className="flex items-center gap-3 text-xs text-muted-foreground mt-2">
                          {icp.industry && (
                            <span>{icp.industry}</span>
                          )}
                          {icp.businessName && (
                            <span className="flex items-center gap-1">
                              <Building2 className="w-3 h-3" />
                              {icp.businessName}
                            </span>
                          )}
                          {icp.createdAt && (
                            <span>
                              {new Date(icp.createdAt).toLocaleDateString()}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    
                    <div className="flex items-center gap-2">
                      {/* Selection indicator */}
                      {selectedId === icp.id && (
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

        <div className="flex justify-between gap-2 pt-4 border-t">
          <div>
            {onCreateNew && icps.length > 0 && (
              <Button 
                variant="outline" 
                onClick={() => {
                  onClose();
                  onCreateNew();
                }}
              >
                Create New
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button 
              onClick={handleSelect} 
              disabled={!selectedId || loading}
            >
              Use This ICP
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
