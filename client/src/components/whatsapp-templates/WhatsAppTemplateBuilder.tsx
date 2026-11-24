"use client";

import { useState, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  defaultKeyboardCoordinateGetter,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ArrowDown,
  ArrowUp,
  BadgeCheck,
  ChevronDown,
  ExternalLink,
  FileText,
  GripVertical,
  Image as ImageIcon,
  KeyRound,
  Megaphone,
  Phone,
  Plus,
  Reply,
  Trash2,
  Type,
  Video,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { whatsappButtonErrors } from "@/lib/whatsapp-template-validation";
import type { WhatsAppButtonType, WhatsAppDraftButton, WhatsAppHeaderType, WhatsAppTemplateButton, WhatsAppTemplateCategory } from "./templateData";

export const whatsappCategoryOptions = [
  { value: "MARKETING" as const, label: "Marketing", icon: Megaphone, description: "Offers, announcements and promotions." },
  { value: "UTILITY" as const, label: "Utility", icon: BadgeCheck, description: "Order updates, reminders and account alerts." },
  { value: "AUTHENTICATION" as const, label: "Authentication", icon: KeyRound, description: "Account verification and one-time passwords." },
];
const headerOptions = [
  { value: "TEXT" as const, label: "Text header", icon: Type },
  { value: "IMAGE" as const, label: "Image header", icon: ImageIcon },
  { value: "VIDEO" as const, label: "Video header", icon: Video },
  { value: "DOCUMENT" as const, label: "Document header", icon: FileText },
];
const buttonOptions = [
  { value: "QUICK_REPLY" as const, label: "Quick reply", icon: Reply },
  { value: "URL" as const, label: "URL button", icon: ExternalLink },
  { value: "PHONE_NUMBER" as const, label: "Phone call", icon: Phone },
];

export function WhatsAppEditorSection({ id, title, note, actions, children }: { id?: string; title: string; note?: string; actions?: ReactNode; children: ReactNode }) {
  return <section id={id} aria-label={`${title} section`} className="wa-editor-section min-w-0 overflow-hidden rounded-lg border border-card-border bg-card">
    <div className="flex min-h-11 flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2">
      <h2 id={id ? `${id}-title` : undefined} tabIndex={id ? -1 : undefined} className="text-sm font-semibold outline-none">{title}</h2>
      <div className="flex items-center gap-2">{note && <span className="text-xs text-muted-foreground">{note}</span>}{actions}</div>
    </div>
    <div className="p-4">{children}</div>
  </section>;
}

function PaletteItem({ id, kind, type, label, icon: Icon, selected, disabled, onAdd }: {
  id: string;
  kind: "header" | "palette-button";
  type: string;
  label: string;
  icon: LucideIcon;
  selected?: boolean;
  disabled: boolean;
  onAdd: () => void;
}) {
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, isDragging } = useDraggable({ id, data: { kind, type, label }, disabled });
  const controlLabel = label.startsWith("URL") ? label : label.toLowerCase();
  return <div ref={setNodeRef} className={cn("flex min-w-0 items-center rounded-[10px] border bg-card transition-colors", selected ? "border-primary/50 bg-primary/5" : "border-border", isDragging && "opacity-40", disabled && "opacity-50")}>
    <button type="button" disabled={disabled} aria-label={`Add ${controlLabel}`} aria-pressed={selected} onClick={onAdd} className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-l-[10px] px-2 text-left text-xs font-medium hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed">
      <Icon className={cn("h-4 w-4 shrink-0", selected ? "text-primary" : "text-muted-foreground")} /><span>{label}</span>
    </button>
    <button ref={setActivatorNodeRef} type="button" {...attributes} {...listeners} aria-label={`Drag ${controlLabel}`} disabled={disabled} className="flex h-11 w-11 shrink-0 touch-none items-center justify-center rounded-r-[10px] text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed"><GripVertical className="h-3.5 w-3.5" /></button>
  </div>;
}

function DropTarget({ kind, children, disabled }: { kind: "header" | "buttons"; children: ReactNode; disabled: boolean }) {
  const { setNodeRef, isOver, active } = useDroppable({ id: `${kind}-drop`, data: { kind }, disabled });
  const matchingDrag = kind === "header" ? active?.data.current?.kind === "header" : ["button", "palette-button"].includes(active?.data.current?.kind);
  return <div ref={setNodeRef} data-testid={`${kind}-drop-target`} className={cn("min-w-0 rounded-[14px] transition-shadow", matchingDrag && "ring-1 ring-primary/30", isOver && matchingDrag && "ring-2 ring-primary")}>{children}</div>;
}

const builderCollisions: CollisionDetection = (args) => {
  const headerDrag = args.active.data.current?.kind === "header";
  const allowed = args.droppableContainers.filter((container) => headerDrag
    ? container.data.current?.kind === "header"
    : ["buttons", "button"].includes(container.data.current?.kind));
  const filtered = { ...args, droppableContainers: allowed };
  if (!args.pointerCoordinates) return closestCenter(filtered);
  const collisions = pointerWithin(filtered);
  const rows = collisions.filter((collision) => collision.id !== "buttons-drop");
  return rows.length ? rows : collisions;
};

export function WhatsAppTemplateBuilder({
  category, headerType, onHeaderTypeChange, buttons, onAddButton, onMoveButton,
  disabled, general, header, body, examples, footer, buttonEditor, ai, preview, readiness,
  mobileTab, onMobileTabChange,
}: {
  category: WhatsAppTemplateCategory;
  onCategoryChange: (category: WhatsAppTemplateCategory) => void;
  categoryLocked: boolean;
  headerType: WhatsAppHeaderType;
  onHeaderTypeChange: (type: WhatsAppHeaderType) => void;
  buttons: WhatsAppDraftButton[];
  onAddButton: (type: WhatsAppButtonType) => void;
  onMoveButton: (from: string, to: string) => void;
  disabled: boolean;
  general: ReactNode;
  header: ReactNode;
  body: ReactNode;
  examples: ReactNode;
  footer: ReactNode;
  buttonEditor: ReactNode;
  ai: ReactNode;
  preview: ReactNode;
  readiness?: ReactNode;
  mobileTab: "editor" | "preview";
  onMobileTabChange: (tab: "editor" | "preview") => void;
}) {
  const [paletteExpanded, setPaletteExpanded] = useState(false);
  const [dragLabel, setDragLabel] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: (event, args) => {
      if (args.context.active?.data.current?.kind !== "button") return defaultKeyboardCoordinateGetter(event, args);
      // Only button rows are keyboard sorting destinations. Section drop zones
      // are for the palette and must not intercept an arrow-key move.
      const droppableRects = new Map([...args.context.droppableRects].filter(([id]) => args.context.droppableContainers.get(id)?.data.current?.kind === "button"));
      return sortableKeyboardCoordinates(event, { ...args, context: { ...args.context, droppableRects } });
    } }),
  );
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    setDragLabel(null);
    if (disabled || !over) return;
    const data = active.data.current;
    if (data?.kind === "header" && over.data.current?.kind === "header") onHeaderTypeChange(data.type);
    if (data?.kind === "palette-button" && ["buttons", "button"].includes(over.data.current?.kind) && buttons.length < 3) onAddButton(data.type);
    if (data?.kind === "button") {
      const target = over.data.current?.kind === "button" ? String(over.id) : buttons.at(-1)?.id;
      if (target && target !== active.id) onMoveButton(String(active.id), target);
    }
    if (data?.kind === "header" || data?.kind === "palette-button") setPaletteExpanded(false);
  };
  const palette = <div className="space-y-5 p-3">
    <div>
      <h2 className="mb-2 text-xs font-semibold text-muted-foreground">Header <span className="font-normal">· Choose one</span></h2>
      <div className="grid grid-cols-2 gap-2">{headerOptions.map(({ value, label, icon }) => <PaletteItem key={value} id={`palette-header-${value}`} kind="header" type={value} label={label} icon={icon} selected={headerType === value} disabled={disabled} onAdd={() => { onHeaderTypeChange(value); setPaletteExpanded(false); }} />)}</div>
    </div>
    <div>
      <h2 className="mb-2 text-xs font-semibold text-muted-foreground">Buttons <span className="font-normal">· {buttons.length}/3</span></h2>
      <div className="grid gap-2 sm:grid-cols-3">{buttonOptions.map(({ value, label, icon }) => <PaletteItem key={value} id={`palette-button-${value}`} kind="palette-button" type={value} label={label} icon={icon} disabled={disabled || buttons.length >= 3} onAdd={() => { onAddButton(value); setPaletteExpanded(false); }} />)}</div>
      <p className="mt-3 text-xs leading-5 text-muted-foreground">Click to add, or drag a handle into the matching section.</p>
    </div>
  </div>;

  return <DndContext sensors={sensors} collisionDetection={builderCollisions} accessibility={{
    screenReaderInstructions: { draggable: "Press Space to pick up a component. Use the arrow keys to move it, Space to drop it, or Escape to cancel. Buttons can also be reordered using Move up and Move down." },
    announcements: {
      onDragStart: ({ active }) => `Picked up ${active.data.current?.label || "button"}.`,
      onDragOver: ({ active, over }) => {
        if (!over) return;
        const position = buttons.findIndex((button) => button.id === over.id);
        return position >= 0 ? `${active.data.current?.label || "Button"} at button position ${position + 1} of ${buttons.length}.`
          : `${active.data.current?.label || "Component"} over the ${over.data.current?.kind === "header" ? "header" : "buttons"} section.`;
      },
      onDragEnd: ({ active, over }) => `${active.data.current?.label || "Component"} ${over ? "dropped" : "returned to its original position"}.`,
      onDragCancel: () => "Drag cancelled. The template is unchanged.",
    },
  }} onDragStart={({ active }) => setDragLabel(active.data.current?.label || "Move button")} onDragCancel={() => setDragLabel(null)} onDragEnd={handleDragEnd}>
    <div id="whatsapp-builder-panels" role="tablist" aria-label="Builder panels" className="sticky top-0 z-[1] mb-4 grid grid-cols-2 rounded-[10px] border bg-background p-1 xl:hidden">
      {(["editor", "preview"] as const).map((tab) => <button key={tab} type="button" role="tab" id={`builder-${tab}-tab`} aria-controls={`builder-${tab}-panel`} aria-selected={mobileTab === tab} tabIndex={mobileTab === tab ? 0 : -1} onClick={() => onMobileTabChange(tab)} onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const next = event.key === "Home" ? "editor" : event.key === "End" ? "preview" : tab === "editor" ? "preview" : "editor";
        onMobileTabChange(next);
        document.getElementById(`builder-${next}-tab`)?.focus();
      }} className={cn("min-h-11 rounded-md text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", mobileTab === tab ? "bg-card text-foreground shadow-sm" : "text-muted-foreground")}>{tab === "editor" ? "Editor" : "Preview"}</button>)}
    </div>
    <div className="grid items-start gap-3 xl:grid-cols-[minmax(0,1.65fr)_minmax(320px,0.85fr)]">
      <div id="builder-editor-panel" role="tabpanel" aria-labelledby="builder-editor-tab" className={cn("min-w-0 space-y-3", mobileTab !== "editor" && "hidden xl:block")}>
        {general}{body}{examples}
        {category !== "AUTHENTICATION" && <aside aria-label="Template components" className="wa-component-group overflow-hidden rounded-lg border bg-card">
          <button type="button" aria-expanded={paletteExpanded} aria-controls="whatsapp-component-palette" onClick={() => setPaletteExpanded(expanded => !expanded)} className="flex min-h-11 w-full items-center justify-between rounded-xl px-4 py-3 text-sm font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">Template components<ChevronDown className={cn("h-4 w-4 transition-transform", paletteExpanded && "rotate-180")} /></button>
          <div id="whatsapp-component-palette" className={cn(!paletteExpanded && "hidden")}>{palette}</div>
          <div className="space-y-3 border-t p-3">
            <DropTarget kind="header" disabled={disabled}>{header}</DropTarget>
            {footer}<DropTarget kind="buttons" disabled={disabled}>{buttonEditor}</DropTarget>
          </div>
        </aside>}
        {ai}
      </div>
      <aside id="builder-preview-panel" role="tabpanel" aria-labelledby="builder-preview-tab" className={cn("min-w-0 xl:sticky xl:top-4", mobileTab !== "preview" && "hidden xl:block")}>
        <section className="overflow-hidden rounded-lg border bg-card" aria-label="Template preview">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3"><h2 className="text-sm font-semibold">Template preview</h2><span className="rounded bg-muted px-2 py-1 text-[11px] text-muted-foreground">Preview only · not sent</span></div>
          <div className="wa-builder-preview">{preview}</div>
        </section>
        {readiness && <div className="mt-3">{readiness}</div>}
      </aside>
    </div>
    <DragOverlay>{dragLabel && <div className="rounded-[10px] border border-primary/40 bg-card px-4 py-3 text-sm font-medium shadow-md">{dragLabel}</div>}</DragOverlay>
  </DndContext>;
}

type ButtonEditorProps = {
  buttons: WhatsAppDraftButton[];
  disabled: boolean;
  valid: boolean;
  sortable?: boolean;
  onAdd: () => void;
  onUpdate: (id: string, patch: Partial<WhatsAppTemplateButton>) => void;
  onRemove: (id: string) => void;
  onMove: (from: string, to: string) => void;
};

function ButtonFields({ button, index, buttons, disabled, onUpdate, onRemove, onMove, dragHandle }: ButtonEditorProps & { button: WhatsAppDraftButton; index: number; dragHandle?: ReactNode }) {
  const fieldClassName = "min-h-11 w-full min-w-0 rounded-[10px] border border-input bg-card px-3 text-sm text-foreground outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-ring/20 disabled:bg-muted";
  const errors = whatsappButtonErrors(button);
  const fieldId = (field: string) => `whatsapp-button-${button.id}-${field}`;
  return <div className="rounded-[10px] border border-border bg-muted/25 p-3">
    <div className="mb-2 flex flex-wrap items-center justify-between gap-1">
      <div className="flex items-center gap-1">{dragHandle}<span className="text-xs font-semibold">Button {index + 1}</span></div>
      <div className="flex items-center">
        <button type="button" disabled={disabled || index === 0} aria-label={`Move button ${index + 1} up`} onClick={() => onMove(button.id, buttons[index - 1].id)} className="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30"><ArrowUp className="h-4 w-4" /></button>
        <button type="button" disabled={disabled || index === buttons.length - 1} aria-label={`Move button ${index + 1} down`} onClick={() => onMove(button.id, buttons[index + 1].id)} className="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30"><ArrowDown className="h-4 w-4" /></button>
        <button type="button" disabled={disabled} aria-label={`Remove button ${index + 1}`} onClick={() => onRemove(button.id)} className="flex h-11 w-11 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30"><Trash2 className="h-4 w-4" /></button>
      </div>
    </div>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block text-xs font-medium">Type<select aria-label={`Button ${index + 1} type`} disabled={disabled} value={button.type} onChange={(event) => onUpdate(button.id, { type: event.target.value as WhatsAppButtonType })} className={`${fieldClassName} mt-1`}><option value="QUICK_REPLY">Quick reply</option><option value="URL">Visit website</option><option value="PHONE_NUMBER">Call number</option></select></label>
      <label className="block text-xs font-medium">Button text<input id={fieldId("text")} aria-label={`Button ${index + 1} text`} aria-invalid={Boolean(errors.text)} aria-describedby={errors.text ? fieldId("text-error") : undefined} disabled={disabled} value={button.text} onChange={(event) => onUpdate(button.id, { text: event.target.value })} maxLength={25} className={`${fieldClassName} mt-1 ${errors.text ? "border-destructive" : ""}`} placeholder="Button text" /><span className="mt-1 block text-right font-normal text-muted-foreground">{button.text.length}/25</span>{errors.text && <span id={fieldId("text-error")} className="mt-1 block font-normal text-destructive">{errors.text}</span>}</label>
      {button.type === "URL" && <label className="block text-xs font-medium sm:col-span-2">Website URL<input id={fieldId("url")} aria-label={`Button ${index + 1} URL`} aria-invalid={Boolean(errors.url)} aria-describedby={errors.url ? fieldId("url-error") : undefined} disabled={disabled} value={button.url || ""} onChange={(event) => onUpdate(button.id, { url: event.target.value })} className={`${fieldClassName} mt-1 ${errors.url ? "border-destructive" : ""}`} placeholder="https://example.com" type="url" />{errors.url && <span id={fieldId("url-error")} className="mt-1 block font-normal leading-5 text-destructive">{errors.url}</span>}</label>}
      {button.type === "PHONE_NUMBER" && <label className="block text-xs font-medium sm:col-span-2">Phone number<input id={fieldId("phone_number")} aria-label={`Button ${index + 1} phone number`} aria-invalid={Boolean(errors.phone_number)} aria-describedby={errors.phone_number ? fieldId("phone_number-error") : undefined} disabled={disabled} value={button.phone_number || ""} onChange={(event) => onUpdate(button.id, { phone_number: event.target.value })} className={`${fieldClassName} mt-1 ${errors.phone_number ? "border-destructive" : ""}`} placeholder="+1 415 555 0123" type="tel" />{errors.phone_number && <span id={fieldId("phone_number-error")} className="mt-1 block font-normal leading-5 text-destructive">{errors.phone_number}</span>}</label>}
    </div>
  </div>;
}

function SortableButton(props: ButtonEditorProps & { button: WhatsAppDraftButton; index: number }) {
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({ id: props.button.id, data: { kind: "button", label: props.button.text || `Button ${props.index + 1}` }, disabled: props.disabled });
  return <div ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition }} className={cn("min-w-0", isDragging && "relative z-10 opacity-40")} data-testid={`template-button-${props.index + 1}`}>
    <ButtonFields {...props} dragHandle={<button ref={setActivatorNodeRef} type="button" {...attributes} {...listeners} disabled={props.disabled} aria-label={`Reorder button ${props.index + 1}`} className="flex h-11 w-11 touch-none items-center justify-center rounded-md text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><GripVertical className="h-4 w-4" /></button>} />
  </div>;
}

export function WhatsAppButtonsEditor(props: ButtonEditorProps) {
  const rows = props.buttons.map((button, index) => props.sortable ? <SortableButton key={button.id} {...props} button={button} index={index} /> : <ButtonFields key={button.id} {...props} button={button} index={index} />);
  return <WhatsAppEditorSection title="Buttons" note={`${props.buttons.length}/3 · Optional`} actions={<button type="button" onClick={props.onAdd} disabled={props.disabled || props.buttons.length >= 3} className="inline-flex min-h-11 items-center gap-1 rounded-lg border px-3 text-xs font-semibold hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"><Plus className="h-3.5 w-3.5" />Add button</button>}>
    {props.buttons.length ? <div className="space-y-3">{props.sortable ? <SortableContext items={props.buttons.map((button) => button.id)} strategy={verticalListSortingStrategy}>{rows}</SortableContext> : rows}</div>
      : <div className="rounded-[10px] border border-dashed p-5 text-center text-sm text-muted-foreground">{props.sortable ? "Click a button type or drag it here." : "Add a button to give customers an action."}</div>}
    <p className="mt-3 text-xs text-muted-foreground">Add up to three actions. Their order matches the message preview.</p>
    {!props.valid && <p className="mt-2 text-xs text-destructive">Complete the highlighted fields before saving.</p>}
  </WhatsAppEditorSection>;
}
