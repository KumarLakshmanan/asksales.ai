"use client";

import { memo } from "react";
import { Handle, Position, NodeProps } from "reactflow";
import { ActorNodeData } from "./types";
import { Settings, Play, CheckCircle, XCircle } from "lucide-react";
import { useAdminLeadflow } from "@/contexts/AdminLeadflowContext";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

const ActorNode = memo(({ data, id }: NodeProps<ActorNodeData>) => {
  const { setSelectedNode, nodes } = useAdminLeadflow();

  const handleConfigure = () => {
    const node = nodes.find((n) => n.id === id);
    if (node) {
      setSelectedNode(node);
    }
  };

  const getStatusIcon = () => {
    switch (data.status) {
      case "running":
        return <Spinner size="sm" label={null} className="text-blue-500" />;
      case "success":
        return <CheckCircle className="w-4 h-4 text-green-500" />;
      case "error":
        return <XCircle className="w-4 h-4 text-red-500" />;
      default:
        return <Play className="w-4 h-4 text-muted-foreground" />;
    }
  };

  const getStatusColor = () => {
    switch (data.status) {
      case "running":
        return "border-blue-500 bg-blue-50 dark:bg-blue-950/40";
      case "success":
        return "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40";
      case "error":
        return "border-red-500 bg-red-50 dark:bg-red-950/40";
      default:
        return "border-border bg-card";
    }
  };

  return (
    <div className={`min-w-[200px] rounded-lg border-2 shadow-md ${getStatusColor()}`}>
      <Handle type="target" position={Position.Left} className="w-3 h-3" />
      <div className="px-4 py-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            {getStatusIcon()}
            <span className="font-semibold text-sm">{data.actorName}</span>
          </div>
          <Button size="sm" variant="ghost" onClick={handleConfigure} className="h-6 w-6 p-0" aria-label={`Configure ${data.actorName}`}>
            <Settings className="w-3 h-3" />
          </Button>
        </div>
        <div className="mb-2 text-xs text-muted-foreground">
          {data.schema?.description || "Actor node"}
        </div>
        {data.error && (
          <div className="mt-2 rounded bg-red-100 p-2 text-xs text-red-700 dark:bg-red-950/60 dark:text-red-300">{data.error}</div>
        )}
        {data.config && Object.keys(data.config).length > 0 && (
          <div className="mt-2 border-t border-border pt-2 text-xs text-muted-foreground">
            Configured: {Object.keys(data.config).length} fields
          </div>
        )}
      </div>
      <Handle type="source" position={Position.Right} className="w-3 h-3" />
    </div>
  );
});

ActorNode.displayName = "ActorNode";
export default ActorNode;
