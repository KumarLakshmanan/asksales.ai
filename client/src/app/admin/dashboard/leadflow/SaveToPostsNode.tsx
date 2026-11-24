"use client";

import { memo } from "react";
import { Handle, Position, NodeProps } from "reactflow";
import { SaveToPostsNodeData } from "./types";
import { FileText, Settings, CheckCircle, XCircle } from "lucide-react";
import { useAdminLeadflow } from "@/contexts/AdminLeadflowContext";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

const SaveToPostsNode = memo(({ data, id }: NodeProps<SaveToPostsNodeData>) => {
  const { setSelectedNode, nodes } = useAdminLeadflow();

  const handleConfigure = () => {
    const node = nodes.find((n) => n.id === id);
    if (node) setSelectedNode(node);
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
        return <FileText className="w-4 h-4 text-green-400" />;
    }
  };

  const getStatusColor = () => {
    switch (data.status) {
      case "running":
        return "border-blue-500 bg-blue-50";
      case "success":
        return "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40";
      case "error":
        return "border-red-500 bg-red-50 dark:bg-red-950/40";
      default:
        return "border-emerald-300 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/30";
    }
  };

  return (
    <div className={`min-w-[200px] rounded-lg border-2 shadow-md ${getStatusColor()}`}>
      <Handle type="target" position={Position.Left} className="w-3 h-3" />
      <div className="px-4 py-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            {getStatusIcon()}
            <span className="font-semibold text-sm">Save to Posts</span>
          </div>
          <Button size="sm" variant="ghost" onClick={handleConfigure} className="h-6 w-6 p-0" aria-label="Configure save to posts">
            <Settings className="w-3 h-3" />
          </Button>
        </div>
        <div className="mb-2 text-xs text-muted-foreground">
          Target: <span className="font-mono">posts</span> table
        </div>
        {data.error && (
          <div className="mt-2 rounded bg-red-100 p-2 text-xs text-red-700 dark:bg-red-950/60 dark:text-red-300">{data.error}</div>
        )}
        {data.field_mapping && Object.keys(data.field_mapping).length > 0 && (
          <div className="mt-2 border-t border-border pt-2 text-xs text-muted-foreground">
            Mapped: {Object.keys(data.field_mapping).length} fields
          </div>
        )}
      </div>
    </div>
  );
});

SaveToPostsNode.displayName = "SaveToPostsNode";
export default SaveToPostsNode;
