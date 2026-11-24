"use client";

import { useState, useEffect, useCallback } from "react";
import { Node, Edge, useReactFlow } from "reactflow";
import { useAdminLeadflow, type ConnectionMappingConfig } from "@/contexts/AdminLeadflowContext";
import type { WorkflowDefinition } from "./types";
import { api } from "@/lib/admin-api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useToast } from "@/hooks/use-toast";
import { Save, FolderOpen, Download, Trash2 } from "lucide-react";
import { ConfirmDialog } from "@/components/admin/ConfirmDialog";
import type { CustomNodeData, ConnectionMapping } from "./types";

interface WorkflowManagerProps {
  open: boolean;
  onClose: () => void;
  mode: "save" | "load";
}

interface SavedWorkflow {
  id: number;
  name: string;
  description?: string;
  nodes: Node<CustomNodeData>[];
  edges: Edge[];
  mappings: ConnectionMapping[];
  createdAt?: string;
  updatedAt?: string;
  fileName?: string;
  platform?: string;
}

export default function WorkflowManager({ open, onClose, mode }: WorkflowManagerProps) {
  const {
    nodes,
    edges,
    setNodes,
    setEdges,
    setActiveWorkflow,
    activeWorkflow,
    workflowMappings,
    setWorkflowMappings,
    availableActors,
  } = useAdminLeadflow();
  const { fitView } = useReactFlow();
  const { toast } = useToast();
  const [workflowName, setWorkflowName] = useState("");
  const [workflowDescription, setWorkflowDescription] = useState("");
  const [savedWorkflows, setSavedWorkflows] = useState<SavedWorkflow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<{
    open: boolean;
    workflow: SavedWorkflow | null;
  }>({ open: false, workflow: null });

  const fetchWorkflows = useCallback(async () => {
    setIsLoading(true);
    try {
      const data = await api.get<{ workflows: SavedWorkflow[] }>("/api/admin/leadflow/workflows");
      setSavedWorkflows(data.workflows);
    } catch {
      toast({
        title: "Error",
        description: "Failed to fetch workflows",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (open && mode === "load") {
      fetchWorkflows();
    }
    if (open && mode === "save" && activeWorkflow) {
      setWorkflowName(activeWorkflow.name);
      setWorkflowDescription(activeWorkflow.description || "");
    }
  }, [open, mode, activeWorkflow, fetchWorkflows]);

  const handleSave = async () => {
    if (!workflowName.trim()) {
      toast({
        title: "Validation Error",
        description: "Please enter a workflow name",
        variant: "destructive",
      });
      return;
    }

    setIsLoading(true);
    try {
      const mappingsToSave =
        workflowMappings?.connectionMappings || activeWorkflow?.mappings || [];

      // Strip full schema objects from actor nodes before saving — only keep actorId reference
      const nodesToSave = nodes.map((n) => {
        if (n.type === "actor") {
          const nodeData = n.data as Record<string, unknown>;
          const nodeSchema = nodeData.schema as Record<string, unknown> | undefined;
          return {
            ...n,
            data: {
              ...nodeData,
              actorId: nodeSchema?.id || nodeData.actorId,
            },
          };
        }
        return n;
      });

      const workflowData = {
        name: workflowName,
        description: workflowDescription,
        nodes: nodesToSave,
        edges,
        mappings: mappingsToSave,
      };

      const endpoint = activeWorkflow?.id
        ? `/api/admin/leadflow/workflows/${activeWorkflow.id}`
        : "/api/admin/leadflow/workflows";

      const data = activeWorkflow?.id
        ? await api.put<{ workflow: SavedWorkflow }>(endpoint, workflowData)
        : await api.post<{ workflow: SavedWorkflow }>(endpoint, workflowData);

      setActiveWorkflow(data.workflow as WorkflowDefinition);
      toast({
        title: "Success",
        description: activeWorkflow?.id
          ? "Workflow updated successfully"
          : "Workflow saved successfully",
      });
      onClose();
    } catch {
      toast({
        title: "Error",
        description: "Failed to save workflow",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleLoad = (workflow: SavedWorkflow) => {
    // Re-hydrate actor node schemas from availableActors using actorId
    const SCHEMA_NODE_TYPES = ["actor", "saveToLeads", "saveToPosts"];
    const NODE_ID_MAP: Record<string, string> = {
      saveToLeads: "save-to-leads",
      saveToPosts: "save-to-posts",
    };
    const nodesWithSchemas = workflow.nodes.map((n) => {
      if (SCHEMA_NODE_TYPES.includes(n.type ?? "")) {
        const nodeData = n.data as Record<string, unknown>;
        if (!nodeData.schema) {
          const lookupId = nodeData.actorId || NODE_ID_MAP[n.type ?? ""];
          const schema = lookupId ? availableActors.find((a) => a.id === lookupId) : undefined;
          if (schema) {
            return {
              ...n,
              data: {
                ...nodeData,
                actorId: lookupId,
                actorName: nodeData.actorName || schema.name,
                schema,
              },
            };
          }
        }
      }
      return n;
    });
    setNodes(nodesWithSchemas as Node<CustomNodeData>[]);
    setEdges(workflow.edges);
    // Fit viewport to show all loaded nodes
    setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 100);

    const workflowDefinition = {
      ...workflow,
      createdAt: workflow.createdAt ? new Date(workflow.createdAt) : undefined,
      updatedAt: workflow.updatedAt ? new Date(workflow.updatedAt) : undefined,
    };

    setActiveWorkflow(workflowDefinition);

    if (workflow.mappings && Array.isArray(workflow.mappings)) {
        const connectionMappings: ConnectionMappingConfig[] = workflow.mappings.map((m) => ({
          sourceNodeId: m.sourceNodeId || "",
          targetNodeId: m.targetNodeId || "",
          fieldMappings: (m.fieldMappings || []).map((fm) => ({
          id:
            fm.id ||
            `fm_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          sourceFieldPath:
            fm.sourceFieldPath || "",
          targetFieldPath:
            fm.targetFieldPath || "",
          transformationType: ((fm.transformationType as string) || "direct") as "direct" | "expression" | "script",
          transformationLogic: fm.transformationLogic || "",
          errorStrategy: ((fm.errorStrategy as string) || "skip") as "skip" | "default" | "halt",
          defaultValue: fm.defaultValue,
        })),
        arrayIterationConfig: m.arrayIterationConfig,
      }));
      setWorkflowMappings({ connectionMappings });
    } else {
      setWorkflowMappings({ connectionMappings: [] });
    }

    toast({
      title: "Success",
      description: `Loaded workflow: ${workflow.name}`,
    });
    onClose();
  };

  const handleExportJSON = async () => {
    const exportData = {
      name: workflowName,
      description: workflowDescription,
      nodes,
      edges,
      mappings: [],
      exportedAt: new Date().toISOString(),
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${workflowName.replace(/\s+/g, "_")}_workflow.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    toast({
      title: "Success",
      description: "Workflow exported as JSON",
    });
  };

  const handleDelete = async (id: string) => {
    setDeleteConfirm({ open: false, workflow: null });

    try {
      await api.delete(`/api/admin/leadflow/workflows/${id}`);
      toast({
        title: "Success",
        description: "Workflow deleted successfully",
      });
      fetchWorkflows();
    } catch {
      toast({
        title: "Error",
        description: "Failed to delete workflow",
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle>
            {mode === "save" ? "Save Workflow" : "Load Workflow"}
          </DialogTitle>
          <DialogDescription>
            {mode === "save"
              ? "Save your current workflow for later use"
              : "Choose a workflow to load"}
          </DialogDescription>
        </DialogHeader>

        {mode === "save" ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Workflow Name *</Label>
              <Input
                id="name"
                value={workflowName}
                onChange={(e) => setWorkflowName(e.target.value)}
                placeholder="Enter workflow name"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                value={workflowDescription}
                onChange={(e) => setWorkflowDescription(e.target.value)}
                placeholder="Enter workflow description (optional)"
                rows={3}
              />
            </div>

            <div className="text-sm text-muted-foreground">
              <p>Nodes: {nodes.length}</p>
              <p>Connections: {edges.length}</p>
            </div>
          </div>
        ) : (
          <ScrollArea className="h-96">
            {isLoading ? (
              <div className="text-center py-8">Loading workflows...</div>
            ) : savedWorkflows.length === 0 ? (
              <div className="py-8 text-center text-muted-foreground">
                No saved workflows found
              </div>
            ) : (
              <div className="space-y-2">
                {savedWorkflows.map((workflow) => (
                  <div
                    key={workflow.id}
                    className="rounded-lg border border-border p-4 transition-colors hover:bg-muted/50"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <h3 className="font-semibold">{workflow.name}</h3>
                        {workflow.description && (
                          <p className="mt-1 text-sm text-muted-foreground">
                            {workflow.description}
                          </p>
                        )}
                        <div className="mt-2 text-xs text-muted-foreground">
                          Nodes: {workflow.nodes.length} | Edges:{" "}
                          {workflow.edges.length}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground/80">
                          Updated:{" "}
                          {workflow.updatedAt
                            ? new Date(workflow.updatedAt).toLocaleString()
                            : "N/A"}
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleLoad(workflow)}
                        >
                          <FolderOpen className="w-4 h-4 mr-1" />
                          Load
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setDeleteConfirm({ open: true, workflow })
                          }
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {mode === "save" && (
            <>
              <Button
                variant="outline"
                onClick={handleExportJSON}
                disabled={!workflowName.trim()}
              >
                <Download className="w-4 h-4 mr-2" />
                Export JSON
              </Button>
              <Button
                onClick={handleSave}
                disabled={isLoading || !workflowName.trim()}
                className="bg-gradient-to-r from-purple-600 to-purple-400"
              >
                <Save className="w-4 h-4 mr-2" />
                {activeWorkflow?.id ? "Update" : "Save"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>

      <ConfirmDialog
        open={deleteConfirm.open}
        onOpenChange={(isOpen: boolean) =>
          setDeleteConfirm((prev) => ({ ...prev, open: isOpen }))
        }
        onConfirm={() =>
          deleteConfirm.workflow &&
          handleDelete(deleteConfirm.workflow.id.toString())
        }
        title="Delete Workflow"
        description={`Are you sure you want to delete "${deleteConfirm.workflow?.name || "this workflow"}"? This action cannot be undone.`}
        confirmText="Delete"
        cancelText="Cancel"
        variant="destructive"
      />
    </Dialog>
  );
}
