"use client";

import { useState, useEffect } from "react";
import { useAdminLeadflow } from "@/contexts/AdminLeadflowContext";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { ActorNodeData, LLMNodeData } from "./types";
import { X } from "lucide-react";

export default function NodeConfig() {
  const { selectedNode, setSelectedNode, updateNodeData } = useAdminLeadflow();
  const [config, setConfig] = useState<Record<string, unknown>>({});

  useEffect(() => {
    if (selectedNode) {
      if ("schema" in selectedNode.data && "config" in selectedNode.data) {
        const actorData = selectedNode.data as ActorNodeData;
        setConfig(actorData.config || {});
      } else if (selectedNode.type === "llm") {
        const llmData = selectedNode.data as LLMNodeData;
        setConfig({
          label: llmData.label,
          model: llmData.config?.model,
          temperature: llmData.config?.temperature,
          max_tokens: llmData.config?.max_tokens,
          prompt_template: llmData.config?.prompt_template,
        });
      }
    }
  }, [selectedNode]);

  const handleClose = () => {
    setSelectedNode(null);
  };

  const handleSave = () => {
    if (!selectedNode) return;

    if ("schema" in selectedNode.data) {
      updateNodeData(selectedNode.id, { config } as Partial<ActorNodeData>);
    } else if (selectedNode.type === "llm") {
      updateNodeData(selectedNode.id, {
        label: config.label,
        config: {
          model: config.model,
          temperature: config.temperature,
          max_tokens: config.max_tokens,
          prompt_template: config.prompt_template,
        },
      } as Partial<LLMNodeData>);
    }

    handleClose();
  };

  const renderInputField = (key: string, property: Record<string, unknown>) => {
    const value = config[key] || "";
    const title = (property.title as string) || key;
    const description = property.description as string | undefined;

    if (property.type === "boolean") {
      return (
        <div className="flex items-center space-x-2">
          <Switch
            id={key}
            checked={!!value}
            onCheckedChange={(checked) => setConfig({ ...config, [key]: checked })}
          />
          <Label htmlFor={key}>{title}</Label>
        </div>
      );
    }

    if (property.type === "number") {
      return (
        <div className="space-y-2">
          <Label htmlFor={key}>{title}</Label>
          <Input
            id={key}
            type="number"
            value={value as string}
            onChange={(e) => setConfig({ ...config, [key]: Number(e.target.value) })}
            placeholder={description}
          />
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
      );
    }

    if (property.type === "array") {
      return (
        <div className="space-y-2">
          <Label htmlFor={key}>{title}</Label>
          <Textarea
            id={key}
            value={JSON.stringify(value, null, 2) || "[]"}
            onChange={(e) => {
              try {
                const parsed = JSON.parse(e.target.value);
                setConfig({ ...config, [key]: parsed });
              } catch {
                // Invalid JSON, keep the text as-is
              }
            }}
            placeholder={description}
            rows={6}
            className="font-mono text-xs"
          />
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
      );
    }

    return (
      <div className="space-y-2">
        <Label htmlFor={key}>{title}</Label>
        <Input
          id={key}
          type="text"
          value={value as string}
          onChange={(e) => setConfig({ ...config, [key]: e.target.value })}
          placeholder={description}
        />
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
    );
  };

  if (!selectedNode) return null;

  const isActorNode = "schema" in selectedNode.data;
  const isLLMNode = selectedNode.type === "llm";

  return (
    <Sheet open={!!selectedNode} onOpenChange={handleClose}>
      <SheetContent className="w-[calc(100vw-1rem)] max-w-[500px] overflow-y-auto sm:w-full sm:max-w-[600px]">
        <SheetHeader>
          <div className="flex items-center justify-between">
            <SheetTitle>
              {isActorNode
                ? (selectedNode.data as ActorNodeData).actorName
                : isLLMNode
                  ? "LLM Settings"
                  : "Database Save Settings"}
            </SheetTitle>
            <Button variant="ghost" size="sm" onClick={handleClose} className="h-6 w-6 p-0">
              <X className="w-4 h-4" />
            </Button>
          </div>
          <SheetDescription>
            {isActorNode
              ? ((selectedNode.data as ActorNodeData).schema?.description ?? '')
              : isLLMNode
                ? "Configure AI model settings and prompt template"
                : "Configure database table and field mapping"}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-6 space-y-6">
          {isActorNode ? (
            <>
              {Object.entries(
                (selectedNode.data as ActorNodeData).schema?.inputSchema?.properties || {}
              ).map(([key, property]) => (
                <div key={key}>
                  {renderInputField(key, property as Record<string, unknown>)}
                </div>
              ))}
            </>
          ) : isLLMNode ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="label">Node Label</Label>
                <Input
                  id="label"
                  type="text"
                  value={(config.label as string) || "LLM Input Generation"}
                  onChange={(e) => setConfig({ ...config, label: e.target.value })}
                  placeholder="LLM Input Generation"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="model">Model</Label>
                <Input
                  id="model"
                  type="text"
                  value={(config.model as string) || "gpt-4"}
                  onChange={(e) => setConfig({ ...config, model: e.target.value })}
                  placeholder="gpt-4"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="temperature">Temperature</Label>
                <Input
                  id="temperature"
                  type="number"
                  step="0.1"
                  min="0"
                  max="2"
                  value={(config.temperature as number) || 0.7}
                  onChange={(e) =>
                    setConfig({ ...config, temperature: parseFloat(e.target.value) })
                  }
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="max_tokens">Max Tokens</Label>
                <Input
                  id="max_tokens"
                  type="number"
                  value={(config.max_tokens as number) || 500}
                  onChange={(e) =>
                    setConfig({ ...config, max_tokens: parseInt(e.target.value) })
                  }
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="prompt_template">Prompt Template</Label>
                <Textarea
                  id="prompt_template"
                  value={(config.prompt_template as string) || ""}
                  onChange={(e) =>
                    setConfig({ ...config, prompt_template: e.target.value })
                  }
                  placeholder="Enter your prompt template..."
                  rows={10}
                  className="font-mono text-xs"
                />
                <p className="text-xs text-muted-foreground">
                  Use placeholders like {"{campaign_objective}"}, {"{target_audience}"}, etc.
                </p>
              </div>
            </>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="table">Database Table</Label>
                <Input
                  id="table"
                  type="text"
                  value={(config.table as string) || ""}
                  onChange={(e) => setConfig({ ...config, table: e.target.value })}
                  placeholder="e.g., leads, contacts, companies"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="mapping">Field Mapping (JSON)</Label>
                <Textarea
                  id="mapping"
                  value={JSON.stringify(config.mapping || {}, null, 2)}
                  onChange={(e) => {
                    try {
                      const parsed = JSON.parse(e.target.value);
                      setConfig({ ...config, mapping: parsed });
                    } catch {
                      // Invalid JSON
                    }
                  }}
                  placeholder='{"db_column": "$.data.path"}'
                  rows={10}
                  className="font-mono text-xs"
                />
                <p className="text-xs text-muted-foreground">
                  Map database columns to JSON paths from the input data
                </p>
              </div>
            </>
          )}
        </div>

        <div className="mt-6 flex justify-end space-x-2">
          <Button variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            className="bg-gradient-to-r from-purple-600 to-purple-400"
          >
            Save Settings
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
