"use client";

import React, { useState, useCallback } from "react";
import { X, Plus, Trash2, Code, FileJson, ArrowRight, Settings } from "lucide-react";
import { ActorSchema } from "./types";
import {
  ConnectionMappingConfig,
  FieldMappingConfig,
  ArrayIterationConfig,
} from "@/contexts/AdminLeadflowContext";

interface InputMappingProps {
  isOpen: boolean;
  onClose: () => void;
  sourceNode: {
    id: string;
    data: {
      actorName: string;
      schema?: ActorSchema;
      output?: unknown;
    };
  };
  targetNode: {
    id: string;
    data: {
      actorName: string;
      schema?: ActorSchema;
    };
  };
  existingMapping?: ConnectionMappingConfig;
  onSave: (mapping: ConnectionMappingConfig) => void;
}

const InputMapping: React.FC<InputMappingProps> = ({
  isOpen,
  onClose,
  sourceNode,
  targetNode,
  existingMapping,
  onSave,
}) => {
  // Normalise JSONPath — ensure paths always start with "$."
  const normalizeJsonPath = (p: string) => {
    if (!p) return p;
    if (p.startsWith('$')) return p;
    return `$.${p}`;
  };

  const [fieldMappings, setFieldMappings] = useState<FieldMappingConfig[]>(
    (existingMapping?.fieldMappings || []).map((fm) => ({
      ...fm,
      sourceFieldPath: normalizeJsonPath(fm.sourceFieldPath),
      targetFieldPath: normalizeJsonPath(fm.targetFieldPath),
    }))
  );
  const [arrayIterationConfig, setArrayIterationConfig] = useState<
    ArrayIterationConfig | undefined
  >(existingMapping?.arrayIterationConfig);
  // Auto-open array config panel if an existing config was loaded
  const [showArrayConfig, setShowArrayConfig] = useState(
    !!existingMapping?.arrayIterationConfig
  );
  const [selectedMapping, setSelectedMapping] = useState<string | null>(null);

  const addFieldMapping = useCallback(() => {
    const newMapping: FieldMappingConfig = {
      id: `mapping_${Date.now()}`,
      sourceFieldPath: "",
      targetFieldPath: "",
      transformationType: "direct",
      errorStrategy: "skip",
    };
    setFieldMappings([...fieldMappings, newMapping]);
    setSelectedMapping(newMapping.id);
  }, [fieldMappings]);

  const updateFieldMapping = useCallback(
    (id: string, updates: Partial<FieldMappingConfig>) => {
      setFieldMappings((prev) =>
        prev.map((mapping) =>
          mapping.id === id ? { ...mapping, ...updates } : mapping
        )
      );
    },
    []
  );

  const removeFieldMapping = useCallback(
    (id: string) => {
      setFieldMappings((prev) => prev.filter((mapping) => mapping.id !== id));
      if (selectedMapping === id) {
        setSelectedMapping(null);
      }
    },
    [selectedMapping]
  );

  const handleSave = useCallback(() => {
    const mapping: ConnectionMappingConfig = {
      sourceNodeId: sourceNode.id,
      targetNodeId: targetNode.id,
      fieldMappings,
      arrayIterationConfig,
    };
    onSave(mapping);
    onClose();
  }, [
    sourceNode.id,
    targetNode.id,
    fieldMappings,
    arrayIterationConfig,
    onSave,
    onClose,
  ]);

  const extractFieldPaths = (
    schema: { properties?: Record<string, unknown> },
    prefix = "$"
  ): string[] => {
    if (!schema || !schema.properties) return [prefix];

    const paths: string[] = [];
    Object.entries(schema.properties).forEach(
      ([key, value]: [string, unknown]) => {
        const currentPath = `${prefix}.${key}`;
        paths.push(currentPath);

        const val = value as {
          type?: string;
          properties?: Record<string, unknown>;
          items?: {
            type?: string;
            properties?: Record<string, unknown>;
          };
        };
        if (val.type === "object" && val.properties) {
          paths.push(...extractFieldPaths(val, currentPath));
        } else if (val.type === "array" && val.items) {
          paths.push(`${currentPath}[*]`);
          const items = val.items as {
            type?: string;
            properties?: Record<string, unknown>;
          };
          if (items.type === "object" && items.properties) {
            paths.push(...extractFieldPaths(items, `${currentPath}[*]`));
          }
        }
      }
    );

    return paths;
  };

  const sourceFieldPaths = sourceNode.data.schema?.outputSchema
    ? extractFieldPaths(sourceNode.data.schema.outputSchema)
    : [];
  const targetFieldPaths = targetNode.data.schema?.inputSchema
    ? extractFieldPaths(targetNode.data.schema.inputSchema)
    : [];

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[var(--layer-modal)] flex items-center justify-center bg-black/50 p-2 sm:p-4">
      <div className="flex h-[94svh] w-full max-w-[95vw] flex-col rounded-lg bg-card shadow-2xl sm:h-[90vh]">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-border p-3 sm:items-center sm:p-4">
          <div className="flex min-w-0 items-start gap-2 sm:items-center">
            <FileJson className="w-5 h-5 text-blue-500" />
            <h2 className="break-words text-base font-semibold sm:text-lg">
              Field Mapping: {sourceNode.data.actorName} →{" "}
              {targetNode.data.actorName}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 rounded-lg p-2 hover:bg-muted"
            aria-label="Close field mapping"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
          {/* Left Panel - Source Schema */}
          <div className="flex min-h-[240px] w-full flex-col border-b border-border lg:w-1/3 lg:border-b-0 lg:border-r">
            <div className="border-b border-border bg-blue-50 p-3 dark:bg-blue-950/30">
              <h3 className="font-semibold text-sm">Source Output Schema</h3>
              <p className="text-xs text-muted-foreground">
                {sourceNode.data.actorName}
              </p>
            </div>
            <div className="flex-1 overflow-auto p-4">
              {sourceNode.data.schema?.outputSchema ? (
                <>
                  <pre className="text-xs bg-gray-50 dark:bg-gray-900 p-3 rounded-lg overflow-x-auto border">
                    {JSON.stringify(sourceNode.data.schema.outputSchema, null, 2)}
                  </pre>
                  {sourceNode.data.output && (
                    <div className="mt-4">
                      <h4 className="text-sm font-semibold mb-2 text-green-600">
                        Sample Output
                      </h4>
                      <pre className="text-xs bg-gray-50 dark:bg-gray-900 p-3 rounded-lg overflow-x-auto border">
                        {JSON.stringify(
                          sourceNode.data.output as Record<string, unknown>,
                          null,
                          2
                        )}
                      </pre>
                    </div>
                  )}
                </>
              ) : (
                <div className="p-4 text-sm text-muted-foreground">
                  No output schema available for this node
                </div>
              )}
            </div>
          </div>

          {/* Center Panel - Field Mappings */}
          <div className="flex min-h-[320px] flex-1 flex-col">
            <div className="flex flex-col gap-2 border-b border-border bg-purple-50 p-3 dark:bg-purple-950/30 sm:flex-row sm:items-center sm:justify-between">
              <h3 className="font-semibold text-sm">Field Mappings</h3>
              <div className="flex gap-2">
                <button
                  onClick={() => setShowArrayConfig(!showArrayConfig)}
                  className={`px-3 py-1 text-xs rounded-lg flex items-center gap-1 ${
                    showArrayConfig
                      ? "bg-orange-500 text-white"
                      : "bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600"
                  }`}
                >
                  <Settings className="w-3 h-3" />
                  Array Iteration
                </button>
                <button
                  onClick={addFieldMapping}
                  className="px-3 py-1 text-xs bg-blue-500 text-white rounded-lg hover:bg-blue-600 flex items-center gap-1"
                >
                  <Plus className="w-3 h-3" />
                  Add Mapping
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-auto p-4 space-y-3">
              {/* Array Iteration Config */}
              {showArrayConfig && (
                <div className="bg-orange-50 dark:bg-orange-900/20 border border-orange-200 dark:border-orange-800 rounded-lg p-4">
                  <h4 className="font-semibold text-sm mb-3 flex items-center gap-2">
                    <Settings className="w-4 h-4" />
                    Array Iteration Settings
                  </h4>
                  <div className="space-y-3">
                    <div>
                      <label className="text-xs font-medium mb-1 block">
                        Source Array Path
                      </label>
                      <select
                        value={arrayIterationConfig?.sourceArrayPath || ""}
                        onChange={(e) =>
                          setArrayIterationConfig({
                            sourceArrayPath: e.target.value,
                            iterationMode:
                              arrayIterationConfig?.iterationMode ||
                              "sequential",
                            itemReferenceVariable:
                              arrayIterationConfig?.itemReferenceVariable ||
                              "_current_item",
                          })
                        }
                        className="w-full px-2 py-1 text-sm border dark:border-gray-600 rounded dark:bg-gray-700"
                      >
                        <option value="">Select array field...</option>
                        {/* Always include root array as first option */}
                        <option value="$[*]">$[*] (full output array)</option>
                        {sourceFieldPaths
                          .filter((path) => path.includes("[*]") && path !== "$[*]")
                          .map((path) => (
                            <option key={path} value={path}>
                              {path}
                            </option>
                          ))}
                      </select>
                    </div>

                    <div>
                      <label className="text-xs font-medium mb-1 block">
                        Iteration Mode
                      </label>
                      <select
                        value={
                          arrayIterationConfig?.iterationMode || "sequential"
                        }
                        onChange={(e) =>
                          setArrayIterationConfig(
                            (
                              prev: ArrayIterationConfig | undefined
                            ) => ({
                              ...prev!,
                              iterationMode: e.target.value as
                                | "sequential"
                                | "parallel"
                                | "batch",
                            })
                          )
                        }
                        className="w-full px-2 py-1 text-sm border dark:border-gray-600 rounded dark:bg-gray-700"
                        disabled={!arrayIterationConfig}
                      >
                        <option value="sequential">Sequential</option>
                        <option value="parallel">Parallel</option>
                        <option value="batch">Batch</option>
                      </select>
                    </div>

                    {arrayIterationConfig?.iterationMode === "batch" && (
                      <div>
                        <label className="text-xs font-medium mb-1 block">
                          Batch Size
                        </label>
                        <input
                          type="number"
                          value={arrayIterationConfig?.batchSize || 10}
                          onChange={(e) =>
                            setArrayIterationConfig(
                              (
                                prev: ArrayIterationConfig | undefined
                              ) => ({
                                ...prev!,
                                batchSize:
                                  parseInt(e.target.value) || 10,
                              })
                            )
                          }
                          className="w-full px-2 py-1 text-sm border dark:border-gray-600 rounded dark:bg-gray-700"
                          min="1"
                        />
                      </div>
                    )}

                    <div>
                      <label className="text-xs font-medium mb-1 block">
                        Item Reference Variable
                      </label>
                      <input
                        type="text"
                        value={
                          arrayIterationConfig?.itemReferenceVariable ||
                          "_current_item"
                        }
                        onChange={(e) =>
                          setArrayIterationConfig(
                            (
                              prev: ArrayIterationConfig | undefined
                            ) => ({
                              ...prev!,
                              itemReferenceVariable: e.target.value,
                            })
                          )
                        }
                        className="w-full px-2 py-1 text-sm border dark:border-gray-600 rounded dark:bg-gray-700"
                        placeholder="_current_item"
                      />
                      <p className="mt-1 text-xs text-muted-foreground">
                        Variable name to reference current item in expressions
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Field Mapping Cards */}
              {fieldMappings.length === 0 ? (
                <div className="py-12 text-center text-muted-foreground">
                  <FileJson className="w-12 h-12 mx-auto mb-3 opacity-50" />
                  <p className="text-sm">No field mappings yet</p>
                  <p className="text-xs mt-1">
                    Click &quot;Add Mapping&quot; to create your first field
                    mapping
                  </p>
                </div>
              ) : (
                fieldMappings.map((mapping, index) => (
                  <div
                    key={mapping.id}
                    className={`border rounded-lg p-3 ${
                      selectedMapping === mapping.id
                        ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20"
                        : "border-border hover:border-muted-foreground/40"
                    }`}
                    onClick={() => setSelectedMapping(mapping.id)}
                  >
                    <div className="flex items-start justify-between mb-3">
                      <span className="text-xs font-mono bg-gray-100 dark:bg-gray-700 px-2 py-1 rounded">
                        #{index + 1}
                      </span>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          removeFieldMapping(mapping.id);
                        }}
                        className="p-1 hover:bg-red-100 dark:hover:bg-red-900/20 rounded text-red-500"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>

                    <div className="space-y-2">
                      {/* Source Field Path */}
                      <div>
                        <label className="text-xs font-medium mb-1 block">
                          Source Field
                        </label>
                        <div className="flex gap-2">
                          <select
                            value={mapping.sourceFieldPath}
                            onChange={(e) =>
                              updateFieldMapping(mapping.id, {
                                sourceFieldPath: e.target.value,
                              })
                            }
                            className="flex-1 px-2 py-1 text-sm border dark:border-gray-600 rounded dark:bg-gray-700"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <option value="">Select field...</option>
                            {sourceFieldPaths.map((path) => (
                              <option key={path} value={path}>
                                {path}
                              </option>
                            ))}
                          </select>
                          <input
                            type="text"
                            value={mapping.sourceFieldPath}
                            onChange={(e) =>
                              updateFieldMapping(mapping.id, {
                                sourceFieldPath: normalizeJsonPath(e.target.value),
                              })
                            }
                            className="w-32 px-2 py-1 text-xs border dark:border-gray-600 rounded dark:bg-gray-700 font-mono"
                            placeholder="$.field.path"
                            onClick={(e) => e.stopPropagation()}
                          />
                        </div>
                      </div>

                      <div className="flex items-center justify-center py-1">
                        <ArrowRight className="w-4 h-4 text-muted-foreground" />
                      </div>

                      {/* Target Field Path */}
                      <div>
                        <label className="text-xs font-medium mb-1 block">
                          Target Field
                        </label>
                        <div className="flex gap-2">
                          <select
                            value={mapping.targetFieldPath}
                            onChange={(e) =>
                              updateFieldMapping(mapping.id, {
                                targetFieldPath: e.target.value,
                              })
                            }
                            className="flex-1 px-2 py-1 text-sm border dark:border-gray-600 rounded dark:bg-gray-700"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <option value="">Select field...</option>
                            {targetFieldPaths.map((path) => (
                              <option key={path} value={path}>
                                {path}
                              </option>
                            ))}
                          </select>
                          <input
                            type="text"
                            value={mapping.targetFieldPath}
                            onChange={(e) =>
                              updateFieldMapping(mapping.id, {
                                targetFieldPath: normalizeJsonPath(e.target.value),
                              })
                            }
                            className="w-32 px-2 py-1 text-xs border dark:border-gray-600 rounded dark:bg-gray-700 font-mono"
                            placeholder="$.field.path"
                            onClick={(e) => e.stopPropagation()}
                          />
                        </div>
                      </div>

                      {/* Transformation Type */}
                      <div>
                        <label className="text-xs font-medium mb-1 block">
                          Transformation
                        </label>
                        <select
                          value={mapping.transformationType}
                          onChange={(e) =>
                            updateFieldMapping(mapping.id, {
                              transformationType: e.target.value as
                                | "direct"
                                | "expression"
                                | "script",
                            })
                          }
                          className="w-full px-2 py-1 text-sm border dark:border-gray-600 rounded dark:bg-gray-700"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <option value="direct">Direct Copy</option>
                          <option value="expression">
                            Mustache Expression
                          </option>
                          <option value="script">JavaScript Script</option>
                        </select>
                      </div>

                      {/* Transformation Logic */}
                      {mapping.transformationType !== "direct" && (
                        <div>
                          <label className="text-xs font-medium mb-1 block flex items-center gap-1">
                            <Code className="w-3 h-3" />
                            {mapping.transformationType === "expression"
                              ? "Expression"
                              : "Script"}
                          </label>
                          <textarea
                            value={mapping.transformationLogic || ""}
                            onChange={(e) =>
                              updateFieldMapping(mapping.id, {
                                transformationLogic: e.target.value,
                              })
                            }
                            className="w-full px-2 py-1 text-xs border dark:border-gray-600 rounded dark:bg-gray-700 font-mono"
                            rows={3}
                            placeholder={
                              mapping.transformationType === "expression"
                                ? "{{firstName}} {{lastName}}"
                                : "return data.field.toUpperCase();"
                            }
                            onClick={(e) => e.stopPropagation()}
                          />
                        </div>
                      )}

                      {/* Error Strategy */}
                      <div className="flex gap-2">
                        <div className="flex-1">
                          <label className="text-xs font-medium mb-1 block">
                            Error Strategy
                          </label>
                          <select
                            value={mapping.errorStrategy}
                            onChange={(e) =>
                              updateFieldMapping(mapping.id, {
                                errorStrategy: e.target.value as
                                  | "skip"
                                  | "default"
                                  | "halt",
                              })
                            }
                            className="w-full px-2 py-1 text-sm border dark:border-gray-600 rounded dark:bg-gray-700"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <option value="skip">Skip on Error</option>
                            <option value="default">Use Default</option>
                            <option value="halt">Halt Execution</option>
                          </select>
                        </div>

                        {mapping.errorStrategy === "default" && (
                          <div className="flex-1">
                            <label className="text-xs font-medium mb-1 block">
                              Default Value
                            </label>
                            <input
                              type="text"
                              value={String(mapping.defaultValue ?? "")}
                              onChange={(e) =>
                                updateFieldMapping(mapping.id, {
                                  defaultValue: e.target.value,
                                })
                              }
                              className="w-full px-2 py-1 text-sm border dark:border-gray-600 rounded dark:bg-gray-700"
                              placeholder="null"
                              onClick={(e) => e.stopPropagation()}
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Right Panel - Target Schema */}
          <div className="flex min-h-[240px] w-full flex-col border-t border-border lg:w-1/3 lg:border-l lg:border-t-0">
            <div className="border-b border-border bg-emerald-50 p-3 dark:bg-emerald-950/30">
              <h3 className="font-semibold text-sm">Target Input Schema</h3>
              <p className="text-xs text-muted-foreground">
                {targetNode.data.actorName}
              </p>
            </div>
            <div className="flex-1 overflow-auto p-4">
              {targetNode.data.schema?.inputSchema ? (
                <pre className="text-xs bg-gray-50 dark:bg-gray-900 p-3 rounded-lg overflow-x-auto border">
                  {JSON.stringify(
                    targetNode.data.schema.inputSchema,
                    null,
                    2
                  )}
                </pre>
              ) : (
                <div className="p-4 text-sm text-muted-foreground">
                  No input schema available for this node
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex flex-col gap-3 border-t border-border bg-muted/40 p-3 sm:flex-row sm:items-center sm:justify-between sm:p-4">
          <div className="text-sm text-muted-foreground">
            {fieldMappings.length} field mapping
            {fieldMappings.length !== 1 ? "s" : ""} configured
          </div>
          <div className="flex gap-2 self-end">
            <button
              onClick={onClose}
              className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-muted"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-2 text-sm bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
              disabled={fieldMappings.length === 0}
            >
              Save Mapping
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default InputMapping;
