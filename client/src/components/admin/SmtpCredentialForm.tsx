"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Eye, EyeOff, Mail, Send } from "lucide-react";
import { LoadingState } from "@/components/ui/loading-state";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/lib/admin-api";

interface SmtpCredentialFormProps {
  credentialId?: number;
}

interface ResendCredOption {
  id: number;
  name: string;
  apiKey: string;
}

interface ResendDomain {
  id: string;
  name: string;
  status: string;
}

export default function SmtpCredentialForm({ credentialId }: SmtpCredentialFormProps) {
  const router = useRouter();
  const { toast } = useToast();

  const [loading, setLoading] = useState(!!credentialId);
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  // Provider type: smtp or resend
  const [providerType, setProviderType] = useState<"smtp" | "resend">("smtp");

  // SMTP fields
  const [formName, setFormName] = useState("SMTP Settings");
  const [formHost, setFormHost] = useState("smtp.gmail.com");
  const [formPort, setFormPort] = useState(587);
  const [formSecure, setFormSecure] = useState(false);
  const [formUsername, setFormUsername] = useState("");
  const [formPassword, setFormPassword] = useState("");
  const [formFromName, setFormFromName] = useState("");
  const [formFromEmail, setFormFromEmail] = useState("");
  const [formPriority, setFormPriority] = useState("normal");

  // Resend fields
  const [resendCredentials, setResendCredentials] = useState<ResendCredOption[]>([]);
  const [selectedResendCredId, setSelectedResendCredId] = useState<string>("");
  const [resendDomains, setResendDomains] = useState<ResendDomain[]>([]);
  const [selectedDomain, setSelectedDomain] = useState<string>("");
  const [resendUsername, setResendUsername] = useState("");
  const [resendFromName, setResendFromName] = useState("");
  const [loadingDomains, setLoadingDomains] = useState(false);
  const [loadingResendCreds, setLoadingResendCreds] = useState(false);

  // Fetch existing Resend API keys when provider type is "resend"
  useEffect(() => {
    if (providerType !== "resend") return;
    const fetchResendCredentials = async () => {
      try {
        setLoadingResendCreds(true);
        const data = await api.get<{ credentials?: ResendCredOption[] }>("/api/admin/integrations?platform=resend");
        const creds = data.credentials || [];
        setResendCredentials(creds);
      } catch {
        toast({ title: "Error", description: "Failed to load Resend credentials", variant: "destructive" });
      } finally {
        setLoadingResendCreds(false);
      }
    };
    fetchResendCredentials();
  }, [providerType, toast]);

  // Fetch domains when a Resend credential is selected
  useEffect(() => {
    if (!selectedResendCredId) {
      setResendDomains([]);
      setSelectedDomain("");
      return;
    }
    const fetchDomains = async () => {
      try {
        setLoadingDomains(true);
        const data = await api.get<{ domains?: ResendDomain[] }>(
          `/api/admin/integrations/resend-domains?credentialId=${selectedResendCredId}`
        );
        setResendDomains(data.domains || []);
      } catch {
        toast({ title: "Error", description: "Failed to load domains from Resend", variant: "destructive" });
      } finally {
        setLoadingDomains(false);
      }
    };
    fetchDomains();
  }, [selectedResendCredId, toast]);

  // Load existing credential for edit mode
  useEffect(() => {
    if (!credentialId) return;

    const fetchCredential = async () => {
      try {
        const data = await api.get<Record<string, unknown>>(`/api/admin/integrations/${credentialId}/full`);
        const cred = (data.credential || data) as Record<string, unknown>;
        const config = (cred.config || {}) as Record<string, unknown>;

        if (config.provider === "resend") {
          setProviderType("resend");
          setFormName((cred.name as string) || "Resend Email");
          setResendFromName((config.fromName as string) || "");
          setResendUsername((config.fromEmail as string)?.split("@")[0] || "");
          setSelectedDomain((config.fromEmail as string)?.split("@")[1] || "");
          setFormPriority((cred.priority as string) || "normal");
          if (config.resendCredentialId) {
            setSelectedResendCredId(String(config.resendCredentialId));
          }
        } else {
          setProviderType("smtp");
          setFormName((cred.name as string) || "SMTP Settings");
          setFormHost((config.host as string) || "smtp.gmail.com");
          setFormPort((config.port as number) || 587);
          setFormSecure((config.secure as boolean) || false);
          setFormUsername("");
          setFormPassword("");
          setFormFromName((config.fromName as string) || "");
          setFormFromEmail((config.fromEmail as string) || "");
          setFormPriority((cred.priority as string) || "normal");
        }
      } catch {
        toast({ title: "Error", description: "Failed to load settings", variant: "destructive" });
        router.push("/admin/dashboard/integrations/smtp");
      } finally {
        setLoading(false);
      }
    };
    fetchCredential();
  }, [credentialId, router, toast]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (providerType === "resend") {
      if (!selectedResendCredId) {
        toast({ title: "Error", description: "Please select a Resend API key", variant: "destructive" });
        return;
      }
      if (!selectedDomain) {
        toast({ title: "Error", description: "Please select a domain", variant: "destructive" });
        return;
      }
      if (!resendUsername.trim()) {
        toast({ title: "Error", description: "Please enter an email username", variant: "destructive" });
        return;
      }
      if (!resendFromName.trim()) {
        toast({ title: "Error", description: "Please enter a sender name", variant: "destructive" });
        return;
      }

      const fromEmail = `${resendUsername.trim()}@${selectedDomain}`;
      const config = {
        provider: "resend",
        fromName: resendFromName.trim(),
        fromEmail,
        resendCredentialId: Number(selectedResendCredId),
        domain: selectedDomain,
      };
      const payload: Record<string, unknown> = {
        platform: "smtp",
        name: formName || "Resend Email",
        priority: formPriority,
        config,
        apiKey: fromEmail,
        apiSecret: "resend",
      };

      try {
        setSubmitting(true);
        if (credentialId) {
          await api.put(`/api/admin/integrations/${credentialId}`, payload);
        } else {
          await api.post("/api/admin/integrations", payload);
        }
        toast({
          title: "Success",
          description: credentialId ? "Resend email settings updated" : "Resend email settings added",
        });
        router.push("/admin/dashboard/integrations/smtp");
      } catch (error: unknown) {
        toast({ title: "Error", description: (error as Error).message || "Failed to save", variant: "destructive" });
      } finally {
        setSubmitting(false);
      }
      return;
    }

    // SMTP flow
    if (!formName.trim() || !formHost.trim()) {
      toast({ title: "Error", description: "Name and SMTP host are required", variant: "destructive" });
      return;
    }
    if (!credentialId && (!formUsername || !formPassword)) {
      toast({
        title: "Error",
        description: "Username and password are required for new SMTP configurations",
        variant: "destructive",
      });
      return;
    }

    try {
      setSubmitting(true);
      const config = {
        host: formHost,
        port: formPort,
        secure: formSecure,
        fromName: formFromName,
        fromEmail: formFromEmail,
      };
      const payload: Record<string, unknown> = {
        platform: "smtp",
        name: formName,
        priority: formPriority,
        config,
      };
      if (formUsername) payload.apiKey = formUsername;
      if (formPassword) payload.apiSecret = formPassword;

      if (credentialId) {
        await api.put(`/api/admin/integrations/${credentialId}`, payload);
      } else {
        await api.post("/api/admin/integrations", payload);
      }

      toast({
        title: "Success",
          description: credentialId
          ? "SMTP settings updated successfully"
          : "SMTP settings added successfully",
      });
      router.push("/admin/dashboard/integrations/smtp");
    } catch (error: unknown) {
      toast({
        title: "Error",
        description: (error as Error).message || "Failed to save SMTP settings",
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return (
      <LoadingState size="page" className="min-h-[400px]" label="Loading email settings…" />
    );
  }

  const verifiedDomains = resendDomains.filter(d => d.status === "verified");

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-4 sm:p-6">
      <div className="flex items-start gap-2 sm:gap-4">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => router.push("/admin/dashboard/integrations/smtp")}
          className="shrink-0"
          aria-label="Back to email credentials"
        >
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="min-w-0">
          <h1 className="text-xl font-black tracking-tight sm:text-2xl">
            {credentialId ? "Edit" : "Add"} Email Settings
          </h1>
          <p className="text-muted-foreground text-sm">
            Configure SMTP or Resend for OTP emails and notifications
          </p>
        </div>
      </div>

      {/* Provider Type Selector */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
        <button
          type="button"
          onClick={() => setProviderType("smtp")}
          className={`flex items-center gap-3 p-4 rounded-lg border-2 transition-colors ${
            providerType === "smtp"
              ? "border-primary bg-primary/5"
              : "border-border hover:border-muted-foreground/30"
          }`}
        >
          <div className={`p-2 rounded-lg ${providerType === "smtp" ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
            <Mail className="h-5 w-5" />
          </div>
          <div className="text-left">
            <div className="font-medium">SMTP</div>
            <div className="text-xs text-muted-foreground">Traditional email server</div>
          </div>
        </button>
        <button
          type="button"
          onClick={() => setProviderType("resend")}
          className={`flex items-center gap-3 p-4 rounded-lg border-2 transition-colors ${
            providerType === "resend"
              ? "border-primary bg-primary/5"
              : "border-border hover:border-muted-foreground/30"
          }`}
        >
          <div className={`p-2 rounded-lg ${providerType === "resend" ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
            <Send className="h-5 w-5" />
          </div>
          <div className="text-left">
            <div className="font-medium">Resend</div>
            <div className="text-xs text-muted-foreground">API-based email delivery</div>
          </div>
        </button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>
            {credentialId ? "Update" : "New"} {providerType === "resend" ? "Resend" : "SMTP"} Settings
          </CardTitle>
          <CardDescription>
            {providerType === "resend"
              ? "Select a Resend API key, pick a verified domain, and set the sender email."
              : credentialId
              ? "Update your SMTP settings. Leave username/password blank to keep existing credentials."
              : "Add new SMTP settings for system emails."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="space-y-6">
            <div className="space-y-2">
              <Label htmlFor="name">Settings Name</Label>
              <Input
                id="name"
                placeholder={providerType === "resend" ? "Resend Email" : "Primary SMTP"}
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
              />
            </div>

            {providerType === "resend" ? (
              <>
                {/* Resend API Key Selector */}
                <div className="space-y-2">
                  <Label>Resend API Key</Label>
                  {loadingResendCreds ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground">
                      <Spinner size="sm" label={null} />
                      Loading Resend credentials...
                    </div>
                  ) : resendCredentials.length === 0 ? (
                    <div className="p-3 rounded-lg border border-dashed text-sm text-muted-foreground">
                      No Resend API keys found. Please add one in{" "}
                      <button
                        type="button"
                        className="text-primary underline"
                        onClick={() => router.push("/admin/dashboard/integrations/resend")}
                      >
                        Integrations &gt; Resend
                      </button>{" "}
                      first.
                    </div>
                  ) : (
                    <Select value={selectedResendCredId} onValueChange={setSelectedResendCredId}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select a Resend API key" />
                      </SelectTrigger>
                      <SelectContent>
                        {resendCredentials.map((c) => (
                          <SelectItem key={c.id} value={String(c.id)}>
                            {c.name} ({c.apiKey})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>

                {/* Domain Selector */}
                {selectedResendCredId && (
                  <div className="space-y-2">
                    <Label>Domain</Label>
                    {loadingDomains ? (
                      <div className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Spinner size="sm" label={null} />
                        Fetching domains...
                      </div>
                    ) : verifiedDomains.length === 0 ? (
                      <div className="p-3 rounded-lg border border-dashed text-sm text-muted-foreground">
                        {resendDomains.length > 0
                          ? `${resendDomains.length} domain(s) found but none verified. Please verify your domains in Resend first.`
                          : "No domains found for this API key. Please add a domain in Resend first."}
                      </div>
                    ) : (
                      <Select value={selectedDomain} onValueChange={setSelectedDomain}>
                        <SelectTrigger>
                          <SelectValue placeholder="Select a domain" />
                        </SelectTrigger>
                        <SelectContent>
                          {verifiedDomains.map((d) => (
                            <SelectItem key={d.id} value={d.name}>
                              {d.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  </div>
                )}

                {/* Email Username + Domain Preview */}
                {selectedDomain && (
                  <>
                    <div className="space-y-2">
                      <Label htmlFor="resendUsername">Sender Email</Label>
                      <div className="flex min-w-0 items-center gap-0">
                        <Input
                          id="resendUsername"
                          placeholder="noreply"
                          value={resendUsername}
                          onChange={(e) => setResendUsername(e.target.value.replace(/[^a-zA-Z0-9._+-]/g, ""))}
                          className="min-w-0 rounded-r-none"
                        />
                        <div className="flex h-9 max-w-[55%] items-center truncate whitespace-nowrap rounded-r-md border border-l-0 bg-muted px-3 text-sm text-muted-foreground">
                          @{selectedDomain}
                        </div>
                      </div>
                      {resendUsername && (
                        <p className="text-xs text-muted-foreground">
                          Emails will be sent from: <strong>{resendUsername}@{selectedDomain}</strong>
                        </p>
                      )}
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="resendFromName">Sender Name</Label>
                      <Input
                        id="resendFromName"
                        placeholder="Sales & Marketing"
                        value={resendFromName}
                        onChange={(e) => setResendFromName(e.target.value)}
                      />
                      <p className="text-xs text-muted-foreground">
                        Display name shown to email recipients
                      </p>
                    </div>
                  </>
                )}
              </>
            ) : (
              <>
                {/* SMTP Fields */}
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="host">SMTP Host</Label>
                    <Input
                      id="host"
                      placeholder="smtp.gmail.com"
                      value={formHost}
                      onChange={(e) => setFormHost(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="port">Port</Label>
                    <Input
                      id="port"
                      type="number"
                      placeholder="587"
                      value={formPort}
                      onChange={(e) => setFormPort(parseInt(e.target.value) || 587)}
                    />
                  </div>
                </div>

                <div className="flex flex-row items-center justify-between rounded-lg border p-4">
                  <div className="space-y-0.5">
                    <Label className="text-base">Use SSL/TLS</Label>
                    <p className="text-sm text-muted-foreground">
                      Enable for port 465 (SSL), disable for port 587 (STARTTLS)
                    </p>
                  </div>
                  <Switch checked={formSecure} onCheckedChange={setFormSecure} />
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="username">
                      Username / Email
                      {credentialId && (
                        <span className="ml-1 text-muted-foreground font-normal text-xs">(leave blank to keep)</span>
                      )}
                    </Label>
                    <Input
                      id="username"
                      placeholder="your@email.com"
                      value={formUsername}
                      onChange={(e) => setFormUsername(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="password">
                      Password / App Password
                      {credentialId && (
                        <span className="ml-1 text-muted-foreground font-normal text-xs">(leave blank to keep)</span>
                      )}
                    </Label>
                    <div className="relative">
                      <Input
                        id="password"
                        type={showPassword ? "text" : "password"}
                        placeholder="••••••••"
                        className="pr-10"
                        value={formPassword}
                        onChange={(e) => setFormPassword(e.target.value)}
                      />
                      <button
                        type="button"
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                        aria-label={showPassword ? "Hide SMTP password" : "Show SMTP password"}
                        onClick={() => setShowPassword(!showPassword)}
                      >
                        {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="fromName">From Name</Label>
                    <Input
                      id="fromName"
                      placeholder="Sales & Marketing"
                      value={formFromName}
                      onChange={(e) => setFormFromName(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="fromEmail">From Email</Label>
                    <Input
                      id="fromEmail"
                      type="email"
                      placeholder="noreply@example.com"
                      value={formFromEmail}
                      onChange={(e) => setFormFromEmail(e.target.value)}
                    />
                  </div>
                </div>
              </>
            )}

            <div className="space-y-2">
              <Label htmlFor="priority">Priority</Label>
              <Select onValueChange={setFormPriority} value={formPriority}>
                <SelectTrigger>
                  <SelectValue placeholder="Select priority" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="high">High (used first)</SelectItem>
                  <SelectItem value="normal">Normal</SelectItem>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="fallback">Fallback (used last)</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Higher priority settings are tried first
              </p>
            </div>

            <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row">
              <Button type="submit" loading={submitting} className="w-full sm:w-auto">
                {credentialId ? "Update Settings" : "Add Settings"}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => router.push("/admin/dashboard/integrations/smtp")}
                className="w-full sm:w-auto"
              >
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
