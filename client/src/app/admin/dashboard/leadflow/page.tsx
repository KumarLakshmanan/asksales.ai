"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { AdminLeadflowProvider } from "@/contexts/AdminLeadflowContext";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ActorsSidebar from "./ActorsSidebar";
import NodeConfig from "./NodeConfig";
import ExecutionPanel from "./ExecutionPanel";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";

// Dynamically import the heavy ReactFlow canvas to avoid loading it in other admin page bundles
const Canvas = dynamic(() => import("./Canvas"), {
  loading: () => <Skeleton className="h-full w-full rounded-none" />,
  ssr: false,
});

export default function LeadflowPage() {
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const updateLayout = () => setIsDesktop(query.matches);
    updateLayout();
    query.addEventListener("change", updateLayout);
    return () => query.removeEventListener("change", updateLayout);
  }, []);

  return (
    <AdminLeadflowProvider>
      <div className="h-[calc(100svh-64px)] w-full overflow-hidden">
        {isDesktop ? (
          <ResizablePanelGroup direction="horizontal">
            <ResizablePanel defaultSize="22%" minSize="15%" maxSize="30%">
              <ActorsSidebar />
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize="53%" minSize="40%">
              <Canvas />
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize="25%" minSize="20%" maxSize="40%">
              <ExecutionPanel />
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : (
          <Tabs defaultValue="canvas" className="flex h-full min-h-0 flex-col">
            <TabsList className="grid h-auto w-full shrink-0 grid-cols-3 rounded-none border-b border-border bg-background p-1">
              <TabsTrigger value="actors" className="min-h-10 text-xs">Actors</TabsTrigger>
              <TabsTrigger value="canvas" className="min-h-10 text-xs">Canvas</TabsTrigger>
              <TabsTrigger value="logs" className="min-h-10 text-xs">Logs</TabsTrigger>
            </TabsList>
            <TabsContent value="actors" className="m-0 min-h-0 flex-1 overflow-hidden">
              <ActorsSidebar />
            </TabsContent>
            <TabsContent value="canvas" className="m-0 min-h-0 flex-1 overflow-hidden p-2">
              <Canvas />
            </TabsContent>
            <TabsContent value="logs" className="m-0 min-h-0 flex-1 overflow-hidden">
              <ExecutionPanel />
            </TabsContent>
          </Tabs>
        )}
        <NodeConfig />
      </div>
    </AdminLeadflowProvider>
  );
}
