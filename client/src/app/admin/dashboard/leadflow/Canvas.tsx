"use client";

import React, { useCallback, useRef, useState } from "react";
import ReactFlow, {
  Background,
  Controls,
  MiniMap,
  Panel,
  ReactFlowProvider,
  Edge,
  Node,
} from "reactflow";
import "reactflow/dist/style.css";
import {
  useAdminLeadflow,
  ConnectionMappingConfig,
} from "@/contexts/AdminLeadflowContext";
import ActorNode from "./ActorNode";
import SaveToLeadsNode from "./SaveToLeadsNode";
import SaveToPostsNode from "./SaveToPostsNode";
import WorkflowManager from "./WorkflowManager";
import InputMapping from "./InputMapping";
import InputParametersDialog from "./InputParametersDialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Play, Save, FolderOpen, Key } from "lucide-react";
import { ActorNodeData, ExecutionLog } from "./types";
import { useToast } from "@/hooks/use-toast";
import { api } from "@/lib/admin-api";

const nodeTypes = {
  actor: ActorNode,
  saveToLeads: SaveToLeadsNode,
  saveToPosts: SaveToPostsNode,
};

function CanvasContent() {
  const {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    onConnect,
    addNode,
    availableActors,
    workflowMappings,
    setWorkflowMappings,
    activeWorkflow,
    isExecuting,
    setIsExecuting,
    addExecutionLog,
    clearExecutionLogs,
  } = useAdminLeadflow();

  const { toast } = useToast();
  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const [saveDialogOpen, setSaveDialogOpen] = useState(false);
  const [loadDialogOpen, setLoadDialogOpen] = useState(false);
  const [mappingDialogOpen, setMappingDialogOpen] = useState(false);
  const [selectedEdge, setSelectedEdge] = useState<Edge | null>(null);
  const [inputParametersDialogOpen, setInputParametersDialogOpen] =
    useState(false);
  const [collectedInputs, setCollectedInputs] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [initialInputDefaults, setInitialInputDefaults] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [inputSchema, setInputSchema] = useState<Record<
    string,
    unknown
  > | null>(null);

  // Apify API key prompt
  const [apifyKeyDialogOpen, setApifyKeyDialogOpen] = useState(false);
  const [apifyCredentials, setApifyCredentials] = useState<Array<{ id: number; name: string; apiKey: string; isActive: boolean }>>([]);
  const [loadingCredentials, setLoadingCredentials] = useState(false);
  const [selectedCredentialId, setSelectedCredentialId] = useState<string>("");

  const handleRunWorkflow = useCallback(
    async (skipInputDialog = false) => {
      if (!activeWorkflow) {
        toast({
          title: "Error",
          description: "Please load a workflow first",
          variant: "destructive",
        });
        return;
      }

      if (nodes.length === 0) {
        toast({
          title: "Error",
          description: "Workflow has no nodes to execute",
          variant: "destructive",
        });
        return;
      }

      const nodesWithIncoming = new Set(edges.map((e) => e.target));
      const startNodeCandidates = nodes.filter(
        (n) => !nodesWithIncoming.has(n.id) && n.type === "actor"
      );
      const startNode =
        startNodeCandidates.length > 0
          ? startNodeCandidates[0]
          : nodes.find((n) => n.type === "actor");

      if (!startNode) {
        toast({
          title: "Error",
          description: "No actor node found in workflow",
          variant: "destructive",
        });
        return;
      }

      const nodeData = startNode?.data as Record<string, unknown> | undefined;
      const schema = (nodeData?.schema as Record<string, unknown> | undefined)
        || availableActors.find((a) => a.id === (nodeData?.actorId as string));
      const inSchema = schema?.inputSchema as Record<string, unknown> | undefined;
      const hasInputSchema =
        inSchema &&
        inSchema.properties &&
        Object.keys(inSchema.properties).length > 0;

      const inputMapping = (nodeData?.inputMapping as Record<string, unknown>) || {};
       
      const hasTemplateVariables = Object.values(inputMapping).some(
        (value: unknown) =>
          typeof value === "string" &&
          value.includes("{{") &&
          value.includes("}}")
      );

      if (
        (hasInputSchema || hasTemplateVariables) &&
        !collectedInputs &&
        !skipInputDialog
      ) {
        try {
          const templateVars = new Set<string>();
          Object.values(inputMapping).forEach((value: unknown) => {
            if (typeof value === "string") {
              const matches = value.matchAll(/\{\{([^}]+)\}\}/g);
              for (const match of matches) {
                templateVars.add(match[1].trim());
              }
            }
          });

          if (templateVars.size > 0) {
            const minimalSchema: { properties: Record<string, unknown>; required: string[] } = {
              properties: {},
              required: Array.from(templateVars),
            };

            const fullSchema = (inSchema?.properties || {}) as Record<string, unknown>;

            templateVars.forEach((varName) => {
              if (fullSchema[varName]) {
                minimalSchema.properties[varName] = fullSchema[varName];
              } else {
                minimalSchema.properties[varName] = {
                  title: varName
                    .replace(/_/g, " ")
                    .replace(/\b\w/g, (l: string) => l.toUpperCase()),
                  type:
                    varName.toLowerCase().includes("max") ||
                    varName.toLowerCase().includes("limit")
                      ? "integer"
                      : "string",
                  description: `Value for ${varName}`,
                };
              }
            });

            setInputSchema(minimalSchema);

            const defaults: Record<string, unknown> = {};
            templateVars.forEach((varName) => {
              const fieldSchema = fullSchema[varName] as
                | Record<string, unknown>
                | undefined;
              if (fieldSchema) {
                if (fieldSchema.prefill !== undefined) {
                  defaults[varName] =
                    Array.isArray(fieldSchema.prefill) &&
                    (fieldSchema.prefill as unknown[]).length > 0
                      ? (fieldSchema.prefill as unknown[])[0]
                      : fieldSchema.prefill;
                } else if (fieldSchema.default !== undefined) {
                  defaults[varName] = fieldSchema.default;
                } else if (fieldSchema.example !== undefined) {
                  defaults[varName] = fieldSchema.example;
                }
              }
            });
            setInitialInputDefaults(defaults);
          } else {
            setInputSchema(null);
            setInitialInputDefaults(null);
          }
        } catch {
          setInitialInputDefaults(null);
          setInputSchema(null);
        }

        setTimeout(() => {
          setInputParametersDialogOpen(true);
        }, 0);

        return;
      }

      // Execute the workflow
      try {
        setIsExecuting(true);
        clearExecutionLogs();
        addExecutionLog({
          id: `log_${Date.now()}`,
          timestamp: new Date(),
          nodeId: "workflow",
          nodeName: activeWorkflow.name,
          level: "info",
          message: `Starting workflow execution: ${activeWorkflow.name}`,
        });

        const requestBody: Record<string, unknown> = {
          nodes,
          edges,
          mappings: workflowMappings,
          apifyCredentialId: selectedCredentialId ? Number(selectedCredentialId) : undefined,
        };

        if (collectedInputs) {
          requestBody.inputParameters = collectedInputs;
        }

        const result = await api.post<{ logs?: ExecutionLog[] }>(
          `/api/admin/leadflow/workflows/${activeWorkflow.id}/execute`,
          requestBody
        );

        addExecutionLog({
          id: `log_${Date.now()}`,
          timestamp: new Date(),
          nodeId: "workflow",
          nodeName: activeWorkflow.name,
          level: "success",
          message: `Workflow completed successfully`,
        });
        if (result.logs) {
          result.logs.forEach((log: ExecutionLog) => addExecutionLog(log));
        }
        toast({
          title: "Success",
          description: "Workflow executed successfully",
        });
      } catch (error: unknown) {
        const errMsg =
          error instanceof Error ? error.message : String(error);
        addExecutionLog({
          id: `log_${Date.now()}`,
          timestamp: new Date(),
          nodeId: "workflow",
          nodeName: activeWorkflow?.name || "Unknown",
          level: "error",
          message: `Error: ${errMsg}`,
        });
        toast({
          title: "Error",
          description: errMsg || "Failed to execute workflow",
          variant: "destructive",
        });
      } finally {
        setIsExecuting(false);
        setCollectedInputs(null);
      }
    },
    [
      activeWorkflow,
      nodes,
      edges,
      workflowMappings,
      collectedInputs,
      setIsExecuting,
      clearExecutionLogs,
      addExecutionLog,
      toast,
      selectedCredentialId,
      availableActors,
    ]
  );

  const handleInputParametersSubmit = useCallback(
    (inputs: Record<string, unknown>) => {
      setCollectedInputs(inputs);
      setInputParametersDialogOpen(false);
      setTimeout(() => {
        handleRunWorkflow(true);
      }, 100);
    },
    [handleRunWorkflow]
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();

      const type = event.dataTransfer.getData("application/reactflow");
      const actorId = event.dataTransfer.getData("actorId");

      if (!type) return;

      if (type === "actor" && actorId) {
        const schema = availableActors.find((a) => a.id === actorId);
        if (schema) {
          addNode("actor", schema);
        }
      } else {
        addNode(type);
      }
    },
    [addNode, availableActors]
  );

  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const onEdgeClick = useCallback(
    (_event: React.MouseEvent, edge: Edge) => {
      const sourceNode = nodes.find((n) => n.id === edge.source);
      const targetNode = nodes.find((n) => n.id === edge.target);

      if (!sourceNode || !targetNode) return;

      if (
        sourceNode.type === "actor" &&
        (targetNode.type === "actor" ||
          targetNode.type === "saveToLeads" ||
          targetNode.type === "saveToPosts")
      ) {
        setSelectedEdge(edge);
        setMappingDialogOpen(true);
      }
    },
    [nodes]
  );

  const handleSaveMapping = useCallback(
    (mapping: ConnectionMappingConfig) => {
      const updatedMappings = workflowMappings?.connectionMappings || [];
      const existingIndex = updatedMappings.findIndex(
        (m) =>
          m.sourceNodeId === mapping.sourceNodeId &&
          m.targetNodeId === mapping.targetNodeId
      );

      if (existingIndex >= 0) {
        updatedMappings[existingIndex] = mapping;
      } else {
        updatedMappings.push(mapping);
      }

      setWorkflowMappings({
        ...workflowMappings,
        connectionMappings: updatedMappings,
      });
    },
    [workflowMappings, setWorkflowMappings]
  );

  const getNodesForMapping = useCallback(() => {
    if (!selectedEdge) return null;

    const sourceNode = nodes.find((n) => n.id === selectedEdge.source);
    const targetNode = nodes.find((n) => n.id === selectedEdge.target);

    if (!sourceNode || !targetNode || sourceNode.type !== "actor") {
      return null;
    }

    if (
      targetNode.type !== "actor" &&
      targetNode.type !== "saveToLeads" &&
      targetNode.type !== "saveToPosts"
    ) {
      return null;
    }

    return { sourceNode, targetNode };
  }, [selectedEdge, nodes]);

  const mappingNodes = getNodesForMapping();

  const existingMapping = mappingNodes
    ? workflowMappings?.connectionMappings?.find(
        (m) =>
          m.sourceNodeId === mappingNodes.sourceNode.id &&
          m.targetNodeId === mappingNodes.targetNode.id
      )
    : undefined;

  return (
    <div
      className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-lg border border-border bg-card"
      ref={reactFlowWrapper}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onEdgeClick={onEdgeClick}
        nodeTypes={nodeTypes}
        fitView={false}
        className="bg-muted/30"
        minZoom={0.1}
        maxZoom={2}
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
      >
        <Background />
        <Controls className="[&>button]:border-border [&>button]:bg-card [&>button]:fill-foreground [&>button:hover]:bg-accent" />
        <MiniMap
          nodeStrokeWidth={3}
          nodeColor="hsl(var(--muted-foreground))"
          nodeStrokeColor="hsl(var(--border))"
          maskColor="hsl(var(--background) / 0.72)"
          zoomable
          pannable
          className="hidden rounded-lg border border-border bg-card sm:block"
          style={{ backgroundColor: "hsl(var(--card))" }}
        />
        <Panel position="top-left" className="space-x-2">
          <Button
            size="sm"
            variant="outline"
            className="bg-card"
            onClick={() => setLoadDialogOpen(true)}
          >
            <FolderOpen className="w-4 h-4 mr-2" />
            Load
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="bg-card"
            onClick={() => setSaveDialogOpen(true)}
          >
            <Save className="w-4 h-4 mr-2" />
            Save
          </Button>
        </Panel>
        <Panel position="top-right" className="space-x-2">
          <Button
            size="sm"
            className="bg-gradient-to-r from-purple-600 to-purple-400"
            onClick={async () => {
              setLoadingCredentials(true);
              setApifyKeyDialogOpen(true);
              try {
                const data = await api.get<{ credentials?: Array<{ id: number; name: string; apiKey: string; isActive: boolean }>; data?: Array<{ id: number; name: string; apiKey: string; isActive: boolean }> }>("/api/admin/integrations?platform=apify");
                const creds = data.credentials || data.data || [];
                setApifyCredentials(creds);
                const active = creds.find((c) => c.isActive);
                if (active) setSelectedCredentialId(String(active.id));
              } catch {
                // silent fail — user can still manually pick
              } finally {
                setLoadingCredentials(false);
              }
            }}
            disabled={isExecuting}
          >
            <Play className="w-4 h-4 mr-2" />
            {isExecuting ? "Running..." : "Run Workflow"}
          </Button>
        </Panel>
      </ReactFlow>

      <WorkflowManager
        open={saveDialogOpen}
        onClose={() => setSaveDialogOpen(false)}
        mode="save"
      />
      <WorkflowManager
        open={loadDialogOpen}
        onClose={() => setLoadDialogOpen(false)}
        mode="load"
      />

      {/* Input Mapping Dialog */}
      {mappingNodes && (
        <InputMapping
          isOpen={mappingDialogOpen}
          onClose={() => {
            setMappingDialogOpen(false);
            setSelectedEdge(null);
          }}
          sourceNode={mappingNodes.sourceNode as Node<ActorNodeData>}
          targetNode={mappingNodes.targetNode as Node<ActorNodeData>}
          existingMapping={existingMapping}
          onSave={handleSaveMapping}
        />
      )}

      {/* Input Parameters Dialog */}
      <InputParametersDialog
        isOpen={inputParametersDialogOpen}
        onClose={() => {
          setInputParametersDialogOpen(false);
          setInputSchema(null);
        }}
        onSubmit={handleInputParametersSubmit}
        initialValues={initialInputDefaults}
        schema={inputSchema}
      />

      {/* Apify API Key Dialog */}
      <Dialog open={apifyKeyDialogOpen} onOpenChange={setApifyKeyDialogOpen}>
        <DialogContent className="sm:max-w-[440px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Key className="w-5 h-5 text-purple-600" />
              Select Apify API Key
            </DialogTitle>
            <DialogDescription>
              Choose an Apify API key from your integrations to use for this workflow run.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2 space-y-3">
            {loadingCredentials ? (
              <div role="status" className="flex items-center justify-center py-4 gap-2 text-sm text-muted-foreground">
                <Spinner size="sm" label={null} />
                Loading credentials...
              </div>
            ) : apifyCredentials.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                No Apify API keys found. Please add one in{" "}
                <a href="/admin/dashboard/integrations/apify" className="text-purple-600 underline">
                  Integrations → Apify
                </a>.
              </p>
            ) : (
              <>
                <Label>API Key</Label>
                <Select
                  value={selectedCredentialId}
                  onValueChange={(val) => {
                    setSelectedCredentialId(val);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select an API key..." />
                  </SelectTrigger>
                  <SelectContent>
                    {apifyCredentials.map((cred) => (
                      <SelectItem key={cred.id} value={String(cred.id)}>
                        <span className="flex items-center gap-2">
                          {cred.name}
                          {!cred.isActive && (
                            <span className="text-xs text-red-500">(inactive)</span>
                          )}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setApifyKeyDialogOpen(false)}>
              Cancel
            </Button>
            <Button
              className="bg-purple-600 hover:bg-purple-700"
              disabled={!selectedCredentialId || apifyCredentials.length === 0}
              onClick={() => {
                setApifyKeyDialogOpen(false);
                handleRunWorkflow();
              }}
            >
              Run Workflow
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function Canvas() {
  return (
    <ReactFlowProvider>
      <CanvasContent />
    </ReactFlowProvider>
  );
}
