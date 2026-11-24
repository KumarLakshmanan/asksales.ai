"use client";

import React, { createContext, useContext, useState, useCallback } from "react";
import {
  Node,
  Edge,
  OnNodesChange,
  OnEdgesChange,
  OnConnect,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  Connection,
} from "reactflow";
import {
  ActorSchema,
  ActorNodeData,
  CustomNodeData,
  ExecutionLog,
  WorkflowDefinition,
} from "@/app/admin/dashboard/leadflow/types";

export interface FieldMappingConfig {
  id: string;
  sourceFieldPath: string;
  targetFieldPath: string;
  transformationType: "direct" | "expression" | "script";
  transformationLogic?: string;
  errorStrategy: "skip" | "default" | "halt";
  defaultValue?: unknown;
}

export interface ArrayIterationConfig {
  sourceArrayPath: string;
  iterationMode: "sequential" | "parallel" | "batch";
  batchSize?: number;
  itemReferenceVariable?: string;
}

export interface ConnectionMappingConfig {
  sourceNodeId: string;
  targetNodeId: string;
  fieldMappings: FieldMappingConfig[];
  arrayIterationConfig?: ArrayIterationConfig;
}

export interface WorkflowMappings {
  connectionMappings: ConnectionMappingConfig[];
}

interface AdminLeadflowContextType {
  nodes: Node<CustomNodeData>[];
  edges: Edge[];
  onNodesChange: OnNodesChange;
  onEdgesChange: OnEdgesChange;
  onConnect: OnConnect;
  setNodes: React.Dispatch<React.SetStateAction<Node<CustomNodeData>[]>>;
  setEdges: React.Dispatch<React.SetStateAction<Edge[]>>;
  addNode: (type: string, schema?: ActorSchema) => void;
  deleteNode: (nodeId: string) => void;
  updateNodeData: (nodeId: string, data: Partial<CustomNodeData>) => void;
  selectedNode: Node<CustomNodeData> | null;
  setSelectedNode: (node: Node<CustomNodeData> | null) => void;
  availableActors: ActorSchema[];
  setAvailableActors: React.Dispatch<React.SetStateAction<ActorSchema[]>>;
  activeWorkflow: WorkflowDefinition | null;
  setActiveWorkflow: (workflow: WorkflowDefinition | null) => void;
  workflowMappings: WorkflowMappings;
  setWorkflowMappings: (mappings: WorkflowMappings) => void;
  isExecuting: boolean;
  setIsExecuting: (executing: boolean) => void;
  executionLogs: ExecutionLog[];
  addExecutionLog: (log: ExecutionLog) => void;
  clearExecutionLogs: () => void;
}

const AdminLeadflowContext = createContext<AdminLeadflowContextType | undefined>(undefined);

export function AdminLeadflowProvider({ children }: { children: React.ReactNode }) {
  const [nodes, setNodes] = useState<Node<CustomNodeData>[]>([]);
  const [edges, setEdges] = useState<Edge[]>([]);
  const [selectedNode, setSelectedNode] = useState<Node<CustomNodeData> | null>(null);
  const [availableActors, setAvailableActors] = useState<ActorSchema[]>([]);
  const [activeWorkflow, setActiveWorkflow] = useState<WorkflowDefinition | null>(null);
  const [workflowMappings, setWorkflowMappings] = useState<WorkflowMappings>({ connectionMappings: [] });
  const [isExecuting, setIsExecuting] = useState(false);
  const [executionLogs, setExecutionLogs] = useState<ExecutionLog[]>([]);

  const onNodesChange: OnNodesChange = useCallback(
    (changes) => setNodes((nds) => applyNodeChanges(changes, nds)),
    []
  );

  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) => setEdges((eds) => applyEdgeChanges(changes, eds)),
    []
  );

  const onConnect: OnConnect = useCallback(
    (connection: Connection) =>
      setEdges((eds) => addEdge({ ...connection, animated: true }, eds)),
    []
  );

  const addNode = useCallback(
    (type: string, schema?: ActorSchema) => {
      const id = `${type}_${Date.now()}`;
      const position = { x: 250 + nodes.length * 50, y: 100 + nodes.length * 50 };

      let data: CustomNodeData;
      switch (type) {
        case "actor":
          data = {
            actorName: schema?.name || "Actor",
            actorId: schema?.id,
            schema: schema,
            config: {},
            status: "idle",
          } as ActorNodeData;
          break;
        case "saveToLeads": {
          const saveLeadsSchema = availableActors.find((a) => a.id === "save-to-leads");
          data = {
            actorName: saveLeadsSchema?.name || "Save to Leads",
            actorId: "save-to-leads",
            schema: saveLeadsSchema,
            field_mapping: {},
            status: "idle",
          };
          break;
        }
        case "saveToPosts": {
          const savePostsSchema = availableActors.find((a) => a.id === "save-to-posts");
          data = {
            actorName: savePostsSchema?.name || "Save to Posts",
            actorId: "save-to-posts",
            schema: savePostsSchema,
            field_mapping: {},
            status: "idle",
          };
          break;
        }
        default:
          data = { field_mapping: {}, status: "idle" };
          break;
      }

      const newNode: Node<CustomNodeData> = { id, type, position, data };
      setNodes((prev) => [...prev, newNode]);
    },
    [nodes.length, availableActors]
  );

  const deleteNode = useCallback((nodeId: string) => {
    setNodes((prev) => prev.filter((n) => n.id !== nodeId));
    setEdges((prev) => prev.filter((e) => e.source !== nodeId && e.target !== nodeId));
  }, []);

  const updateNodeData = useCallback((nodeId: string, data: Partial<CustomNodeData>) => {
    setNodes((prev) =>
      prev.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, ...data } } : n))
    );
  }, []);

  const addExecutionLog = useCallback((log: ExecutionLog) => {
    setExecutionLogs((prev) => [...prev, log]);
  }, []);

  const clearExecutionLogs = useCallback(() => {
    setExecutionLogs([]);
  }, []);

  return (
    <AdminLeadflowContext.Provider
      value={{
        nodes,
        edges,
        onNodesChange,
        onEdgesChange,
        onConnect,
        setNodes,
        setEdges,
        addNode,
        deleteNode,
        updateNodeData,
        selectedNode,
        setSelectedNode,
        availableActors,
        setAvailableActors,
        activeWorkflow,
        setActiveWorkflow,
        workflowMappings,
        setWorkflowMappings,
        isExecuting,
        setIsExecuting,
        executionLogs,
        addExecutionLog,
        clearExecutionLogs,
      }}
    >
      {children}
    </AdminLeadflowContext.Provider>
  );
}

export function useAdminLeadflow() {
  const context = useContext(AdminLeadflowContext);
  if (context === undefined) {
    throw new Error("useAdminLeadflow must be used within an AdminLeadflowProvider");
  }
  return context;
}
