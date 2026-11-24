/* eslint-disable react-hooks/exhaustive-deps */
"use client";

import React, { useEffect, useMemo } from "react";
import { useAdminLeadflow } from "@/contexts/AdminLeadflowContext";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Card } from "@/components/ui/card";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Database, Users, FileText, Globe, MapPin } from "lucide-react";
import { ActorSchema } from "./types";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";

export default function ActorsSidebar() {
  const { availableActors, setAvailableActors, addNode } = useAdminLeadflow();
  const { toast } = useToast();

  const getActorName = (actor: ActorSchema) =>
    typeof actor.name === "string" && actor.name.trim()
      ? actor.name.trim()
      : "Unnamed actor";

  useEffect(() => {
    const loadActors = async () => {
      try {
        const data = await api.get<{ actors?: ActorSchema[] }>("/api/admin/leadflow/actors");
        setAvailableActors(data.actors || []);
      } catch {
        toast({ title: "Error", description: "Failed to load actors", variant: "destructive" });
      }
    };

    loadActors();
  }, [setAvailableActors]);

  const groupedActors = useMemo(() => {
    const categories: Record<string, { name: string; color: string; borderColor: string }> = {
      twitter: { name: "Twitter", color: "text-blue-500", borderColor: "border-blue-200" },
      facebook: { name: "Facebook", color: "text-blue-600", borderColor: "border-blue-200" },
      instagram: { name: "Instagram", color: "text-pink-500", borderColor: "border-pink-200" },
      linkedin: { name: "LinkedIn", color: "text-blue-700", borderColor: "border-blue-200" },
      google: { name: "Google Maps", color: "text-green-600", borderColor: "border-green-200" },
      justdial: { name: "JustDial", color: "text-orange-500", borderColor: "border-orange-200" },
      other: { name: "Other", color: "text-gray-500", borderColor: "border-gray-200" },
    };

    const grouped: Record<string, ActorSchema[]> = {
      twitter: [], facebook: [], instagram: [], linkedin: [], google: [], justdial: [], other: [],
    };

    // Names used in hardcoded Data Nodes section — exclude from dynamic accordion
    const dataNodesToExclude = ["save to leads", "save to posts", "saveToleads", "saveToPosts"];

    availableActors.forEach((actor) => {
      const name = getActorName(actor).toLowerCase();
      // Skip actors that are already shown in the hardcoded Data Nodes section
      if (dataNodesToExclude.some((n) => name.includes(n.toLowerCase()))) return;

      if (name.includes("twitter")) grouped.twitter.push(actor);
      else if (name.includes("facebook")) grouped.facebook.push(actor);
      else if (name.includes("instagram")) grouped.instagram.push(actor);
      else if (name.includes("linkedin")) grouped.linkedin.push(actor);
      else if (name.includes("google") || name.includes("maps")) grouped.google.push(actor);
      else if (name.includes("justdial") || name.includes("just dial")) grouped.justdial.push(actor);
      else grouped.other.push(actor);
    });

    return { categories, grouped };
  }, [availableActors]);

  const onDragStart = (event: React.DragEvent, nodeType: string, actorId?: string) => {
    event.dataTransfer.setData("application/reactflow", nodeType);
    if (actorId) event.dataTransfer.setData("actorId", actorId);
    event.dataTransfer.effectAllowed = "move";
  };

  const getCategoryIcon = (key: string) => {
    switch (key) {
      case "google": return <MapPin className="w-3 h-3" />;
      case "justdial": return <MapPin className="w-3 h-3 text-orange-500" />;
      default: return <Globe className="w-3 h-3" />;
    }
  };

  return (
    <Card className="w-full h-full flex flex-col border-0 rounded-none">
      <div className="px-4 py-3 border-b">
        <h3 className="font-semibold text-sm">Actors & Nodes</h3>
        <p className="mt-1 text-xs text-muted-foreground">Drag to canvas</p>
      </div>

      <ScrollArea className="flex-1 p-4">
        <div className="space-y-6">
          <div>
            <h4 className="mb-2 flex items-center gap-2 text-xs font-semibold text-foreground">
              <Database className="w-3 h-3" />
              Data Nodes
            </h4>
            <div className="space-y-2">
              <div
                draggable
                onDragStart={(e) => onDragStart(e, "saveToLeads")}
                onClick={() => addNode("saveToLeads")}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") addNode("saveToLeads");
                }}
                role="button"
                tabIndex={0}
                aria-label="Add Save to Leads node"
                className="cursor-move rounded-lg border border-purple-200 bg-card p-3 transition-all hover:border-purple-400 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:border-purple-900"
              >
                <div className="font-medium text-xs mb-1 flex items-center gap-1">
                  <Users className="w-3 h-3 text-purple-500" />
                  Save to Leads
                </div>
                <div className="text-xs text-muted-foreground">Save customer and company data to leads table</div>
              </div>
              <div
                draggable
                onDragStart={(e) => onDragStart(e, "saveToPosts")}
                onClick={() => addNode("saveToPosts")}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") addNode("saveToPosts");
                }}
                role="button"
                tabIndex={0}
                aria-label="Add Save to Posts node"
                className="cursor-move rounded-lg border border-emerald-200 bg-card p-3 transition-all hover:border-emerald-400 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring dark:border-emerald-900"
              >
                <div className="font-medium text-xs mb-1 flex items-center gap-1">
                  <FileText className="w-3 h-3 text-green-500" />
                  Save to Posts
                </div>
                <div className="text-xs text-muted-foreground">Save social media posts to posts table</div>
              </div>
            </div>
          </div>

          <Accordion type="multiple" className="w-full">
            {Object.entries(groupedActors.grouped).map(([categoryKey, actors]) => {
              if (actors.length === 0) return null;
              const category = groupedActors.categories[categoryKey];

              return (
                <AccordionItem key={categoryKey} value={categoryKey} className="border-0">
                  <AccordionTrigger className="px-0 py-2 hover:no-underline">
                    <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
                      {getCategoryIcon(categoryKey)}
                      {category.name}
                      <span className="ml-1 text-xs text-muted-foreground">({actors.length})</span>
                    </div>
                  </AccordionTrigger>
                  <AccordionContent className="px-0 pb-4">
                    <div className="space-y-2">
                      {actors.map((actor) => (
                        <div
                          key={actor.id}
                          draggable
                          onDragStart={(e) => onDragStart(e, "actor", actor.id)}
                          onClick={() => addNode("actor", actor)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") addNode("actor", actor);
                          }}
                          role="button"
                          tabIndex={0}
                          aria-label={`Add ${getActorName(actor)} node`}
                          className={`cursor-move rounded-lg border bg-card p-3 transition-all hover:border-purple-400 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${category.borderColor}`}
                        >
                          <div className="font-medium text-xs mb-1">{getActorName(actor)}</div>
                          <div className="line-clamp-2 text-xs text-muted-foreground">{actor.description}</div>
                        </div>
                      ))}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              );
            })}
          </Accordion>
        </div>
      </ScrollArea>
    </Card>
  );
}
