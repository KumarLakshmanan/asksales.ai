"use client";

import React, { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { LoadingState } from "@/components/ui/loading-state";
import { SearchInput } from "@/components/ui/search-input";
import { PageErrorState } from "@/components/ui/page-state";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import { ArrowLeft, Layout } from "lucide-react";

interface Template {
  id: number;
  name?: string;
  type?: string;
  category?: string;
  usageCount?: number;
  usage_count?: number;
  createdAt?: string;
  created_at?: string;
}

export default function UserTemplatesPage() {
  const params = useParams();
  const id = params.id as string;
  const { toast } = useToast();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const fetchTemplates = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const data = await api.get<Template[] | { templates?: Template[]; data?: Template[] }>(`/api/admin/users/${id}/templates`);
      setTemplates(
        Array.isArray(data) ? data : data.templates || data.data || []
      );
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to load templates";
      setLoadError(message);
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [id, toast]);

  useEffect(() => {
    fetchTemplates();
  }, [fetchTemplates]);

  const filteredTemplates = templates.filter((t) =>
    (t.name || "").toLowerCase().includes(searchQuery.toLowerCase())
  );

  if (loading) {
    return <LoadingState size="page" label="Loading templates…" />;
  }


  if (loadError) {
    return <PageErrorState title="Templates could not be loaded" description={loadError} reset={() => void fetchTemplates()} />;
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex items-start gap-2 sm:gap-4">
        <Button asChild variant="ghost" size="icon" className="shrink-0">
          <Link href={`/admin/dashboard/users/${id}/view`} aria-label="Back to user details">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <div className="min-w-0">
          <h1 className="text-xl font-black tracking-tighter sm:text-2xl">User Templates</h1>
          <p className="text-muted-foreground mt-1">
            Templates created by this user
          </p>
        </div>
      </div>

      <SearchInput
        aria-label="Search templates"
        placeholder="Search templates..."
        value={searchQuery}
        onValueChange={setSearchQuery}
        wrapperClassName="sm:max-w-md"
      />

      {filteredTemplates.length === 0 ? (
        <div className="text-center py-12">
          <Layout className="h-12 w-12 mx-auto text-muted-foreground/50 mb-3" />
          <p className="text-muted-foreground">No templates found</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table className="min-w-[620px]">
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Usage Count</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredTemplates.map((template) => (
                <TableRow key={template.id}>
                  <TableCell className="font-medium">
                    {template.name || "—"}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="capitalize">
                      {template.type || "—"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <span className="text-muted-foreground capitalize">
                      {template.category || "—"}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="font-medium">
                      {template.usageCount ?? template.usage_count ?? 0}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="text-sm text-muted-foreground">
        Showing {filteredTemplates.length} of {templates.length} templates
      </div>
    </div>
  );
}
