"use client";

import React, { useState } from "react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
  DragStartEvent,
  DragOverlay,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Type,
  Image,
  Square,
  Minus,
  Columns,
  MousePointerClick,
  GripVertical,
  Trash2,
  Plus,
  ChevronDown,
  ChevronUp,
  LayoutTemplate,
} from "lucide-react";

// ─── Block Types ────────────────────────────────────────────────────────────────

export type BlockType =
  | "header"
  | "text"
  | "image"
  | "button"
  | "divider"
  | "spacer"
  | "columns"
  | "footer";

export interface EmailBlock {
  id: string;
  type: BlockType;
  props: Record<string, string>;
}

interface BlockConfig {
  type: BlockType;
  label: string;
  icon: React.ElementType;
  defaultProps: Record<string, string>;
}

const BLOCK_CONFIGS: BlockConfig[] = [
  {
    type: "header",
    label: "Header",
    icon: LayoutTemplate,
    defaultProps: {
      text: "Your Email Header",
      fontSize: "24",
      fontWeight: "bold",
      color: "#333333",
      align: "center",
      bgColor: "#f8f9fa",
      padding: "20",
    },
  },
  {
    type: "text",
    label: "Text",
    icon: Type,
    defaultProps: {
      text: "Write your email text here. Use {{first_name}} for personalization.",
      fontSize: "16",
      color: "#555555",
      align: "left",
      lineHeight: "1.6",
    },
  },
  {
    type: "image",
    label: "Image",
    icon: Image,
    defaultProps: {
      src: "",
      alt: "Image",
      width: "100",
      align: "center",
    },
  },
  {
    type: "button",
    label: "Button",
    icon: MousePointerClick,
    defaultProps: {
      text: "Click Here",
      url: "#",
      bgColor: "#4F46E5",
      textColor: "#ffffff",
      borderRadius: "6",
      align: "center",
      padding: "12",
    },
  },
  {
    type: "divider",
    label: "Divider",
    icon: Minus,
    defaultProps: {
      color: "#e5e7eb",
      thickness: "1",
      width: "100",
    },
  },
  {
    type: "spacer",
    label: "Spacer",
    icon: Square,
    defaultProps: {
      height: "20",
    },
  },
  {
    type: "columns",
    label: "2 Columns",
    icon: Columns,
    defaultProps: {
      leftText: "Left column content",
      rightText: "Right column content",
      gap: "20",
    },
  },
  {
    type: "footer",
    label: "Footer",
    icon: LayoutTemplate,
    defaultProps: {
      text: "© 2025 {{company_name}}. All rights reserved.",
      fontSize: "12",
      color: "#999999",
      align: "center",
      bgColor: "#f8f9fa",
      padding: "16",
    },
  },
];

// ─── Block Renderer (for preview) ──────────────────────────────────────────────

function renderBlockHtml(block: EmailBlock): string {
  const p = block.props;
  switch (block.type) {
    case "header":
      return `<tr><td style="background-color:${p.bgColor || "#f8f9fa"};padding:${p.padding || "20"}px;text-align:${p.align || "center"};"><h1 style="margin:0;font-size:${p.fontSize || "24"}px;font-weight:${p.fontWeight || "bold"};color:${p.color || "#333"};font-family:Arial,Helvetica,sans-serif;">${escapeHtml(p.text || "")}</h1></td></tr>`;
    case "text":
      return `<tr><td style="padding:10px 20px;text-align:${p.align || "left"};"><p style="margin:0;font-size:${p.fontSize || "16"}px;color:${p.color || "#555"};line-height:${p.lineHeight || "1.6"};font-family:Arial,Helvetica,sans-serif;">${escapeHtml(p.text || "")}</p></td></tr>`;
    case "image":
      return `<tr><td style="padding:10px 20px;text-align:${p.align || "center"};"><img src="${escapeHtml(p.src || "https://placehold.co/600x200/eee/999?text=Your+Image")}" alt="${escapeHtml(p.alt || "")}" style="max-width:${p.width || "100"}%;height:auto;border:0;" /></td></tr>`;
    case "button":
      return `<tr><td style="padding:${p.padding || "12"}px 20px;text-align:${p.align || "center"};"><a href="${escapeHtml(p.url || "#")}" style="display:inline-block;padding:12px 28px;background-color:${p.bgColor || "#4F46E5"};color:${p.textColor || "#fff"};text-decoration:none;border-radius:${p.borderRadius || "6"}px;font-size:16px;font-weight:600;font-family:Arial,Helvetica,sans-serif;">${escapeHtml(p.text || "Click")}</a></td></tr>`;
    case "divider":
      return `<tr><td style="padding:10px 20px;"><hr style="border:0;border-top:${p.thickness || "1"}px solid ${p.color || "#e5e7eb"};width:${p.width || "100"}%;margin:0 auto;" /></td></tr>`;
    case "spacer":
      return `<tr><td style="height:${p.height || "20"}px;"></td></tr>`;
    case "columns":
      return `<tr><td style="padding:10px 20px;"><table width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td width="48%" valign="top" style="font-size:14px;color:#555;font-family:Arial,Helvetica,sans-serif;padding-right:${parseInt(p.gap || "20") / 2}px;">${escapeHtml(p.leftText || "")}</td><td width="48%" valign="top" style="font-size:14px;color:#555;font-family:Arial,Helvetica,sans-serif;padding-left:${parseInt(p.gap || "20") / 2}px;">${escapeHtml(p.rightText || "")}</td></tr></table></td></tr>`;
    case "footer":
      return `<tr><td style="background-color:${p.bgColor || "#f8f9fa"};padding:${p.padding || "16"}px;text-align:${p.align || "center"};"><p style="margin:0;font-size:${p.fontSize || "12"}px;color:${p.color || "#999"};font-family:Arial,Helvetica,sans-serif;">${escapeHtml(p.text || "")}</p></td></tr>`;
    default:
      return "";
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function blocksToHtml(blocks: EmailBlock[], subject?: string): string {
  const rows = blocks.map(renderBlockHtml).join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="X-UA-Compatible" content="IE=edge" />
${subject ? `<title>${escapeHtml(subject)}</title>` : ""}
</head>
<body style="margin:0;padding:0;background-color:#f4f4f7;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f4f7;">
<tr><td align="center" style="padding:20px 0;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;background-color:#ffffff;border-radius:8px;overflow:hidden;">
${rows}
</table>
</td></tr>
</table>
</body>
</html>`;
}

export function blocksToPlainText(blocks: EmailBlock[]): string {
  return blocks
    .map((b) => {
      switch (b.type) {
        case "header":
        case "text":
        case "footer":
          return b.props.text || "";
        case "button":
          return `[${b.props.text || "Link"}](${b.props.url || "#"})`;
        case "columns":
          return `${b.props.leftText || ""}\n${b.props.rightText || ""}`;
        case "divider":
          return "---";
        case "spacer":
          return "";
        default:
          return "";
      }
    })
    .filter(Boolean)
    .join("\n\n");
}

// ─── Sortable Block Item ───────────────────────────────────────────────────────

interface SortableBlockProps {
  block: EmailBlock;
  onUpdate: (id: string, props: Record<string, string>) => void;
  onDelete: (id: string) => void;
}

function SortableBlock({ block, onUpdate, onDelete }: SortableBlockProps) {
  const [expanded, setExpanded] = useState(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: block.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const config = BLOCK_CONFIGS.find((c) => c.type === block.type);
  const Icon = config?.icon || Type;

  const handlePropChange = (key: string, value: string) => {
    onUpdate(block.id, { ...block.props, [key]: value });
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="border rounded-lg bg-card mb-2 group"
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <button {...attributes} {...listeners} className="cursor-grab touch-none text-muted-foreground hover:text-foreground">
          <GripVertical className="h-4 w-4" />
        </button>
        <Icon className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium flex-1">{config?.label || block.type}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0 text-destructive hover:text-destructive"
          onClick={() => onDelete(block.id)}
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>

      {expanded && (
        <div className="px-3 pb-3 space-y-3 border-t pt-3">
          {block.type === "header" && (
            <>
              <div className="space-y-1">
                <Label className="text-xs">Heading Text</Label>
                <Input value={block.props.text} onChange={(e) => handlePropChange("text", e.target.value)} />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1"><Label className="text-xs">Font Size</Label><Input type="number" value={block.props.fontSize} onChange={(e) => handlePropChange("fontSize", e.target.value)} /></div>
                <div className="space-y-1"><Label className="text-xs">Color</Label><Input type="color" value={block.props.color} onChange={(e) => handlePropChange("color", e.target.value)} className="h-9" /></div>
                <div className="space-y-1"><Label className="text-xs">BG Color</Label><Input type="color" value={block.props.bgColor} onChange={(e) => handlePropChange("bgColor", e.target.value)} className="h-9" /></div>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Alignment</Label>
                <Select value={block.props.align} onValueChange={(v) => handlePropChange("align", v)}>
                  <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="left">Left</SelectItem><SelectItem value="center">Center</SelectItem><SelectItem value="right">Right</SelectItem></SelectContent>
                </Select>
              </div>
            </>
          )}

          {block.type === "text" && (
            <>
              <div className="space-y-1">
                <Label className="text-xs">Text Content</Label>
                <Textarea value={block.props.text} onChange={(e) => handlePropChange("text", e.target.value)} rows={3} />
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1"><Label className="text-xs">Font Size</Label><Input type="number" value={block.props.fontSize} onChange={(e) => handlePropChange("fontSize", e.target.value)} /></div>
                <div className="space-y-1"><Label className="text-xs">Color</Label><Input type="color" value={block.props.color} onChange={(e) => handlePropChange("color", e.target.value)} className="h-9" /></div>
                <div className="space-y-1">
                  <Label className="text-xs">Align</Label>
                  <Select value={block.props.align} onValueChange={(v) => handlePropChange("align", v)}>
                    <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="left">Left</SelectItem><SelectItem value="center">Center</SelectItem><SelectItem value="right">Right</SelectItem></SelectContent>
                  </Select>
                </div>
              </div>
            </>
          )}

          {block.type === "image" && (
            <>
              <div className="space-y-1"><Label className="text-xs">Image URL</Label><Input value={block.props.src} onChange={(e) => handlePropChange("src", e.target.value)} placeholder="https://..." /></div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1"><Label className="text-xs">Alt Text</Label><Input value={block.props.alt} onChange={(e) => handlePropChange("alt", e.target.value)} /></div>
                <div className="space-y-1"><Label className="text-xs">Width %</Label><Input type="number" value={block.props.width} onChange={(e) => handlePropChange("width", e.target.value)} min="10" max="100" /></div>
              </div>
            </>
          )}

          {block.type === "button" && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1"><Label className="text-xs">Button Text</Label><Input value={block.props.text} onChange={(e) => handlePropChange("text", e.target.value)} /></div>
                <div className="space-y-1"><Label className="text-xs">URL</Label><Input value={block.props.url} onChange={(e) => handlePropChange("url", e.target.value)} /></div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1"><Label className="text-xs">BG Color</Label><Input type="color" value={block.props.bgColor} onChange={(e) => handlePropChange("bgColor", e.target.value)} className="h-9" /></div>
                <div className="space-y-1"><Label className="text-xs">Text Color</Label><Input type="color" value={block.props.textColor} onChange={(e) => handlePropChange("textColor", e.target.value)} className="h-9" /></div>
                <div className="space-y-1"><Label className="text-xs">Radius</Label><Input type="number" value={block.props.borderRadius} onChange={(e) => handlePropChange("borderRadius", e.target.value)} /></div>
              </div>
            </>
          )}

          {block.type === "divider" && (
            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-1"><Label className="text-xs">Color</Label><Input type="color" value={block.props.color} onChange={(e) => handlePropChange("color", e.target.value)} className="h-9" /></div>
              <div className="space-y-1"><Label className="text-xs">Thickness</Label><Input type="number" value={block.props.thickness} onChange={(e) => handlePropChange("thickness", e.target.value)} min="1" max="5" /></div>
              <div className="space-y-1"><Label className="text-xs">Width %</Label><Input type="number" value={block.props.width} onChange={(e) => handlePropChange("width", e.target.value)} min="10" max="100" /></div>
            </div>
          )}

          {block.type === "spacer" && (
            <div className="space-y-1"><Label className="text-xs">Height (px)</Label><Input type="number" value={block.props.height} onChange={(e) => handlePropChange("height", e.target.value)} min="5" max="100" /></div>
          )}

          {block.type === "columns" && (
            <>
              <div className="space-y-1"><Label className="text-xs">Left Column</Label><Textarea value={block.props.leftText} onChange={(e) => handlePropChange("leftText", e.target.value)} rows={2} /></div>
              <div className="space-y-1"><Label className="text-xs">Right Column</Label><Textarea value={block.props.rightText} onChange={(e) => handlePropChange("rightText", e.target.value)} rows={2} /></div>
            </>
          )}

          {block.type === "footer" && (
            <>
              <div className="space-y-1"><Label className="text-xs">Footer Text</Label><Textarea value={block.props.text} onChange={(e) => handlePropChange("text", e.target.value)} rows={2} /></div>
              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1"><Label className="text-xs">Font Size</Label><Input type="number" value={block.props.fontSize} onChange={(e) => handlePropChange("fontSize", e.target.value)} /></div>
                <div className="space-y-1"><Label className="text-xs">Color</Label><Input type="color" value={block.props.color} onChange={(e) => handlePropChange("color", e.target.value)} className="h-9" /></div>
                <div className="space-y-1"><Label className="text-xs">BG Color</Label><Input type="color" value={block.props.bgColor} onChange={(e) => handlePropChange("bgColor", e.target.value)} className="h-9" /></div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Drag & Drop Builder ───────────────────────────────────────────────────────

interface DnDEmailBuilderProps {
  blocks: EmailBlock[];
  onChange: (blocks: EmailBlock[]) => void;
}

export default function DnDEmailBuilder({ blocks, onChange }: DnDEmailBuilderProps) {
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const addBlock = (type: BlockType) => {
    const config = BLOCK_CONFIGS.find((c) => c.type === type);
    if (!config) return;
    const newBlock: EmailBlock = {
      id: `${type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type,
      props: { ...config.defaultProps },
    };
    onChange([...blocks, newBlock]);
  };

  const updateBlock = (id: string, props: Record<string, string>) => {
    onChange(blocks.map((b) => (b.id === id ? { ...b, props } : b)));
  };

  const deleteBlock = (id: string) => {
    onChange(blocks.filter((b) => b.id !== id));
  };

  const handleDragStart = (event: DragStartEvent) => {
    setActiveId(event.active.id as string);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = blocks.findIndex((b) => b.id === active.id);
      const newIndex = blocks.findIndex((b) => b.id === over.id);
      onChange(arrayMove(blocks, oldIndex, newIndex));
    }
  };

  return (
    <div className="flex gap-4 h-full">
      {/* Block Palette */}
      <div className="w-48 shrink-0 space-y-2">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
          Add Elements
        </p>
        {BLOCK_CONFIGS.map((config) => (
          <Button
            key={config.type}
            variant="outline"
            size="sm"
            className="w-full justify-start gap-2 text-xs"
            onClick={() => addBlock(config.type)}
          >
            <Plus className="h-3 w-3" />
            <config.icon className="h-3.5 w-3.5" />
            {config.label}
          </Button>
        ))}
      </div>

      {/* Block List */}
      <div className="flex-1 min-w-0">
        {blocks.length === 0 ? (
          <div className="border-2 border-dashed rounded-lg p-8 text-center text-muted-foreground">
            <LayoutTemplate className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">Click elements on the left to start building</p>
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={handleDragStart}
            onDragEnd={handleDragEnd}
          >
            <SortableContext
              items={blocks.map((b) => b.id)}
              strategy={verticalListSortingStrategy}
            >
              {blocks.map((block) => (
                <SortableBlock
                  key={block.id}
                  block={block}
                  onUpdate={updateBlock}
                  onDelete={deleteBlock}
                />
              ))}
            </SortableContext>
            <DragOverlay>
              {activeId ? (
                <div className="border rounded-lg bg-card p-2 shadow-lg opacity-80">
                  <span className="text-sm">
                    {BLOCK_CONFIGS.find((c) => c.type === blocks.find((b) => b.id === activeId)?.type)?.label}
                  </span>
                </div>
              ) : null}
            </DragOverlay>
          </DndContext>
        )}
      </div>
    </div>
  );
}
