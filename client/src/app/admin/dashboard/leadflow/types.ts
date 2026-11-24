import { Node, Edge } from "reactflow";

export interface ActorSchema {
  id: string;
  name: string;
  description: string;
  inputSchema: {
    properties?: Record<string, Record<string, unknown>>;
    required?: string[];
  };
  outputSchema?: {
    properties?: Record<string, unknown>;
  };
  iterationConfig?: {
    arrayPath?: string;
    mode?: "sequential" | "parallel" | "batch";
  };
}

export interface ActorNodeData {
  actorName: string;
  actorId?: string;
  schema?: ActorSchema;
  config: Record<string, unknown>;
  inputMapping?: Record<string, string>;
  status?: "idle" | "running" | "success" | "error";
  error?: string;
  output?: unknown;
}

export interface LLMNodeData {
  label: string;
  config?: {
    model?: string;
    temperature?: number;
    max_tokens?: number;
    prompt_template?: string;
  };
  status?: "idle" | "running" | "success" | "error";
  error?: string;
}

export interface SaveToLeadsNodeData {
  actorName?: string;
  actorId?: string;
  schema?: ActorSchema;
  field_mapping?: Record<string, string>;
  status?: "idle" | "running" | "success" | "error";
  error?: string;
}

export type SaveToPostsNodeData = SaveToLeadsNodeData;

export type CustomNodeData = ActorNodeData | LLMNodeData | SaveToLeadsNodeData | SaveToPostsNodeData;

export interface ConnectionMapping {
  sourceNodeId: string;
  targetNodeId: string;
  fieldMappings: {
    id: string;
    sourceFieldPath: string;
    targetFieldPath: string;
    transformationType: "direct" | "expression" | "script";
    transformationLogic?: string;
    errorStrategy: "skip" | "default" | "halt";
    defaultValue?: unknown;
  }[];
  arrayIterationConfig?: {
    sourceArrayPath: string;
    iterationMode: "sequential" | "parallel" | "batch";
    batchSize?: number;
    itemReferenceVariable?: string;
  };
}

export interface WorkflowDefinition {
  id?: number;
  name: string;
  description?: string;
  nodes: Node<CustomNodeData>[];
  edges: Edge[];
  mappings: ConnectionMapping[];
  createdAt?: Date;
  updatedAt?: Date;
}

export interface ExecutionLog {
  id: string;
  timestamp: Date;
  nodeId: string;
  nodeName: string;
  level: "info" | "success" | "warning" | "error";
  message: string;
  data?: unknown;
}

