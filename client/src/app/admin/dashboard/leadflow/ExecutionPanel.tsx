"use client";

import { useAdminLeadflow } from "@/contexts/AdminLeadflowContext";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { CheckCircle, XCircle, AlertCircle, Info, Clock } from "lucide-react";
import { format } from "date-fns";
import { ExecutionLog } from "./types";

export default function ExecutionPanel() {
  const { executionLogs, isExecuting } = useAdminLeadflow();

  const getLogIcon = (level: string) => {
    switch (level) {
      case "success": return <CheckCircle className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />;
      case "error": return <XCircle className="w-4 h-4 text-red-600 dark:text-red-400" />;
      case "warning": return <AlertCircle className="w-4 h-4 text-amber-600 dark:text-amber-400" />;
      default: return <Info className="w-4 h-4 text-blue-600 dark:text-blue-400" />;
    }
  };

  const getLogColor = (level: string) => {
    switch (level) {
      case "success": return "bg-emerald-50 border-emerald-200 dark:bg-emerald-950/30 dark:border-emerald-900";
      case "error": return "bg-red-50 border-red-200 dark:bg-red-950/30 dark:border-red-900";
      case "warning": return "bg-amber-50 border-amber-200 dark:bg-amber-950/30 dark:border-amber-900";
      default: return "bg-blue-50 border-blue-200 dark:bg-blue-950/30 dark:border-blue-900";
    }
  };

  return (
    <Card className="w-full h-full flex flex-col border-0 rounded-none">
      <div className="px-4 py-3 border-b flex items-center justify-between">
        <h3 className="font-semibold text-sm">Execution Logs</h3>
        {isExecuting && (
          <Badge variant="outline" className="bg-blue-50 dark:bg-blue-950/30">
            <Clock className="w-3 h-3 mr-1 animate-pulse" />
            Running
          </Badge>
        )}
      </div>

      <ScrollArea className="flex-1 p-4">
        {executionLogs.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground">
            <Info className="w-8 h-8 mx-auto mb-2" />
            <p className="text-sm">No execution logs yet</p>
            <p className="text-xs mt-1">Run a workflow to see logs here</p>
          </div>
        ) : (
          <div className="space-y-2">
            {executionLogs.map((log: ExecutionLog) => (
              <div key={log.id} className={`p-3 rounded-lg border ${getLogColor(log.level)}`}>
                <div className="flex items-start gap-2">
                  {getLogIcon(log.level)}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-semibold">{log.nodeName}</span>
                      <span className="text-xs text-muted-foreground">
                        {format(new Date(log.timestamp), "HH:mm:ss")}
                      </span>
                    </div>
                    <p className="text-xs text-foreground">{String(log.message)}</p>
                    {log.data !== undefined && log.data !== null && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                          View data
                        </summary>
                        <pre className="mt-1 overflow-x-auto rounded border border-border bg-background p-2 text-xs text-foreground">
                          {JSON.stringify(log.data, null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </ScrollArea>
    </Card>
  );
}
