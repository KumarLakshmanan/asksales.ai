/**
 * Search Settings Tab
 * Displays platform-wise generated input schemas for lead generation workflows
 * Supports table view (default) and JSON view with inline editing
 */

import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { LoadingState } from '@/components/ui/loading-state';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  AlertCircle, ChevronDown, ChevronUp,
  Play, Edit, Save, X, Trash2, TableIcon, Code, Plus,
  Linkedin, MapPin, Instagram, Facebook, Twitter, Phone, Mail, Search,
  Sparkles, ChevronRight
} from 'lucide-react';
import { api } from '@/lib/api';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';

interface SubWorkflow {
  id: string;
  title: string;
  description: string;
}

interface PlatformInput {
  id?: number;
  platform: string;
  platformDisplay?: string;
  searchIndex?: number;
  totalSearches?: number;
  inputs: Record<string, unknown>;
  example?: Record<string, unknown>;
  category?: string;
  workflowId?: string;
  actorName?: string;
  recommendedSubWorkflows?: string[];
  requestedLeadTotal?: number;
}

interface LeadsInputsTabProps {
  icpId: string;
  platforms: string[];
  icpData: unknown;
  threadId?: number;
  onSendMessage?: (message: string, bypassProcessingCheck?: boolean) => void;
  onApproval?: (approved: boolean) => void;
  approvalAvailable?: boolean;
}

type ViewMode = 'table' | 'json';

function flattenObject(obj: Record<string, unknown>, prefix = ''): Array<{ key: string; value: string; isArray: boolean; arrayIndex?: number }> {
  const result: Array<{ key: string; value: string; isArray: boolean; arrayIndex?: number }> = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(value)) {
      if (value.length === 0) {
        result.push({ key: fullKey, value: '[]', isArray: true });
      } else if (value.every(v => typeof v !== 'object' || v === null)) {
        value.forEach((item, idx) => result.push({ key: fullKey, value: String(item ?? ''), isArray: true, arrayIndex: idx }));
      } else {
        result.push({ key: fullKey, value: JSON.stringify(value, null, 2), isArray: true });
      }
    } else if (value !== null && typeof value === 'object') {
      result.push(...flattenObject(value as Record<string, unknown>, fullKey));
    } else {
      result.push({ key: fullKey, value: String(value ?? ''), isArray: false });
    }
  }
  return result;
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(obj));
  const parts = path.split('.');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let current: any = clone;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (current[part] === undefined || current[part] === null) current[part] = {};
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
  return clone;
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function formatKeyLabel(key: string): string {
  const lastPart = key.split('.').pop() || key;
  return lastPart.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase()).trim();
}

function InputTable({ inputs, editing, onInputChange }: { inputs: Record<string, unknown>; editing: boolean; onInputChange: (path: string, value: unknown) => void; }) {
  const rows = flattenObject(inputs);
  type GroupedRow = { key: string; value: string; isArray: boolean; arrayIndex?: number; items?: Array<{ value: string; index: number }>; };
  const groupedRows: GroupedRow[] = [];
  const arrayGroups: Record<string, Array<{ value: string; index: number }>> = {};
  for (const row of rows) {
    if (row.isArray && row.arrayIndex !== undefined) {
      if (!arrayGroups[row.key]) arrayGroups[row.key] = [];
      arrayGroups[row.key].push({ value: row.value, index: row.arrayIndex });
    } else { groupedRows.push(row); }
  }
  for (const [key, items] of Object.entries(arrayGroups)) {
    const insertIdx = groupedRows.findIndex(r => r.key > key);
    const entry: GroupedRow = { key, value: items.map(i => i.value).join(', '), isArray: true, items };
    if (insertIdx === -1) groupedRows.push(entry);
    else groupedRows.splice(insertIdx, 0, entry);
  }

  const handleArrayItemChange = (key: string, index: number, newValue: string) => {
    const currentArray = getNestedValue(inputs, key) as unknown[];
    if (Array.isArray(currentArray)) {
      const newArray = [...currentArray];
      const numVal = Number(newValue);
      newArray[index] = !isNaN(numVal) && newValue.trim() !== '' ? numVal : newValue;
      onInputChange(key, newArray);
    }
  };
  const handleArrayItemRemove = (key: string, index: number) => {
    const currentArray = getNestedValue(inputs, key) as unknown[];
    if (Array.isArray(currentArray)) onInputChange(key, currentArray.filter((_, i) => i !== index));
  };
  const handleArrayItemAdd = (key: string) => {
    const currentArray = getNestedValue(inputs, key) as unknown[];
    if (Array.isArray(currentArray)) onInputChange(key, [...currentArray, '']);
  };
  const handleScalarChange = (key: string, newValue: string) => {
    const original = getNestedValue(inputs, key);
    if (typeof original === 'number') { const numVal = Number(newValue); onInputChange(key, isNaN(numVal) ? newValue : numVal); }
    else if (typeof original === 'boolean') onInputChange(key, newValue === 'true');
    else onInputChange(key, newValue);
  };

  return (
    <div className="overflow-hidden rounded-xl border border-border/40 bg-card">
      <div className="grid grid-cols-1 divide-y divide-border/40">
        <div className="grid grid-cols-12 bg-muted/30 border-b border-border/40 px-4 py-2.5">
          <div className="col-span-4 text-xs text-muted-foreground">Parameter</div>
          <div className="col-span-6 text-xs text-muted-foreground">Value</div>
          {editing && <div className="col-span-2 text-right text-xs text-muted-foreground">Actions</div>}
        </div>
        {groupedRows.map((row) => (
          <div key={row.key} className="grid grid-cols-12 px-4 py-3 hover:bg-muted/20 transition-colors items-start">
            <div className="col-span-4 pr-4">
              <p className="text-xs font-medium text-foreground leading-tight">{formatKeyLabel(row.key)}</p>
              <p className="text-[10px] text-muted-foreground/50 font-mono mt-0.5">{row.key}</p>
            </div>
            <div className="col-span-6 pr-4">
              {row.items && row.items.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {row.items.map((item, idx) => (
                    <div key={idx} className="flex items-center gap-1">
                      {editing ? (
                        <div className="flex items-center gap-1.5 bg-muted/30 border border-border/40 rounded-lg px-2 py-1">
                          <Input value={item.value} onChange={(e) => handleArrayItemChange(row.key, item.index, e.target.value)} className="h-5 text-xs w-auto min-w-[60px] border-none bg-transparent p-0 focus-visible:ring-0" />
                          <button onClick={() => handleArrayItemRemove(row.key, item.index)} className="text-muted-foreground/40 hover:text-destructive transition-colors"><X className="w-3 h-3" /></button>
                        </div>
                      ) : (
                        <Badge variant="outline" className="text-[10px] rounded-md border-border/40 h-5 px-1.5">{item.value}</Badge>
                      )}
                    </div>
                  ))}
                  {editing && <button onClick={() => handleArrayItemAdd(row.key)} className="text-xs text-primary hover:bg-primary/10 px-2 py-0.5 rounded-md border border-primary/20 transition-colors flex items-center gap-1"><Plus className="w-3 h-3" /> Add</button>}
                </div>
              ) : row.isArray && row.value === '[]' ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">No values</span>
                  {editing && <button onClick={() => handleArrayItemAdd(row.key)} className="text-xs text-primary hover:bg-primary/10 px-2 py-0.5 rounded-md border border-dashed border-primary/30 transition-colors flex items-center gap-1"><Plus className="w-3 h-3" /> Init</button>}
                </div>
              ) : row.isArray ? (
                editing ? (
                  <Textarea value={row.value} onChange={(e) => { try { onInputChange(row.key, JSON.parse(e.target.value)); } catch { /* typing */ } }} className="font-mono text-xs min-h-[80px] bg-background/50 border-border/40 rounded-xl" />
                ) : (
                  <pre className="text-xs font-mono bg-muted/20 border border-border/20 rounded-lg p-2 overflow-x-auto max-h-[100px] text-muted-foreground">{row.value}</pre>
                )
              ) : (
                editing ? (
                  <Input value={row.value} onChange={(e) => handleScalarChange(row.key, e.target.value)} className="h-8 rounded-lg border-border/40 bg-background/50 text-sm" />
                ) : (
                  <p className="text-xs text-foreground/80">{row.value}</p>
                )
              )}
            </div>
            {editing && (
              <div className="col-span-2 flex justify-end">
                <Button variant="ghost" size="icon" onClick={() => onInputChange(row.key, undefined)} className="h-7 w-7 rounded-md text-muted-foreground/40 hover:text-destructive hover:bg-destructive/10">
                  <Trash2 className="w-3 h-3" />
                </Button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function SearchSettingsTab({ icpId: _icpId, platforms, icpData: _icpData, threadId, onSendMessage, onApproval, approvalAvailable = false }: LeadsInputsTabProps) {
  const [loading, setLoading] = useState(false);
  const [platformInputs, setPlatformInputs] = useState<PlatformInput[]>([]);
  const [expandedPlatforms, setExpandedPlatforms] = useState<Set<string>>(new Set());
  const [editingPlatform, setEditingPlatform] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState<string>('');
  const [editingInputs, setEditingInputs] = useState<Record<string, unknown> | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('table');
  const [hasExistingInputs, setHasExistingInputs] = useState(false);
  const [initialLoadDone, setInitialLoadDone] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [deleteConfirm, setDeleteConfirm] = useState<{ open: boolean; platform: string | null; id?: number }>({ open: false, platform: null });
  const getInputKey = (input: PlatformInput) => input.id ? String(input.id) : input.platform;
  const [platformSubWorkflows, setPlatformSubWorkflows] = useState<Record<string, SubWorkflow[]>>({});
  const [editingScrapingPlatform, setEditingScrapingPlatform] = useState<string | null>(null);
  const [editingScrapingSelection, setEditingScrapingSelection] = useState<Set<string>>(new Set());
  const { toast } = useToast();

  useEffect(() => {
    const fetchSubWorkflows = async () => {
      try {
        const data = await api.get<Record<string, Array<{ id: string; title: string; description: string }>>>('/api/workflows/sub-workflows');
        setPlatformSubWorkflows(data);
      } catch { /* fallback: empty */ }
    };
    fetchSubWorkflows();
  }, []);

  const checkExistingInputs = useCallback(async () => {
    if (!threadId) return [];
    const response = await api.get<{ hasExistingInputs: boolean; inputs?: PlatformInput[] }>(`/api/workflows/existing-inputs/${threadId}`);
    if (!response || typeof response.hasExistingInputs !== 'boolean' || (response.hasExistingInputs && !Array.isArray(response.inputs))) throw new Error('Invalid search inputs response');
    return response.hasExistingInputs ? response.inputs! : [];
  }, [threadId]);

  // Opening a result tab is read-only. Input generation is owned by the
  // conversation workflow after the client confirms its platform strategy.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    setInitialLoadDone(false);
    setPlatformInputs([]);
    setHasExistingInputs(false);
    setEditingPlatform(null);
    void checkExistingInputs().then(inputs => {
      if (cancelled) return;
      setPlatformInputs(inputs);
      setHasExistingInputs(inputs.length > 0);
    }).catch(() => {
      if (!cancelled) setLoadError(true);
    }).finally(() => {
      if (!cancelled) {
        setLoading(false);
        setInitialLoadDone(true);
      }
    });
    return () => { cancelled = true; };
  }, [checkExistingInputs, reloadVersion]);

  const handleRegenerateInputs = () => {
    if (!onSendMessage) {
      toast({ title: 'Unable to regenerate', description: 'Return to the conversation and request new provider parameters.', variant: 'destructive' });
      return;
    }

    const exactWorkflows = Array.from(new Set(platformInputs.map((input) => input.platform).filter(Boolean)));
    const exactLimit = platformInputs
      .map((input) => input.requestedLeadTotal)
      .find((limit): limit is number => typeof limit === 'number' && limit > 0);

    if (exactWorkflows.length === 0 || !exactLimit) {
      toast({ title: 'Unable to regenerate safely', description: 'The reviewed provider or global lead cap is missing. Request new inputs from the conversation.', variant: 'destructive' });
      return;
    }

    onSendMessage(`Regenerate the reviewed lead inputs using only ${exactWorkflows.join(', ')}. Keep the same ICP, geography, and industry targeting, enforce a global cap of exactly ${exactLimit} leads across all selected providers, and show the exact provider parameters for review before execution.`);
    toast({ title: 'Regeneration requested', description: 'The existing parameters remain available until replacements are reviewed.' });
  };

  const togglePlatformExpand = (key: string) => {
    setExpandedPlatforms(prev => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  };

  const handleStartEdit = (platformInput: PlatformInput) => {
    const key = getInputKey(platformInput);
    setEditingPlatform(key);
    setEditingValue(JSON.stringify(platformInput.inputs, null, 2));
    setEditingInputs(platformInput.inputs);
    setExpandedPlatforms(prev => new Set([...prev, key]));
  };

  const handleTableInputChange = (path: string, value: unknown) => {
    if (!editingInputs) return;
    const updated = setNestedValue(editingInputs, path, value);
    setEditingInputs(updated);
    setEditingValue(JSON.stringify(updated, null, 2));
  };

  const handleJsonEdit = (newJson: string) => {
    setEditingValue(newJson);
    try { setEditingInputs(JSON.parse(newJson)); } catch { /* typing */ }
  };

  const handleSaveEdit = async (platform: string, id?: number) => {
    try {
      const parsedInputs = viewMode === 'table' ? editingInputs : JSON.parse(editingValue);
      if (threadId) await api.put(`/api/chat/threads/${threadId}/lead-inputs`, { id, platform, inputs: parsedInputs });
      setPlatformInputs((prev) => prev.map((item) => (id && item.id === id) || (!id && item.platform === platform) ? { ...item, inputs: parsedInputs } : item));
      setEditingPlatform(null); setEditingValue(''); setEditingInputs(null);
      toast({ title: 'Saved', description: `${platform} inputs updated successfully` });
    } catch (error) {
      toast({ title: error instanceof SyntaxError ? 'Invalid JSON' : 'Save Failed', description: error instanceof SyntaxError ? 'Please ensure the JSON is valid' : 'Failed to save inputs', variant: 'destructive' });
    }
  };

  const handleCancelEdit = () => { setEditingPlatform(null); setEditingValue(''); setEditingInputs(null); };

  const handleDeletePlatform = async (platform: string, id?: number) => {
    setDeleteConfirm({ open: false, platform: null });
    try {
      if (threadId) { const deleteParam = id ? String(id) : platform; await api.delete(`/api/chat/threads/${threadId}/lead-inputs/${deleteParam}`); }
      setPlatformInputs((prev) => id ? prev.filter((item) => item.id !== id) : prev.filter((item) => item.platform !== platform));
      toast({ title: 'Deleted', description: `${platform} inputs removed successfully` });
    } catch { toast({ title: 'Delete Failed', description: 'Failed to delete platform inputs', variant: 'destructive' }); }
  };

  const getPlatformIcon = (platform: string) => {
    const iconClass = 'w-4 h-4';
    const iconMap: Record<string, React.ReactNode> = {
      linkedin: <Linkedin className={`${iconClass} text-blue-600`} />,
      google_maps: <MapPin className={`${iconClass} text-red-500`} />,
      google: <MapPin className={`${iconClass} text-red-500`} />,
      instagram: <Instagram className={`${iconClass} text-pink-500`} />,
      facebook: <Facebook className={`${iconClass} text-blue-500`} />,
      twitter: <Twitter className={`${iconClass} text-sky-500`} />,
      justdial: <Phone className={`${iconClass} text-yellow-600`} />,
      email: <Mail className={`${iconClass} text-orange-500`} />,
    };
    const key = platform.toLowerCase();
    if (iconMap[key]) return iconMap[key];
    const baseChannel = key.split('_')[0];
    return iconMap[baseChannel] || <Search className={`${iconClass} text-muted-foreground`} />;
  };

  const handleStartLeadGeneration = async () => {
    if (!approvalAvailable) return;
    const allPlatforms = platformInputs.map(p => p.platform);
    if (allPlatforms.length > 0 && threadId) {
      if (!onApproval) {
        toast({ title: 'Approval unavailable', description: 'Return to the conversation and approve the reviewed inputs there.', variant: 'destructive' });
        return;
      }
      setLoading(true);
      try {
        await onApproval(true);
        // The approval handler reports the actual receipt. Returning from the
        // callback alone does not prove that a search was queued or succeeded.
      } catch (error: unknown) {
        toast({
          title: 'Lead generation was not started',
          description: error instanceof Error ? error.message : 'The approval could not be resumed. Return to the conversation and try again.',
          variant: 'destructive',
        });
      } finally {
        setLoading(false);
      }
    }
  };

  if (loadError) {
    return <div role="alert" className="p-8 text-center space-y-3">
      <p>Could not load saved search inputs. This is a loading error, not missing parameters.</p>
      <Button variant="outline" onClick={() => setReloadVersion(value => value + 1)}>Retry loading search inputs</Button>
    </div>;
  }

  if ((!platforms || platforms.length === 0) && platformInputs.length === 0 && initialLoadDone) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center">
          <AlertCircle className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-sm font-medium">No platforms configured</p>
          <p className="text-xs text-muted-foreground mt-1">Configure platforms in your ICP profile</p>
        </div>
      </div>
    );
  }

  if (loading && platformInputs.length === 0) {
    return (
      <LoadingState label="Loading saved search parameters..." showLabel className="h-full" />
    );
  }

  if (initialLoadDone && platformInputs.length === 0) {
    return (
      <div className="h-full flex items-center justify-center p-8">
        <div className="max-w-sm text-center">
          <Search className="w-10 h-10 text-muted-foreground/30 mx-auto mb-3" />
          <p className="text-sm font-medium">No reviewed search inputs yet</p>
          <p className="text-xs text-muted-foreground mt-1">Confirm the lead platforms in the conversation. Marcus will generate and save the provider inputs before this tab opens them.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-background overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b bg-card flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
            <Search className="w-4 h-4 text-primary" />
          </div>
          <div>
            <p className="text-sm font-semibold">Search Parameters</p>
            <p className="text-xs text-muted-foreground">{platformInputs.length} search{platformInputs.length !== 1 ? 'es' : ''} configured</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as ViewMode)}>
            <TabsList className="h-8 bg-muted/40 p-1 rounded-lg">
              <TabsTrigger value="table" className="h-6 px-2.5 rounded-md text-xs gap-1.5 data-[state=active]:bg-background data-[state=active]:shadow-sm"><TableIcon className="w-3 h-3" /> Table</TabsTrigger>
              <TabsTrigger value="json" className="h-6 px-2.5 rounded-md text-xs gap-1.5 data-[state=active]:bg-background data-[state=active]:shadow-sm"><Code className="w-3 h-3" /> JSON</TabsTrigger>
            </TabsList>
          </Tabs>
          {hasExistingInputs && (
            <Button onClick={handleRegenerateInputs} loading={loading} loadingText="Regenerate" size="sm" variant="outline" className="h-8 px-3 rounded-lg text-xs gap-1.5 border-border/60">
              <Sparkles className="w-3.5 h-3.5" />
              Regenerate
            </Button>
          )}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-3 space-y-2">
        {platformInputs.map((platformInput) => {
          const inputKey = getInputKey(platformInput);
          const isExpanded = expandedPlatforms.has(inputKey);
          const isEditing = editingPlatform === inputKey;
          const fieldCount = flattenObject(platformInput.inputs).length;
          const platformKey = platformInput.platform.toLowerCase().split('_')[0];
          const subWorkflows = platformSubWorkflows[platformKey];
          const displayLabel = platformInput.category || platformInput.platformDisplay || platformInput.platform.replace(/_/g, ' ');
          const providerMaxResults = platformInput.inputs.maxResults;
          const providerFetchExceedsSaveCap =
            typeof providerMaxResults === 'number' &&
            typeof platformInput.requestedLeadTotal === 'number' &&
            providerMaxResults > platformInput.requestedLeadTotal;

          return (
            <div key={inputKey} className="border border-border/40 bg-card rounded-xl shadow-sm overflow-hidden">
              {/* Platform header row */}
              <div className="flex items-center gap-3 px-4 py-3">
                <button className="flex items-center gap-3 flex-1 min-w-0 text-left" onClick={() => togglePlatformExpand(inputKey)}>
                  <div className="w-8 h-8 rounded-lg bg-secondary/50 flex items-center justify-center shrink-0 border border-border/40">
                    {getPlatformIcon(platformInput.platform)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium capitalize truncate">{displayLabel}</p>
                      {platformInput.searchIndex !== undefined && (
                        <Badge variant="outline" className="text-[10px] rounded-md border-border/40 h-4 px-1 shrink-0">{platformInput.searchIndex + 1}/{platformInput.totalSearches}</Badge>
                      )}
                      {platformInput.requestedLeadTotal !== undefined && (
                        <Badge variant="outline" className="h-4 shrink-0 rounded-md border-emerald-500/30 bg-emerald-500/5 px-1.5 text-[10px] text-emerald-600 dark:text-emerald-400">
                          Saved lead cap: {platformInput.requestedLeadTotal} lead{platformInput.requestedLeadTotal === 1 ? '' : 's'}
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">{fieldCount} parameter{fieldCount !== 1 ? 's' : ''}</p>
                    {providerFetchExceedsSaveCap && (
                      <p role="note" className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                        Provider request limit: {providerMaxResults}. The global cap saves up to {platformInput.requestedLeadTotal} leads across selected providers; provider usage may be higher.
                      </p>
                    )}
                  </div>
                </button>
                <div className="flex items-center gap-1 shrink-0">
                  {isEditing ? (
                    <>
                      <Button size="sm" onClick={() => handleSaveEdit(platformInput.platform, platformInput.id)} className="h-7 px-2.5 rounded-lg text-xs gap-1.5"><Save className="w-3 h-3" /> Save</Button>
                      <Button size="sm" variant="ghost" onClick={handleCancelEdit} className="h-7 px-2 rounded-lg"><X className="w-3.5 h-3.5" /></Button>
                    </>
                  ) : (
                    <>
                      <Button size="sm" variant="ghost" onClick={() => handleStartEdit(platformInput)} className="h-7 w-7 p-0 rounded-lg"><Edit className="w-3.5 h-3.5" /></Button>
                      <Button size="sm" variant="ghost" onClick={() => setDeleteConfirm({ open: true, platform: platformInput.platform, id: platformInput.id })} className="h-7 w-7 p-0 rounded-lg text-destructive/60 hover:text-destructive hover:bg-destructive/10"><Trash2 className="w-3.5 h-3.5" /></Button>
                    </>
                  )}
                  <button onClick={() => togglePlatformExpand(inputKey)} className="text-muted-foreground/40 hover:text-muted-foreground transition-colors p-1">
                    {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {/* Expanded content */}
              {isExpanded && (
                <div className="border-t border-border/40 p-3 bg-muted/10 space-y-3">
                  {/* Sub-workflow tags */}
                  {subWorkflows?.length > 0 && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs text-muted-foreground">Search type:</span>
                      {subWorkflows.filter(sw => sw.id === platformInput.platform).map((sw) => (
                        <Badge key={sw.id} variant="outline" className="text-[10px] rounded-md border-primary/30 bg-primary/5 text-primary h-5 px-2">{sw.title}</Badge>
                      ))}
                      {!subWorkflows.some(sw => sw.id === platformInput.platform) && (
                        <Badge variant="outline" className="text-[10px] rounded-md border-primary/30 bg-primary/5 text-primary h-5 px-2">{displayLabel}</Badge>
                      )}
                      {subWorkflows?.length > 0 && (
                        <Button size="sm" variant="ghost" onClick={() => { setEditingScrapingPlatform(platformInput.platform); setEditingScrapingSelection(new Set([platformInput.platform])); }} className="h-5 px-2 text-[10px] rounded-md gap-1 text-muted-foreground hover:text-foreground">
                          <Edit className="w-3 h-3" /> Edit
                        </Button>
                      )}
                    </div>
                  )}

                  {/* Input table or JSON */}
                  {isEditing ? (
                    viewMode === 'table' ? (
                      <InputTable inputs={editingInputs || platformInput.inputs} editing={true} onInputChange={handleTableInputChange} />
                    ) : (
                      <Textarea value={editingValue} onChange={(e) => handleJsonEdit(e.target.value)} className="font-mono text-xs min-h-[200px] bg-background border-border/40 rounded-xl" />
                    )
                  ) : (
                    viewMode === 'table' ? (
                      <InputTable inputs={platformInput.inputs} editing={false} onInputChange={() => {}} />
                    ) : (
                      <div className="relative">
                        <CopyButton value={() => JSON.stringify(platformInput.inputs, null, 2)} iconOnly label="Copy parameters" size="sm" variant="ghost" className="absolute top-2 right-2 h-6 w-6 p-0 rounded-md z-10" />
                        <ScrollArea className="h-[180px]">
                          <pre className="font-mono text-xs text-muted-foreground p-3 bg-muted/20 rounded-xl">{JSON.stringify(platformInput.inputs, null, 2)}</pre>
                        </ScrollArea>
                      </div>
                    )
                  )}

                  {/* Example */}
                  {platformInput.example && (
                    <details className="group">
                      <summary className="text-xs text-muted-foreground cursor-pointer select-none flex items-center gap-1.5 hover:text-foreground transition-colors">
                        <ChevronRight className="w-3 h-3 group-open:rotate-90 transition-transform" /> Example output
                      </summary>
                      <div className="mt-2 border border-border/30 rounded-lg p-3 bg-card relative">
                        <Badge variant="outline" className="absolute top-2 right-2 text-[10px] rounded-md border-border/40 text-muted-foreground/40">JSON</Badge>
                        <ScrollArea className="h-[150px]">
                          <pre className="text-xs font-mono text-muted-foreground/60 leading-relaxed">{JSON.stringify(platformInput.example, null, 2)}</pre>
                        </ScrollArea>
                      </div>
                    </details>
                  )}
                </div>
              )}
            </div>
          );
        })}

        {/* Start Lead Generation CTA */}
        {platformInputs.length > 0 && (
          <div className="border border-primary/20 bg-primary/5 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                <Play className="w-4 h-4 text-primary fill-primary/20" />
              </div>
              <div>
                <p className="text-sm font-medium">{platformInputs.length} search{platformInputs.length !== 1 ? 'es' : ''} {approvalAvailable ? 'ready for review' : 'saved · no active approval'}</p>
                <p className="text-xs text-muted-foreground">{approvalAvailable ? 'Review the parameters before approving. Search uses credits.' : 'This review is no longer active. Ask the agent to prepare fresh settings before running a search.'}</p>
              </div>
            </div>
            {approvalAvailable && <Button onClick={handleStartLeadGeneration} loading={loading} loadingText="Approve & Run Search" size="sm" className="h-8 px-4 rounded-lg text-xs gap-1.5 shrink-0">
              <ChevronRight className="w-3.5 h-3.5" />
              Approve & Run Search
            </Button>}
          </div>
        )}
      </div>

      {/* Delete Confirmation Dialog */}
      <ConfirmDialog open={deleteConfirm.open} onOpenChange={(open) => !open && setDeleteConfirm({ open: false, platform: null })}
        title="Remove Platform" description={`Are you sure you want to remove the search settings for ${deleteConfirm.platform}? This action cannot be undone.`}
        confirmText="Remove" onConfirm={() => deleteConfirm.platform && handleDeletePlatform(deleteConfirm.platform, deleteConfirm.id)} />

      {/* Sub-workflows Selection Dialog */}
      <Dialog open={!!editingScrapingPlatform} onOpenChange={(open) => !open && setEditingScrapingPlatform(null)}>
        <DialogContent className="max-w-md rounded-xl">
          <DialogHeader>
            <DialogTitle className="text-base font-semibold">Adjust Search</DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">Choose one search strategy. Changing it regenerates provider-specific parameters for review.</DialogDescription>
          </DialogHeader>
          {(() => {
            const platform = editingScrapingPlatform?.toLowerCase() || '';
            const workflows = platformSubWorkflows[platform] || [];
            return (
              <div className="space-y-3">
                <div className="space-y-2 max-h-[300px] overflow-auto">
                  {workflows.map((sw) => {
                    const isSelected = editingScrapingSelection.has(sw.id);
                    return (
                      <div key={sw.id} className={cn("flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-colors", isSelected ? "bg-primary/10 border-primary/30" : "border-border/40 hover:border-primary/20 hover:bg-muted/20")}
                        onClick={() => setEditingScrapingSelection(new Set([sw.id]))}>
                        <Checkbox checked={isSelected} className="mt-0.5 data-[state=checked]:bg-primary data-[state=checked]:border-primary" onCheckedChange={() => {}} />
                        <div>
                          <p className="text-sm font-medium">{sw.title}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">{sw.description}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="flex gap-2 pt-1">
                  <Button variant="ghost" size="sm" className="flex-1 h-8 rounded-lg text-xs" onClick={() => setEditingScrapingPlatform(null)}>Cancel</Button>
                  <Button size="sm" className="flex-1 h-8 rounded-lg text-xs gap-1.5" disabled={editingScrapingSelection.size !== 1} onClick={() => {
                    const platform = editingScrapingPlatform;
                    const selected = Array.from(editingScrapingSelection);
                    const targetInput = platformInputs.find(input => input.platform === platform);
                    const selectedWorkflow = selected[0];
                    if (!targetInput || !selectedWorkflow) return;
                    if (selectedWorkflow === targetInput.platform) {
                      setEditingScrapingPlatform(null);
                      return;
                    }
                    if (!onSendMessage) {
                      toast({ title: 'Unable to regenerate', description: 'Return to the conversation and request this search strategy.', variant: 'destructive' });
                      return;
                    }
                    const exactLimit = targetInput.requestedLeadTotal || 5;
                    onSendMessage(`Regenerate the reviewed lead inputs using only ${selectedWorkflow}. Keep the same ICP, geography, and industry targeting, enforce a global cap of exactly ${exactLimit} leads, and show the exact provider parameters for review before execution.`);
                    toast({ title: 'Regeneration requested', description: 'The provider-specific parameters must be reviewed again before execution.' });
                    setEditingScrapingPlatform(null);
                  }}>
                    <Sparkles className="w-3.5 h-3.5" /> Regenerate
                  </Button>
                </div>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>
    </div>
  );
}
