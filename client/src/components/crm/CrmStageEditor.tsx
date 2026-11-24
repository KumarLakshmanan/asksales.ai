"use client";

import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ArrowDown, ArrowUp, GripVertical, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { CRM_STAGE_COLORS, CRM_STAGE_LIMIT, type CrmStage, type CrmStageType } from '@/lib/crm-configuration';

interface StageEditorProps {
  stages: CrmStage[];
  onChange: (stages: CrmStage[]) => void;
  disabled?: boolean;
}

export function CrmStageEditor({ stages, onChange, disabled = false }: StageEditorProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const move = (from: number, to: number) => {
    if (!disabled && from > 0 && to > 0 && to < stages.length) onChange(arrayMove(stages, from, to));
  };
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    if (over && active.id !== over.id) move(stages.findIndex(stage => stage.key === active.id), stages.findIndex(stage => stage.key === over.id));
  };

  return (
    <div className="space-y-3">
      <div className="hidden grid-cols-[76px_minmax(0,1fr)_130px_48px_80px_36px] items-center gap-3 px-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground md:grid">
        <span aria-hidden="true" />
        <span>Stage name</span>
        <span>Type</span>
        <span>Color</span>
        <span>In flow</span>
        <span aria-hidden="true" />
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={stages.map(stage => stage.key)} strategy={verticalListSortingStrategy}>
          <div className="space-y-2">
            {stages.map((stage, index) => (
              <StageRow key={stage.key} stage={stage} index={index} last={index === stages.length - 1} disabled={disabled}
                onChange={patch => onChange(stages.map(item => item.key === stage.key ? { ...item, ...patch } : item))}
                onRemove={() => onChange(stages.filter(item => item.key !== stage.key))}
                onMove={direction => move(index, index + direction)} />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      <Button type="button" variant="outline" disabled={disabled || stages.length >= CRM_STAGE_LIMIT}
        className="min-h-12 w-full border-dashed text-violet-600 hover:bg-violet-50 hover:text-violet-700 dark:text-violet-400 dark:hover:bg-violet-500/10"
        onClick={() => onChange([...stages, { key: `stage_${crypto.randomUUID().replaceAll('-', '')}`, label: '', type: 'active', color: CRM_STAGE_COLORS[(stages.length - 1) % CRM_STAGE_COLORS.length], inFlow: true }])}>
        <Plus className="mr-2 h-4 w-4" /> Add Stage
      </Button>
      <p className="text-xs leading-5 text-muted-foreground">The entry stage stays first. Switching off In flow excludes a stage from flow analytics; its contacts stay visible. Stages used by contacts or rules must be reassigned before removal.</p>
    </div>
  );
}

function StageRow({ stage, index, last, disabled, onChange, onRemove, onMove }: {
  stage: CrmStage;
  index: number;
  last: boolean;
  disabled: boolean;
  onChange: (patch: Partial<CrmStage>) => void;
  onRemove: () => void;
  onMove: (direction: number) => void;
}) {
  const entry = stage.key === 'new';
  const name = stage.label || `stage ${index + 1}`;
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: stage.key, disabled: entry || disabled });
  return (
    <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-xl border border-transparent bg-muted/55 p-3 md:grid-cols-[76px_minmax(0,1fr)_130px_48px_80px_36px]',
        entry && 'bg-muted/35', isDragging && 'z-10 border-violet-400 bg-card shadow-lg')}
      data-stage-key={stage.key}>
      <div className="flex items-center gap-1 md:row-auto">
        <Button ref={setActivatorNodeRef} type="button" variant="ghost" size="icon" className="h-8 w-7 touch-none text-muted-foreground"
          disabled={entry || disabled} aria-label={`Reorder ${name}`} {...attributes} {...listeners}>
          <GripVertical className="h-4 w-4" />
        </Button>
        {!entry && <div className="flex">
          <Button type="button" variant="ghost" size="icon" className="h-8 w-6" aria-label={`Move ${name} up`} disabled={disabled || index === 1} onClick={() => onMove(-1)}>
            <ArrowUp className="h-3 w-3" />
          </Button>
          <Button type="button" variant="ghost" size="icon" className="h-8 w-6" aria-label={`Move ${name} down`} disabled={disabled || last} onClick={() => onMove(1)}>
            <ArrowDown className="h-3 w-3" />
          </Button>
        </div>}
      </div>
      <div className="col-span-2 row-start-1 flex min-w-0 items-center gap-3 md:col-auto md:row-auto">
        <span className="h-3 w-3 shrink-0 rounded-full" style={{ backgroundColor: stage.color }} aria-hidden="true" />
        <Input aria-label={`Stage name ${index + 1}`} value={stage.label} placeholder="Stage name" maxLength={80} disabled={disabled}
          className="h-10 min-w-0 border-transparent bg-transparent px-2 font-medium shadow-none hover:border-border focus-visible:bg-background"
          onChange={event => onChange({ label: event.target.value })} />
      </div>
      <div className="col-span-2 flex items-center gap-3 md:col-auto md:block">
        <span className="text-xs text-muted-foreground md:hidden">Type</span>
        {entry ? <Badge variant="secondary" className="h-9 w-full rounded-lg text-xs font-semibold uppercase tracking-wider">Entry</Badge> : (
          <select aria-label={`Type for ${name}`} value={stage.type} disabled={disabled}
            className="h-10 w-full min-w-0 rounded-lg border border-border/60 bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-violet-500"
            onChange={event => onChange({ type: event.target.value as CrmStageType })}>
            <option value="active">Active</option><option value="won">Won</option><option value="lost">Lost</option>
          </select>
        )}
      </div>
      <div className="flex items-center gap-3 md:block">
        <span className="text-xs text-muted-foreground md:hidden">Color</span>
        <input type="color" aria-label={`Color for ${name}`} value={stage.color} disabled={disabled}
          className="h-10 w-10 cursor-pointer rounded-lg border border-border bg-background p-1 disabled:cursor-default"
          onChange={event => onChange({ color: event.target.value })} />
      </div>
      <div className="flex items-center gap-2 md:justify-center">
        <span className="text-xs text-muted-foreground md:hidden">In flow</span>
        <Switch aria-label={`Include ${name} in flow`} checked={stage.inFlow} disabled={disabled}
          className="data-[state=checked]:bg-violet-600" onCheckedChange={inFlow => onChange({ inFlow })} />
      </div>
      <div className="col-start-2 row-start-2 justify-self-end md:col-auto md:row-auto">
        {!entry && <Button type="button" variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          disabled={disabled} aria-label={`Remove ${name}`} onClick={onRemove}><Trash2 className="h-4 w-4" /></Button>}
      </div>
    </div>
  );
}
