"use client";

import React, { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";

interface InputParametersDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (inputs: Record<string, unknown>) => void;
  initialValues?: Record<string, unknown> | null;
  schema?: Record<string, unknown> | null;
}

const InputParametersDialog: React.FC<InputParametersDialogProps> = ({
  isOpen,
  onClose,
  onSubmit,
  initialValues = null,
  schema = null,
}) => {
  const [inputs, setInputs] = useState<Record<string, unknown>>({});
  const [useJson, setUseJson] = useState<boolean>(false);
  const [jsonText, setJsonText] = useState<string>("");

  useEffect(() => {
    if (initialValues) {
      setInputs(initialValues);
      setJsonText(JSON.stringify(initialValues, null, 2));
    }
  }, [initialValues]);

  const handleInputChange = (field: string, value: unknown) => {
    setInputs((prev) => ({
      ...prev,
      [field]: value,
    }));
  };

  const handleSubmit = () => {
    let result: Record<string, unknown>;

    if (useJson) {
      try {
        result = JSON.parse(jsonText) as Record<string, unknown>;
      } catch {
        alert("Invalid JSON input. Please check your JSON syntax.");
        return;
      }
    } else {
      result = inputs;
    }

    onSubmit(result);
  };

  const handleClose = () => {
    setInputs({});
    setJsonText("{}");
    setUseJson(false);
    onClose();
  };

  const renderFormFields = () => {
    if (!schema || useJson) return null;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const properties = (schema as any)?.properties || {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const required = (schema as any)?.required || [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return Object.entries(properties).map(([key, propSchema]: [string, any]) => {
      const isRequired = required.includes(key);
      const label =
        propSchema.title ||
        key
          .replace(/_/g, " ")
          .replace(/\b\w/g, (l: string) => l.toUpperCase());
      const description = propSchema.description || "";
      const type = propSchema.type || "string";
      const enumValues = propSchema.enum || [];

      return (
        <div key={key} className="grid grid-cols-4 items-start gap-4">
          <Label htmlFor={key} className="text-right pt-2">
            {label} {isRequired && <span className="text-red-500">*</span>}
          </Label>
          <div className="col-span-3 space-y-1">
            {enumValues.length > 0 ? (
              <select
                id={key}
                value={String(inputs[key] || "")}
                onChange={(e) => handleInputChange(key, e.target.value)}
                className="w-full px-3 py-2 border rounded-md"
              >
                <option value="">Select {label}</option>
                {enumValues.map((val: string) => (
                  <option key={val} value={val}>
                    {val}
                  </option>
                ))}
              </select>
            ) : type === "integer" || type === "number" ? (
              <Input
                id={key}
                type="number"
                value={inputs[key] !== undefined && inputs[key] !== "" ? String(inputs[key]) : ""}
                onChange={(e) =>
                  handleInputChange(
                    key,
                    type === "integer"
                      ? parseInt(e.target.value)
                      : parseFloat(e.target.value)
                  )
                }
                placeholder={String(
                  Array.isArray(propSchema.prefill)
                    ? propSchema.prefill[0] ?? ""
                    : propSchema.prefill ?? propSchema.default ?? ""
                )}
              />
            ) : type === "boolean" ? (
              <div className="flex items-center space-x-2">
                <Switch
                  id={key}
                  checked={Boolean(inputs[key])}
                  onCheckedChange={(checked) =>
                    handleInputChange(key, checked)
                  }
                />
                <Label htmlFor={key}>{description}</Label>
              </div>
            ) : type === "array" ? (
              <Textarea
                id={key}
                value={
                  Array.isArray(inputs[key])
                    ? (inputs[key] as string[]).join(", ")
                    : String(inputs[key] || "")
                }
                onChange={(e) =>
                  handleInputChange(
                    key,
                    e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean)
                  )
                }
                placeholder={String(
                  Array.isArray(propSchema.prefill) && propSchema.prefill.length > 0
                    ? propSchema.prefill.join(", ")
                    : propSchema.prefill ?? propSchema.default ?? "Comma-separated values"
                )}
                rows={3}
              />
            ) : (
              <Textarea
                id={key}
                value={String(inputs[key] || "")}
                onChange={(e) => handleInputChange(key, e.target.value)}
                placeholder={String(
                  Array.isArray(propSchema.prefill)
                    ? propSchema.prefill[0] ?? ""
                    : propSchema.prefill ?? propSchema.default ?? propSchema.example ?? ""
                )}
                rows={3}
              />
            )}
            {description && (
              <p className="text-xs text-muted-foreground">{description}</p>
            )}
          </div>
        </div>
      );
    });
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Workflow Input Parameters</DialogTitle>
          <DialogDescription>
            Provide the required input parameters to run this workflow.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          {/* Toggle between form and JSON */}
          <div className="flex items-center justify-between p-3 bg-muted rounded-md">
            <div className="flex items-center gap-2">
              <Label htmlFor="use_json" className="text-sm font-medium">
                Use JSON Editor
              </Label>
              <Switch
                id="use_json"
                checked={useJson}
                onCheckedChange={setUseJson}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {useJson
                ? "Switch to form view for guided input"
                : "Switch to JSON for advanced editing"}
            </p>
          </div>

          {useJson ? (
            <div className="space-y-2">
              <Label htmlFor="json_input">JSON Input</Label>
              <Textarea
                id="json_input"
                value={jsonText}
                onChange={(e) => setJsonText(e.target.value)}
                placeholder='{\n  "searchQuery": "Software Engineer",\n  "maxItems": 20\n}'
                rows={15}
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Enter valid JSON with the required workflow parameters
              </p>
            </div>
          ) : schema &&
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            Object.keys((schema as any)?.properties || {}).length > 0 ? (
            <div className="space-y-4">{renderFormFields()}</div>
          ) : (
            <div className="p-8 text-center border-2 border-dashed rounded-md">
              <p className="text-sm text-muted-foreground mb-4">
                No input schema available. Use JSON editor to provide inputs.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setUseJson(true)}
              >
                Open JSON Editor
              </Button>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            className="bg-gradient-to-r from-purple-600 to-purple-400"
          >
            Run Workflow
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default InputParametersDialog;
