"use client";

import { useState, useCallback, useEffect, useRef, type SetStateAction } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { AlertCircle, CreditCard, Save, Check, Eye, EyeOff, ExternalLink, QrCode, Building2, Link2, Wallet, Upload } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { api, buildApiUrl } from "@/lib/api";
import { normalizeUploadUrl } from "@/lib/utils";
import { isSafeExternalBookingUrl } from "@/lib/hotel-booking-url";
import { useBusinessProfiles } from "@/hooks/use-business-profiles";
import { LoadingState } from "@/components/ui/loading-state";
import { Callout } from "@/components/ui/callout";
import { CopyButton } from "@/components/ui/copy-button";

interface PaymentMethods {
  online: {
    enabled: boolean;
  };
  upiQr: {
    enabled: boolean;
    upiId: string;
    payeeName: string;
    qrImageUrl: string;
  };
  bankTransfer: {
    enabled: boolean;
    bankName: string;
    payeeName: string;
    accountNumber: string;
    ifscCode: string;
  };
  customLink: {
    enabled: boolean;
    url: string;
    linkTitle: string;
  };
  manual: {
    enabled: boolean;
    instructions: string;
  };
}

interface PaymentSettings {
  configured: boolean;
  paymentMethodsEnabled: boolean;
  externalBooking: {
    url: string;
    linkTitle: string;
  };
  provider: "mock" | "razorpay";
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  hasSecret: boolean;
  hasWebhookSecret: boolean;
  allowMock: boolean;
  methods: PaymentMethods;
}

const defaultMethods: PaymentMethods = {
  online: { enabled: true },
  upiQr: { enabled: false, upiId: "", payeeName: "", qrImageUrl: "" },
  bankTransfer: { enabled: false, bankName: "", payeeName: "", accountNumber: "", ifscCode: "" },
  customLink: { enabled: false, url: "", linkTitle: "" },
  manual: { enabled: false, instructions: "" },
};

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function PaymentsTab() {
  const { toast } = useToast();
  const { activeProfile, isLoading: authorityLoading } = useBusinessProfiles();
  const canManage = !authorityLoading && (activeProfile?.role === 'owner' || activeProfile?.role === 'billing_admin');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showKeySecret, setShowKeySecret] = useState(false);
  const [showWebhookSecret, setShowWebhookSecret] = useState(false);
  const [uploadingQr, setUploadingQr] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const qrInputRef = useRef<HTMLInputElement>(null);
  const editRevision = useRef(0);
  const loadSequence = useRef(0);
  const alive = useRef(true);
  const saveInFlight = useRef(false);

  const [settings, applySettings] = useState<PaymentSettings>({
    configured: false,
    paymentMethodsEnabled: true,
    externalBooking: { url: "", linkTitle: "Continue your booking" },
    provider: "razorpay",
    keyId: "",
    keySecret: "",
    webhookSecret: "",
    hasSecret: false,
    hasWebhookSecret: false,
    allowMock: false,
    methods: defaultMethods,
  });
  const setSettings = (update: SetStateAction<PaymentSettings>) => {
    if (!canManage) return;
    editRevision.current += 1;
    applySettings(update);
  };

  const loadSettings = useCallback(async () => {
    const sequence = ++loadSequence.current;
    const revision = editRevision.current;
    try {
      setLoading(true);
      setLoadError(null);
      const r = await api.get<{ settings: PaymentSettings }>("/api/hotel/payment-settings");
      if (!alive.current || sequence !== loadSequence.current || revision !== editRevision.current) return;
      if (r.settings) {
        const allowMock = r.settings.allowMock === true;
        const provider = r.settings.provider === "mock" && allowMock ? "mock" : "razorpay";
        applySettings({
          configured: r.settings.configured === true,
          paymentMethodsEnabled: r.settings.paymentMethodsEnabled !== false,
          externalBooking: {
            url: r.settings.externalBooking?.url ?? "",
            linkTitle: r.settings.externalBooking?.linkTitle ?? "Continue your booking",
          },
          provider,
          keyId: r.settings.keyId || "",
          keySecret: "",
          webhookSecret: "",
          hasSecret: r.settings.hasSecret || false,
          hasWebhookSecret: r.settings.hasWebhookSecret || false,
          allowMock,
          methods: {
            online: {
              enabled: r.settings.methods?.online?.enabled ?? true,
            },
            upiQr: {
              enabled: r.settings.methods?.upiQr?.enabled ?? false,
              upiId: r.settings.methods?.upiQr?.upiId ?? "",
              payeeName: r.settings.methods?.upiQr?.payeeName ?? "",
              qrImageUrl: r.settings.methods?.upiQr?.qrImageUrl ?? "",
            },
            bankTransfer: {
              enabled: r.settings.methods?.bankTransfer?.enabled ?? false,
              bankName: r.settings.methods?.bankTransfer?.bankName ?? "",
              payeeName: r.settings.methods?.bankTransfer?.payeeName ?? "",
              accountNumber: r.settings.methods?.bankTransfer?.accountNumber ?? "",
              ifscCode: r.settings.methods?.bankTransfer?.ifscCode ?? "",
            },
            customLink: {
              enabled: r.settings.methods?.customLink?.enabled ?? false,
              url: r.settings.methods?.customLink?.url ?? "",
              linkTitle: r.settings.methods?.customLink?.linkTitle ?? "",
            },
            manual: {
              enabled: r.settings.methods?.manual?.enabled ?? false,
              instructions: r.settings.methods?.manual?.instructions ?? "",
            },
          }
        });
      }
    } catch (error) {
      if (alive.current && sequence === loadSequence.current) setLoadError(errorMessage(error, "Unable to load payment settings."));
    } finally {
      if (alive.current && sequence === loadSequence.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void loadSettings();
    return () => { alive.current = false; loadSequence.current += 1; };
  }, [loadSettings]);

  const saveSettings = async () => {
    if (!canManage) { toast({ title: 'Payment settings are read-only', description: 'Ask the business owner or billing admin to make changes.', variant: 'destructive' }); return; }
    if (saveInFlight.current) return;
    const methods = settings.methods;
    if (!settings.paymentMethodsEnabled && !isSafeExternalBookingUrl(settings.externalBooking.url.trim())) {
      toast({
        title: "Valid booking page required",
        description: "External booking mode requires a public, credential-free HTTPS URL.",
        variant: "destructive",
      });
      return;
    }
    if (settings.paymentMethodsEnabled && !Object.values(methods).some((method) => method.enabled)) {
      toast({ title: "Choose a payment method", description: "Enable at least one guest payment method.", variant: "destructive" });
      return;
    }
    if (
      settings.paymentMethodsEnabled
      && methods.online.enabled
      && settings.provider === "razorpay"
      && (!settings.keyId.trim() || (!settings.keySecret && !settings.hasSecret) || (!settings.webhookSecret && !settings.hasWebhookSecret))
    ) {
      toast({
        title: "Razorpay setup is incomplete",
        description: "A key ID, key secret, and webhook secret are required for verified online payments.",
        variant: "destructive",
      });
      return;
    }
    if (settings.paymentMethodsEnabled && methods.upiQr.enabled && (!methods.upiQr.upiId.trim() || !methods.upiQr.payeeName.trim() || !methods.upiQr.qrImageUrl)) {
      toast({ title: "UPI setup is incomplete", description: "Add the UPI ID, payee name, and QR image.", variant: "destructive" });
      return;
    }
    if (
      settings.paymentMethodsEnabled
      && methods.bankTransfer.enabled
      && (!methods.bankTransfer.bankName.trim() || !methods.bankTransfer.payeeName.trim() || !methods.bankTransfer.accountNumber.trim() || !methods.bankTransfer.ifscCode.trim())
    ) {
      toast({ title: "Bank transfer setup is incomplete", description: "Complete all beneficiary and account fields.", variant: "destructive" });
      return;
    }
    if (settings.paymentMethodsEnabled && methods.customLink.enabled) {
      try {
        const customUrl = new URL(methods.customLink.url);
        if (customUrl.protocol !== "https:" || customUrl.username || customUrl.password) throw new Error();
      } catch {
        toast({ title: "Invalid payment link", description: "Use a credential-free HTTPS URL.", variant: "destructive" });
        return;
      }
    }
    if (settings.paymentMethodsEnabled && methods.manual.enabled && !methods.manual.instructions.trim()) {
      toast({ title: "Instructions required", description: "Explain how guests should complete a manual payment.", variant: "destructive" });
      return;
    }

    const submittedRevision = editRevision.current;
    saveInFlight.current = true;
    setSaving(true);
    try {
      await api.post("/api/hotel/payment-settings", {
        paymentMethodsEnabled: settings.paymentMethodsEnabled,
        externalBooking: settings.externalBooking,
        provider: settings.provider,
        keyId: settings.keyId,
        keySecret: settings.keySecret,
        webhookSecret: settings.webhookSecret,
        methods,
      });
      if (!alive.current) return;
      const newerEdits = submittedRevision !== editRevision.current;
      toast({
        title: "Booking payment settings saved",
        description: newerEdits ? "The submitted settings were saved. Your newer edits remain unsaved."
          : settings.paymentMethodsEnabled
          ? "New bookings will use the enabled payment methods."
          : "Confirmed room selections will continue on the external booking page.",
      });
      if (!newerEdits) await loadSettings();
    } catch (error) {
      if (alive.current) toast({ title: "Save outcome not confirmed", description: `${errorMessage(error, "Unable to confirm the save.")} Your draft is retained; review the saved state before retrying.`, variant: "destructive" });
    } finally {
      saveInFlight.current = false;
      if (alive.current) setSaving(false);
    }
  };

  const handleQrUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!canManage) { e.target.value = ''; return; }
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast({ title: "Invalid QR image", description: "Choose a PNG, JPEG, WebP, or GIF image.", variant: "destructive" });
      e.target.value = "";
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast({ title: "QR image is too large", description: "Choose an image smaller than 5 MB.", variant: "destructive" });
      e.target.value = "";
      return;
    }
    setUploadingQr(true);
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await api.upload<{ url: string }>("/api/hotel/upload-qr", formData);
      if (res.url) {
        setSettings(prev => ({
          ...prev,
          methods: {
            ...prev.methods,
            upiQr: {
              ...prev.methods.upiQr,
              qrImageUrl: res.url
            }
          }
        }));
        toast({ title: "QR Code uploaded successfully!" });
      }
    } catch (error) {
      toast({ title: "Upload failed", description: errorMessage(error, "Unable to upload the QR image."), variant: "destructive" });
    } finally {
      setUploadingQr(false);
      if (qrInputRef.current) qrInputRef.current.value = "";
    }
  };

  const showCopyFailed = () => {
    toast({ title: "Copy failed", description: "Select and copy the value manually.", variant: "destructive" });
  };

  const updateMethod = <K extends keyof PaymentMethods>(
    methodKey: K,
    fields: Partial<PaymentMethods[K]>
  ) => {
    setSettings(prev => ({
      ...prev,
      methods: {
        ...prev.methods,
        [methodKey]: {
          ...prev.methods[methodKey],
          ...fields
        }
      }
    }));
  };

  if (loading) {
    return (
      <LoadingState size="section" label="Loading payment settings…" />
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-destructive/30 bg-destructive/5 py-12 text-center">
        <AlertCircle className="mb-3 h-8 w-8 text-destructive" aria-hidden="true" />
        <h3 className="font-semibold">Payment settings unavailable</h3>
        <p className="mt-1 max-w-md text-sm text-muted-foreground">{loadError}</p>
        <Button type="button" variant="outline" className="mt-4" onClick={() => void loadSettings()}>
          Retry
        </Button>
      </div>
    );
  }

  const webhookUrl = buildApiUrl("/api/webhooks/razorpay");

  return (
    <div className="space-y-6">
      {!canManage && <p role="status" className="rounded-lg border p-4 text-sm">
        {authorityLoading ? 'Checking payment settings permissions…' : 'Only the business owner or billing admin can change payment settings. This form is read-only.'}
      </p>}
      <fieldset disabled={!canManage} className="min-w-0 space-y-6">
      {!settings.configured && settings.paymentMethodsEnabled && (
        <Callout tone="warning" title="Payment setup needs attention">
          Configure at least one complete method before accepting bookings. Manual confirmations do not issue refunds automatically.
        </Callout>
      )}
      <Card className="rounded-xl border border-border/50 shadow-sm overflow-hidden">
        <CardHeader className="bg-muted/10 border-b border-border/40 pb-4">
          <div className="flex items-center justify-between gap-6">
            <div className="space-y-1">
              <CardTitle className="text-base font-semibold">Payment methods</CardTitle>
              <CardDescription className="text-xs">
                {settings.paymentMethodsEnabled
                  ? "Create an internal booking hold and complete payment using the configured methods below."
                  : "Send the hotel’s external booking page only after availability, price, guest details, and the final booking summary are confirmed."}
              </CardDescription>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <Label htmlFor="hotel-payment-mode" className="text-sm">
                {settings.paymentMethodsEnabled ? "Enabled" : "Disabled"}
              </Label>
              <Switch
                id="hotel-payment-mode"
                aria-label="Enable internal hotel payment methods"
                checked={settings.paymentMethodsEnabled}
                onCheckedChange={(checked) => setSettings((current) => ({
                  ...current,
                  paymentMethodsEnabled: checked,
                }))}
              />
            </div>
          </div>
        </CardHeader>
      </Card>

      {!settings.paymentMethodsEnabled && (
        <Card className="rounded-xl border border-violet-500/30 shadow-sm overflow-hidden">
          <CardHeader className="bg-violet-500/5 border-b border-violet-500/20 pb-4">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              <ExternalLink className="w-4 h-4 text-violet-500" />
              External booking page
            </CardTitle>
            <CardDescription className="text-xs">
              The agent sends this exact URL without customer data, dates, room identifiers, or tracking parameters. Final availability, price, payment, cancellation, and confirmation happen on that page.
            </CardDescription>
          </CardHeader>
          <CardContent className="pt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="external-booking-url" className="text-xs font-medium text-muted-foreground">
                External booking URL
              </Label>
              <Input
                id="external-booking-url"
                type="url"
                placeholder="https://booking.example.com/property"
                value={settings.externalBooking.url}
                onChange={(event) => setSettings((current) => ({
                  ...current,
                  externalBooking: { ...current.externalBooking, url: event.target.value },
                }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="external-booking-title" className="text-xs font-medium text-muted-foreground">
                Link title (optional)
              </Label>
              <Input
                id="external-booking-title"
                placeholder="Continue your booking"
                value={settings.externalBooking.linkTitle}
                onChange={(event) => setSettings((current) => ({
                  ...current,
                  externalBooking: { ...current.externalBooking, linkTitle: event.target.value },
                }))}
              />
            </div>
          </CardContent>
        </Card>
      )}

      {settings.paymentMethodsEnabled && <>
      {/* Online Gateway Card */}
      <Card className="rounded-xl border border-border/50 shadow-sm overflow-hidden">
        <CardHeader className="bg-muted/10 border-b border-border/40 pb-4">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <CreditCard className="w-4 h-4 text-violet-500" />
                Online Payment Gateway
              </CardTitle>
              <CardDescription className="text-xs">
                Provide real-time cards and UPI checkouts via online gateway providers.
              </CardDescription>
            </div>
            <Switch
              id="hotel-payment-online"
              aria-label="Enable online payment gateway"
              checked={settings.methods?.online?.enabled ?? true}
              onCheckedChange={(checked) => updateMethod("online", { enabled: checked })}
            />
          </div>
        </CardHeader>
        {(settings.methods?.online?.enabled ?? true) && (
          <CardContent className="pt-4 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="provider-select" className="text-xs font-medium text-muted-foreground">
              Gateway Provider
            </Label>
            <Select
              value={settings.provider}
              onValueChange={(provider: "mock" | "razorpay") => setSettings({ ...settings, provider })}
            >
              <SelectTrigger id="provider-select" className="h-9">
                <SelectValue placeholder="Select Payment Provider" />
              </SelectTrigger>
              <SelectContent>
                {settings.allowMock && (
                  <SelectItem value="mock">Mock provider (local testing only)</SelectItem>
                )}
                <SelectItem value="razorpay">Razorpay (Live Card / UPI Payments)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {settings.provider === "mock" ? (
            <Callout tone="info" size="sm" icon={Check} title="Development payment mode">
              This creates local test links and is disabled automatically in production.
            </Callout>
          ) : (
            <Callout tone="warning" size="sm" icon={ExternalLink} title="Razorpay Live Integration">
              Collect live card and UPI payments. Ensure API credentials are correct below.
            </Callout>
          )}

          {settings.provider === "razorpay" && (
            <div className="space-y-4 pt-2 border-t border-border/30">
              <div className="space-y-2">
                <Label htmlFor="key-id" className="text-xs font-medium text-muted-foreground">
                  Razorpay Key ID
                </Label>
                <div className="relative">
                  <Input
                    id="key-id"
                    placeholder="rzp_live_..."
                    value={settings.keyId}
                    onChange={(e) => setSettings({ ...settings, keyId: e.target.value })}
                    className="h-9 pr-9"
                  />
                  <CopyButton
                    value={settings.keyId}
                    label="Copy Razorpay key ID"
                    iconOnly
                    variant="ghost"
                    className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
                    onError={showCopyFailed}
                    disabled={!settings.keyId}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="key-secret" className="text-xs font-medium text-muted-foreground">
                  Razorpay Key Secret
                </Label>
                <div className="relative">
                  <Input
                    id="key-secret"
                    type={showKeySecret ? "text" : "password"}
                    placeholder={settings.hasSecret ? "•••••••• (Saved)" : "Enter key secret"}
                    value={settings.keySecret}
                    onChange={(e) => setSettings({ ...settings, keySecret: e.target.value })}
                    className="h-9 pr-16"
                  />
                  <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => setShowKeySecret(!showKeySecret)}
                      aria-label={showKeySecret ? "Hide newly entered key secret" : "Show newly entered key secret"}
                      disabled={!settings.keySecret}
                    >
                      {showKeySecret ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </Button>
                  </div>
                </div>
                {settings.hasSecret && (
                  <p className="text-xs text-muted-foreground">Leave blank to keep the encrypted secret already saved.</p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="webhook-secret" className="text-xs font-medium text-muted-foreground">
                  Razorpay Webhook Secret
                </Label>
                <div className="relative">
                  <Input
                    id="webhook-secret"
                    type={showWebhookSecret ? "text" : "password"}
                    placeholder={settings.hasWebhookSecret ? "•••••••• (Saved)" : "Enter the webhook signing secret"}
                    value={settings.webhookSecret}
                    onChange={(e) => setSettings({ ...settings, webhookSecret: e.target.value })}
                    className="h-9 pr-9"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-1 top-1/2 -translate-y-1/2 h-7 w-7"
                    onClick={() => setShowWebhookSecret(!showWebhookSecret)}
                    aria-label={showWebhookSecret ? "Hide newly entered webhook secret" : "Show newly entered webhook secret"}
                    disabled={!settings.webhookSecret}
                  >
                    {showWebhookSecret ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </Button>
                </div>
                {settings.hasWebhookSecret && (
                  <p className="text-xs text-muted-foreground">Leave blank to keep the encrypted webhook secret already saved.</p>
                )}
              </div>

              <div className="p-3 rounded-lg bg-muted/30 border border-border/30">
                <Label className="text-xs font-medium text-muted-foreground">Webhook URL</Label>
                <div className="flex items-center gap-2 mt-1">
                  <code className="text-xs font-mono bg-background px-2 py-1 rounded border border-border/30 flex-1">
                    {webhookUrl}
                  </code>
                  <CopyButton
                    value={webhookUrl}
                    label="Copy Razorpay webhook URL"
                    iconOnly
                    variant="ghost"
                    className="h-7 w-7"
                    onError={showCopyFailed}
                  />
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  Configure this URL and the same signing secret in Razorpay. Only signature-verified captured payments confirm bookings.
                </p>
              </div>
            </div>
          )}
        </CardContent>
        )}
      </Card>

      {/* UPI QR Code Card */}
      <Card className="rounded-xl border border-border/50 shadow-sm overflow-hidden">
        <CardHeader className="bg-muted/10 border-b border-border/40 pb-4">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <QrCode className="w-4 h-4 text-violet-500" />
                UPI QR Code Payment
              </CardTitle>
              <CardDescription className="text-xs">
                Allow guests to scan your UPI QR code directly to make payments.
              </CardDescription>
            </div>
            <Switch
              id="hotel-payment-upi"
              aria-label="Enable UPI QR payments"
              checked={settings.methods?.upiQr?.enabled ?? false}
              onCheckedChange={(checked) => updateMethod("upiQr", { enabled: checked })}
            />
          </div>
        </CardHeader>
        {settings.methods?.upiQr?.enabled && (
          <CardContent className="pt-4 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="upi-id" className="text-xs font-medium text-muted-foreground">
                    UPI ID (VPA)
                  </Label>
                  <Input
                    id="upi-id"
                    placeholder="merchant@okaxis"
                    value={settings.methods?.upiQr?.upiId || ""}
                    onChange={(e) => updateMethod("upiQr", { upiId: e.target.value })}
                    className="h-9"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="payee-name" className="text-xs font-medium text-muted-foreground">
                    Payee Name (Account Holder Name)
                  </Label>
                  <Input
                    id="payee-name"
                    placeholder="Hotel Sunshine Private Limited"
                    value={settings.methods?.upiQr?.payeeName || ""}
                    onChange={(e) => updateMethod("upiQr", { payeeName: e.target.value })}
                    className="h-9"
                  />
                </div>

                <div className="space-y-2">
                  <Label className="text-xs font-medium text-muted-foreground">QR Code Image</Label>
                  <div className="flex items-center gap-2">
                    <input
                      type="file"
                      ref={qrInputRef}
                      className="hidden"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      onChange={handleQrUpload}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-9 gap-1.5"
                      onClick={() => qrInputRef.current?.click()}
                      loading={uploadingQr}
                      loadingText="Uploading…"
                    >
                      <Upload className="w-3.5 h-3.5" />
                      Upload QR Code Image
                    </Button>
                  </div>
                </div>
              </div>

              <div className="flex flex-col items-center justify-center p-3 border border-dashed rounded-lg bg-muted/20">
                {settings.methods?.upiQr?.qrImageUrl ? (
                  <div className="space-y-2 text-center">
                    <div className="relative w-40 h-40 mx-auto bg-white p-2 rounded-lg border shadow-sm flex items-center justify-center">
                      <img
                        src={normalizeUploadUrl(settings.methods.upiQr.qrImageUrl)}
                        alt="UPI QR Code"
                        className="max-w-full max-h-full object-contain"
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">QR code preview</p>
                  </div>
                ) : (
                  <div className="text-center p-6 text-muted-foreground space-y-2">
                    <QrCode className="w-10 h-10 mx-auto opacity-30" />
                    <p className="text-xs font-medium">No QR Code uploaded yet</p>
                    <p className="text-xs">Upload an image to show it to guests during checkout.</p>
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        )}
      </Card>

      {/* Direct Bank Account Card */}
      <Card className="rounded-xl border border-border/50 shadow-sm overflow-hidden">
        <CardHeader className="bg-muted/10 border-b border-border/40 pb-4">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <Building2 className="w-4 h-4 text-violet-500" />
                Bank Transfer Details
              </CardTitle>
              <CardDescription className="text-xs">
                Accept booking payments directly into your corporate bank account.
              </CardDescription>
            </div>
            <Switch
              id="hotel-payment-bank"
              aria-label="Enable bank transfer payments"
              checked={settings.methods?.bankTransfer?.enabled ?? false}
              onCheckedChange={(checked) => updateMethod("bankTransfer", { enabled: checked })}
            />
          </div>
        </CardHeader>
        {settings.methods?.bankTransfer?.enabled && (
          <CardContent className="pt-4 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="bank-name" className="text-xs font-medium text-muted-foreground">
                  Bank Name
                </Label>
                <Input
                  id="bank-name"
                  placeholder="HDFC Bank"
                  value={settings.methods?.bankTransfer?.bankName || ""}
                  onChange={(e) => updateMethod("bankTransfer", { bankName: e.target.value })}
                  className="h-9"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="bank-payee" className="text-xs font-medium text-muted-foreground">
                  Account Name / Beneficiary Name
                </Label>
                <Input
                  id="bank-payee"
                  placeholder="Hotel Sunshine Private Limited"
                  value={settings.methods?.bankTransfer?.payeeName || ""}
                  onChange={(e) => updateMethod("bankTransfer", { payeeName: e.target.value })}
                  className="h-9"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="bank-ac" className="text-xs font-medium text-muted-foreground">
                  Account Number
                </Label>
                <Input
                  id="bank-ac"
                  placeholder="50200012345678"
                  value={settings.methods?.bankTransfer?.accountNumber || ""}
                  onChange={(e) => updateMethod("bankTransfer", { accountNumber: e.target.value })}
                  className="h-9"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="bank-ifsc" className="text-xs font-medium text-muted-foreground">
                  IFSC Code
                </Label>
                <Input
                  id="bank-ifsc"
                  placeholder="HDFC0000123"
                  value={settings.methods?.bankTransfer?.ifscCode || ""}
                  onChange={(e) => updateMethod("bankTransfer", { ifscCode: e.target.value })}
                  className="h-9 font-mono uppercase"
                />
              </div>
            </div>
          </CardContent>
        )}
      </Card>

      {/* Custom Payment Link Card */}
      <Card className="rounded-xl border border-border/50 shadow-sm overflow-hidden">
        <CardHeader className="bg-muted/10 border-b border-border/40 pb-4">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <Link2 className="w-4 h-4 text-violet-500" />
                Custom Payment Link
              </CardTitle>
              <CardDescription className="text-xs">
                Redirect users to an external website or your custom payment portal.
              </CardDescription>
            </div>
            <Switch
              id="hotel-payment-custom"
              aria-label="Enable custom payment link"
              checked={settings.methods?.customLink?.enabled ?? false}
              onCheckedChange={(checked) => updateMethod("customLink", { enabled: checked })}
            />
          </div>
        </CardHeader>
        {settings.methods?.customLink?.enabled && (
          <CardContent className="pt-4 space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="custom-url" className="text-xs font-medium text-muted-foreground">
                  Payment Link URL
                </Label>
                <Input
                  id="custom-url"
                  placeholder="https://hotelsunshine.com/pay"
                  type="url"
                  value={settings.methods?.customLink?.url || ""}
                  onChange={(e) => updateMethod("customLink", { url: e.target.value })}
                  className="h-9"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="custom-title" className="text-xs font-medium text-muted-foreground">
                  Link Description / Button Title
                </Label>
                <Input
                  id="custom-title"
                  placeholder="Secure Portal Payment"
                  value={settings.methods?.customLink?.linkTitle || ""}
                  onChange={(e) => updateMethod("customLink", { linkTitle: e.target.value })}
                  className="h-9"
                />
              </div>
            </div>
          </CardContent>
        )}
      </Card>

      {/* Manual / Cash Details Card */}
      <Card className="rounded-xl border border-border/50 shadow-sm overflow-hidden">
        <CardHeader className="bg-muted/10 border-b border-border/40 pb-4">
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <CardTitle className="text-base font-semibold flex items-center gap-2">
                <Wallet className="w-4 h-4 text-violet-500" />
                Manual Payment Instructions
              </CardTitle>
              <CardDescription className="text-xs">
                Configure guidelines for cash payments, checks, or other manual methods.
              </CardDescription>
            </div>
            <Switch
              id="hotel-payment-manual"
              aria-label="Enable manual payments"
              checked={settings.methods?.manual?.enabled ?? false}
              onCheckedChange={(checked) => updateMethod("manual", { enabled: checked })}
            />
          </div>
        </CardHeader>
        {settings.methods?.manual?.enabled && (
          <CardContent className="pt-4 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="manual-instructions" className="text-xs font-medium text-muted-foreground">
                Payment Instructions for Guest
              </Label>
              <Textarea
                id="manual-instructions"
                placeholder="E.g., You can pay in cash at the reception desk during check-in, or send a check payable to 'Hotel Sunshine Pvt. Ltd.' at least 3 days before arrival."
                value={settings.methods?.manual?.instructions || ""}
                onChange={(e) => updateMethod("manual", { instructions: e.target.value })}
                className="min-h-[80px]"
              />
            </div>
          </CardContent>
        )}
      </Card>

      </>}

      {/* Save Button */}
      <div className="flex justify-end pt-2">
        <Button onClick={() => void saveSettings()} loading={saving} loadingText="Saving…" className="h-9 gap-1.5 shadow-sm">
          <Save className="w-3.5 h-3.5" />
          Save Settings
        </Button>
      </div>
      </fieldset>
    </div>
  );
}
