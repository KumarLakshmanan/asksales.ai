"use client";

import React, { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/admin-api";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
import { ArrowLeft, BarChart3 } from "lucide-react";

const STATUSES = [
  { value: "draft", label: "Draft" },
  { value: "planned", label: "Planned" },
  { value: "active", label: "Active" },
  { value: "paused", label: "Paused" },
  { value: "completed", label: "Completed" },
];

interface UserOption {
  id: number;
  name: string;
  email: string;
  isApproved?: boolean;
}

export default function NewCampaignPage() {
  const router = useRouter();
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const [usersLoading, setUsersLoading] = useState(true);
  const [users, setUsers] = useState<UserOption[]>([]);
  const [form, setForm] = useState({
    userId: "",
    name: "",
    goal: "",
    budget: "",
    startDate: "",
    endDate: "",
    status: "draft",
  });

  useEffect(() => {
    let active = true;

    const loadUsers = async () => {
      try {
        const response = await api.get<
          UserOption[] | { users?: UserOption[]; data?: UserOption[] }
        >("/api/admin/users");
        if (!active) return;
        setUsers(
          Array.isArray(response)
            ? response
            : response.users || response.data || [],
        );
      } catch (error: unknown) {
        if (!active) return;
        toast({
          title: "Unable to load campaign owners",
          description:
            error instanceof Error ? error.message : "Please try again.",
          variant: "destructive",
        });
      } finally {
        if (active) setUsersLoading(false);
      }
    };

    loadUsers();
    return () => {
      active = false;
    };
  }, [toast]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!form.userId || !form.name.trim() || !form.goal.trim() || !form.budget || !form.startDate) {
      toast({
        title: "Validation Error",
        description: "Owner, name, goal, budget, and start date are required.",
        variant: "destructive",
      });
      return;
    }

    if (form.endDate && form.endDate < form.startDate) {
      toast({
        title: "Validation Error",
        description: "End date must be on or after the start date.",
        variant: "destructive",
      });
      return;
    }

    try {
      setLoading(true);
      const payload = {
        userId: Number(form.userId),
        name: form.name.trim(),
        goal: form.goal.trim(),
        status: form.status,
        budget: Number(form.budget),
        startDate: form.startDate,
        endDate: form.endDate || null,
      };
      await api.post("/api/admin/campaigns", payload);

      toast({ title: "Success", description: "Campaign created successfully" });
      router.push("/admin/dashboard/campaigns");
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Failed to create campaign";
      toast({ title: "Error", description: message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-4 sm:p-6 lg:p-8">
      <div className="flex items-start gap-3 sm:items-center sm:gap-4">
        <Button variant="ghost" size="icon" asChild className="shrink-0">
          <Link href="/admin/dashboard/campaigns" aria-label="Back to campaigns">
            <ArrowLeft className="h-5 w-5" />
          </Link>
        </Button>
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight sm:text-3xl">
            <BarChart3 className="h-7 w-7 text-primary sm:h-8 sm:w-8" />
            Create Campaign
          </h1>
          <p className="text-muted-foreground mt-1">
            Set up a new marketing campaign
          </p>
        </div>
      </div>

      <Card className="max-w-3xl shadow-sm">
        <CardHeader>
          <CardTitle>Campaign Details</CardTitle>
          <CardDescription>
            Configure the details for your new campaign
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="owner">Campaign Owner *</Label>
              <Select
                value={form.userId}
                onValueChange={(value) => setForm({ ...form, userId: value })}
                disabled={usersLoading || users.length === 0}
              >
                <SelectTrigger id="owner">
                  <SelectValue
                    placeholder={usersLoading ? "Loading users…" : "Select a user"}
                  />
                </SelectTrigger>
                <SelectContent>
                  {users.map((user) => (
                    <SelectItem key={user.id} value={String(user.id)}>
                      {user.name} · {user.email}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                The campaign is tenant-scoped to this user and will appear in their workspace.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="name">Campaign Name *</Label>
              <Input
                id="name"
                placeholder="Enter campaign name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="goal">Goal *</Label>
              <Textarea
                id="goal"
                placeholder="Describe the campaign goal..."
                rows={3}
                value={form.goal}
                onChange={(e) => setForm({ ...form, goal: e.target.value })}
                required
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="budget">Budget (INR, whole rupees) *</Label>
                <Input
                  id="budget"
                  type="number"
                  min="0"
                  step="1"
                  placeholder="0"
                  value={form.budget}
                  onChange={(e) => setForm({ ...form, budget: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="status">Status</Label>
                <Select
                  value={form.status}
                  onValueChange={(value) => setForm({ ...form, status: value })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select status" />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUSES.map((status) => (
                      <SelectItem key={status.value} value={status.value}>
                        {status.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="startDate">Start Date *</Label>
                <Input
                  id="startDate"
                  type="date"
                  value={form.startDate}
                  onChange={(e) =>
                    setForm({ ...form, startDate: e.target.value })
                  }
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="endDate">End Date</Label>
                <Input
                  id="endDate"
                  type="date"
                  value={form.endDate}
                  onChange={(e) =>
                    setForm({ ...form, endDate: e.target.value })
                  }
                />
              </div>
            </div>

            <div className="flex flex-col-reverse gap-3 pt-4 sm:flex-row">
              <Button
                type="submit"
                loading={loading}
                disabled={usersLoading || users.length === 0}
              >
                Create Campaign
              </Button>
              <Button type="button" variant="outline" asChild>
                <Link href="/admin/dashboard/campaigns">
                  Cancel
                </Link>
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
