"use client";

import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { useAdminAuth } from "@/contexts/AdminAuthContext";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FileText,
  Plus,
  RefreshCw,
  Save,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { normalizeSlug as slugify } from "../../../../../../shared/slug";

interface PolicyPage {
  id: number;
  slug: string;
  title: string;
  contentMarkdown: string;
  published: boolean;
  updatedAt: string;
}

type RequestStatus = "pending" | "in_review" | "approved" | "rejected" | "completed";

interface AccountDeletionRequest {
  id: number;
  email: string;
  fullName: string | null;
  reason: string | null;
  status: RequestStatus;
  adminNotes: string | null;
  requestedAt: string;
  processedAt: string | null;
}

const STATUS_OPTIONS: RequestStatus[] = ["pending", "in_review", "approved", "rejected", "completed"];

export default function AdminPoliciesPage() {
  const { toast } = useToast();
  const { admin } = useAdminAuth();
  const canManagePolicies = admin?.role === "super_admin";

  const [policies, setPolicies] = useState<PolicyPage[]>([]);
  const [requests, setRequests] = useState<AccountDeletionRequest[]>([]);

  const [loadingPolicies, setLoadingPolicies] = useState(true);
  const [loadingRequests, setLoadingRequests] = useState(true);
  const [policiesError, setPoliciesError] = useState<string | null>(null);
  const [requestsError, setRequestsError] = useState<string | null>(null);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [updatingRequestId, setUpdatingRequestId] = useState<number | null>(null);

  const [activePolicyId, setActivePolicyId] = useState<number | null>(null);
  const [formTitle, setFormTitle] = useState("");
  const [formSlug, setFormSlug] = useState("");
  const [formPublished, setFormPublished] = useState(true);
  const [formMarkdown, setFormMarkdown] = useState("");

  const [requestDrafts, setRequestDrafts] = useState<Record<number, { status: RequestStatus; adminNotes: string }>>({});

  const activePolicy = useMemo(
    () => policies.find((p) => p.id === activePolicyId) || null,
    [policies, activePolicyId]
  );

  async function fetchPolicies() {
    try {
      setLoadingPolicies(true);
      setPoliciesError(null);
      const data = await api.get<PolicyPage[]>("/api/admin/policies");
      const list = Array.isArray(data) ? data : [];
      setPolicies(list);

      if (list.length > 0) {
        const selected = activePolicyId ? list.find((p) => p.id === activePolicyId) : list[0];
        if (selected) {
          setActivePolicyId(selected.id);
          setFormTitle(selected.title);
          setFormSlug(selected.slug);
          setFormPublished(selected.published);
          setFormMarkdown(selected.contentMarkdown);
        }
      } else {
        handleCreateNewPolicy();
      }
    } catch (error: unknown) {
      const message = (error instanceof Error ? error.message : null) || "Unable to fetch policies";
      setPoliciesError(message);
      toast({
        title: "Failed to load policies",
        description: message,
        variant: "destructive",
      });
    } finally {
      setLoadingPolicies(false);
    }
  }

  async function fetchDeletionRequests() {
    try {
      setLoadingRequests(true);
      setRequestsError(null);
      const data = await api.get<AccountDeletionRequest[]>("/api/admin/account-deletion-requests");
      const list = Array.isArray(data) ? data : [];
      setRequests(list);

      const draftMap: Record<number, { status: RequestStatus; adminNotes: string }> = {};
      list.forEach((row) => {
        draftMap[row.id] = {
          status: row.status,
          adminNotes: row.adminNotes || "",
        };
      });
      setRequestDrafts(draftMap);
    } catch (error: unknown) {
      const message = (error instanceof Error ? error.message : null) || "Unable to fetch deletion requests";
      setRequestsError(message);
      toast({
        title: "Failed to load deletion requests",
        description: message,
        variant: "destructive",
      });
    } finally {
      setLoadingRequests(false);
    }
  }

  useEffect(() => {
    fetchPolicies();
    fetchDeletionRequests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleCreateNewPolicy() {
    setActivePolicyId(null);
    setFormTitle("");
    setFormSlug("");
    setFormPublished(true);
    setFormMarkdown("# New Policy\n\nWrite your markdown policy content here.");
  }

  function handleSelectPolicy(policy: PolicyPage) {
    setActivePolicyId(policy.id);
    setFormTitle(policy.title);
    setFormSlug(policy.slug);
    setFormPublished(policy.published);
    setFormMarkdown(policy.contentMarkdown);
  }

  async function handleSavePolicy() {
    const title = formTitle.trim();
    const slug = slugify(formSlug || formTitle);
    const contentMarkdown = formMarkdown.trim();

    if (!title || !slug || !contentMarkdown) {
      toast({
        title: "Missing fields",
        description: "Title, slug, and markdown content are required.",
        variant: "destructive",
      });
      return;
    }

    setSavingPolicy(true);
    try {
      const payload = {
        title,
        slug,
        contentMarkdown,
        published: formPublished,
      };

      if (activePolicyId) {
        await api.put(`/api/admin/policies/${activePolicyId}`, payload);
        toast({ title: "Policy updated" });
      } else {
        const created = await api.post<PolicyPage>("/api/admin/policies", payload);
        setActivePolicyId(created.id);
        toast({ title: "Policy created" });
      }

      await fetchPolicies();
    } catch (error: unknown) {
      toast({
        title: "Failed to save policy",
        description: (error instanceof Error ? error.message : null) || "Unable to save policy",
        variant: "destructive",
      });
    } finally {
      setSavingPolicy(false);
    }
  }

  async function handleDeletePolicy() {
    if (!activePolicyId) return;

    const confirmed = window.confirm("Delete this policy? This action cannot be undone.");
    if (!confirmed) return;

    try {
      await api.delete(`/api/admin/policies/${activePolicyId}`);
      toast({ title: "Policy deleted" });
      setActivePolicyId(null);
      await fetchPolicies();
    } catch (error: unknown) {
      toast({
        title: "Failed to delete policy",
        description: (error instanceof Error ? error.message : null) || "Unable to delete policy",
        variant: "destructive",
      });
    }
  }

  async function handleUpdateRequest(requestId: number) {
    const draft = requestDrafts[requestId];
    if (!draft) return;

    setUpdatingRequestId(requestId);
    try {
      await api.patch(`/api/admin/account-deletion-requests/${requestId}`, {
        status: draft.status,
        adminNotes: draft.adminNotes,
      });
      toast({ title: "Deletion request updated" });
      await fetchDeletionRequests();
    } catch (error: unknown) {
      toast({
        title: "Failed to update request",
        description: (error instanceof Error ? error.message : null) || "Unable to update request",
        variant: "destructive",
      });
    } finally {
      setUpdatingRequestId(null);
    }
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-black tracking-tighter flex items-center gap-2">
            <FileText className="h-8 w-8 text-blue-600" />
            Policies & Account Deletion
          </h1>
          <p className="text-muted-foreground mt-1">
            Manage markdown legal pages and review user account deletion requests.
          </p>
        </div>
        <Button variant="outline" onClick={() => { fetchPolicies(); fetchDeletionRequests(); }} className="gap-2">
          <RefreshCw className="h-4 w-4" />
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle>Policy Pages</CardTitle>
            <CardDescription>Terms, privacy, refund, cancellation, and custom pages</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {canManagePolicies && (
              <Button variant="outline" className="w-full gap-2" onClick={handleCreateNewPolicy}>
                <Plus className="h-4 w-4" />
                New Policy
              </Button>
            )}

            {policiesError ? (
              <Alert variant="destructive"><AlertTitle>Policies could not be loaded</AlertTitle><AlertDescription className="mt-2 space-y-2"><span className="block">{policiesError}</span><Button variant="outline" size="sm" onClick={() => void fetchPolicies()}>Try again</Button></AlertDescription></Alert>
            ) : loadingPolicies ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
                <Spinner size="sm" label={null} className="mr-2" />
                Loading...
              </div>
            ) : policies.length === 0 ? (
              <p className="text-sm text-muted-foreground">No policy pages found.</p>
            ) : (
              <div className="space-y-2 max-h-[420px] overflow-auto pr-1">
                {policies.map((policy) => {
                  const selected = policy.id === activePolicyId;
                  return (
                    <button
                      key={policy.id}
                      onClick={() => handleSelectPolicy(policy)}
                      className={`w-full text-left rounded-lg border p-3 transition ${
                        selected ? "border-primary bg-primary/5" : "border-border hover:border-primary/40"
                      }`}
                    >
                      <p className="font-semibold text-sm line-clamp-1">{policy.title}</p>
                      <div className="mt-1 flex items-center gap-2">
                        <Badge variant="outline" className="text-[10px]">/{policy.slug}</Badge>
                        <Badge variant={policy.published ? "default" : "secondary"} className="text-[10px]">
                          {policy.published ? "Published" : "Draft"}
                        </Badge>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>

        {!policiesError && <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{activePolicy ? "Edit Policy" : "Create Policy"}</CardTitle>
            <CardDescription>Markdown editor with live preview</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="policy-title">Title</Label>
                <Input
                  id="policy-title"
                  disabled={!canManagePolicies}
                  value={formTitle}
                  onChange={(e) => {
                    setFormTitle(e.target.value);
                    if (!formSlug) {
                      setFormSlug(slugify(e.target.value));
                    }
                  }}
                  placeholder="Terms of Use"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="policy-slug">Slug</Label>
                <Input
                  id="policy-slug"
                  disabled={!canManagePolicies}
                  value={formSlug}
                  onChange={(e) => setFormSlug(slugify(e.target.value))}
                  placeholder="terms-of-use"
                />
              </div>
            </div>

            <div className="space-y-2 max-w-[240px]">
              <Label>Status</Label>
              <Select disabled={!canManagePolicies} value={formPublished ? "published" : "draft"} onValueChange={(v) => setFormPublished(v === "published")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="published">Published</SelectItem>
                  <SelectItem value="draft">Draft</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="policy-markdown">Markdown Content</Label>
                <Textarea
                  id="policy-markdown"
                  disabled={!canManagePolicies}
                  value={formMarkdown}
                  onChange={(e) => setFormMarkdown(e.target.value)}
                  rows={18}
                  className="font-mono text-xs"
                  placeholder="# Policy title\n\nWrite markdown content..."
                />
              </div>

              <div className="space-y-2">
                <Label>Preview</Label>
                <div className="rounded-lg border p-4 min-h-[360px] overflow-auto bg-background">
                  <article className="prose prose-sm dark:prose-invert max-w-none">
                    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                      {formMarkdown || "Nothing to preview yet."}
                    </ReactMarkdown>
                  </article>
                </div>
              </div>
            </div>

            {canManagePolicies ? (
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={handleSavePolicy} loading={savingPolicy} loadingText="Save Policy" className="gap-2">
                  <Save className="h-4 w-4" />
                  Save Policy
                </Button>
                {activePolicyId && (
                  <Button variant="destructive" onClick={handleDeletePolicy} className="gap-2">
                    <Trash2 className="h-4 w-4" />
                    Delete
                  </Button>
                )}
              </div>
            ) : (
              <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                Policy publishing is read-only for administrators. A super admin must approve legal-page changes.
              </p>
            )}
          </CardContent>
        </Card>}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-orange-500" />
            Account Deletion Requests
          </CardTitle>
          <CardDescription>Records are persisted in the database and can be reviewed here.</CardDescription>
        </CardHeader>
        <CardContent>
          {requestsError ? (
            <Alert variant="destructive"><AlertTitle>Deletion requests could not be loaded</AlertTitle><AlertDescription className="mt-2 flex flex-wrap items-center justify-between gap-3"><span>{requestsError}</span><Button variant="outline" size="sm" onClick={() => void fetchDeletionRequests()}>Try again</Button></AlertDescription></Alert>
          ) : loadingRequests ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground text-sm">
              <Spinner size="sm" label={null} className="mr-2" />
              Loading requests...
            </div>
          ) : requests.length === 0 ? (
            <p className="text-sm text-muted-foreground">No account deletion requests yet.</p>
          ) : (
            <div className="space-y-4">
              {requests.map((request) => {
                const draft = requestDrafts[request.id] || {
                  status: request.status,
                  adminNotes: request.adminNotes || "",
                };

                return (
                  <div key={request.id} className="rounded-lg border p-4 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="font-semibold text-sm">#{request.id} - {request.email}</p>
                        <p className="text-xs text-muted-foreground">
                          {request.fullName || "No name provided"} • Requested {new Date(request.requestedAt).toLocaleString()}
                        </p>
                      </div>
                      <Badge variant="outline" className="capitalize">
                        {request.status.replace("_", " ")}
                      </Badge>
                    </div>

                    {request.reason && (
                      <p className="text-sm text-muted-foreground rounded-md bg-muted/40 p-3">{request.reason}</p>
                    )}

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                      <div className="space-y-2">
                        <Label>Status</Label>
                        <Select
                          value={draft.status}
                          onValueChange={(value: RequestStatus) => {
                            setRequestDrafts((prev) => ({
                              ...prev,
                              [request.id]: {
                                ...draft,
                                status: value,
                              },
                            }));
                          }}
                        >
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {STATUS_OPTIONS.map((status) => (
                              <SelectItem key={status} value={status} className="capitalize">
                                {status.replace("_", " ")}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>

                      <div className="md:col-span-2 space-y-2">
                        <Label>Admin Notes</Label>
                        <Textarea
                          rows={3}
                          value={draft.adminNotes}
                          onChange={(e) => {
                            const value = e.target.value;
                            setRequestDrafts((prev) => ({
                              ...prev,
                              [request.id]: {
                                ...draft,
                                adminNotes: value,
                              },
                            }));
                          }}
                          placeholder="Internal notes about this request"
                        />
                      </div>
                    </div>

                    <Button
                      variant="outline"
                      onClick={() => handleUpdateRequest(request.id)}
                      loading={updatingRequestId === request.id}
                      loadingText="Updating..."
                    >
                      Update Request
                    </Button>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
