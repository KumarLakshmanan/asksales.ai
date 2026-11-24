"use client";
import { useBillingOrganizations } from "@/hooks/use-billing-organizations";

import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { ApiError } from "@/lib/api";
import { useBillingApi } from "@/hooks/use-billing-api";
import {
  Wallet,
  CreditCard,
  IndianRupee,
  Zap,
  ArrowLeft,
  CheckCircle2,
  ShieldCheck,
  Sparkles,
  Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useSubscription } from "@/hooks/use-subscription";
import Link from "next/link";
import { type WalletData } from "@/lib/billing-reporting";

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    Razorpay: new (options: Record<string, unknown>) => any;
  }
}

const RECHARGE_AMOUNTS = [100, 250, 500, 1000, 2500, 5000];

const PACKAGE_HIGHLIGHTS: Record<number, string> = Object.fromEntries(RECHARGE_AMOUNTS.map(amount => [amount, "One-time top-up"]));
const PACKAGE_BADGE: Record<number, string | null> = {};

interface PendingPaymentVerification {
  razorpay_order_id: string;
  razorpay_payment_id: string;
  razorpay_signature: string;
}

const PENDING_PAYMENT_KEY = "wallet_pending_payment_verification";

export default function RechargePage() {
  const api = useBillingApi();
  const { organizationId, organization, businessProfileId, billingScopeKey } = useBillingOrganizations();
  const pendingPaymentKey = `${PENDING_PAYMENT_KEY}:${billingScopeKey}`;
  const requestOptions = { headers: { ...(organizationId ? { "X-Billing-Organization-Id": String(organizationId) } : {}), ...(businessProfileId ? { "X-Business-Profile-Id": String(businessProfileId) } : {}) } };
  const { toast } = useToast();
  const subscription = useSubscription();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [selectedAmount, setSelectedAmount] = useState<number>(1000);
  const [customAmount, setCustomAmount] = useState<string>("");
  const [isProcessingPayment, setIsProcessingPayment] = useState(false);
  const [checkoutReady, setCheckoutReady] = useState(false);
  const [checkoutLoadError, setCheckoutLoadError] = useState(false);
  const [checkoutLoadAttempt, setCheckoutLoadAttempt] = useState(0);
  const [paymentSuccess, setPaymentSuccess] = useState<{ creditsAdded: number; newBalance: number } | null>(null);
  const [pendingVerification, setPendingVerification] = useState<PendingPaymentVerification | null>(null);

  // A preset chosen on the billing overview should stay selected in checkout.
  useEffect(() => {
    const requested = Number(new URLSearchParams(window.location.search).get("amount"));
    if (RECHARGE_AMOUNTS.includes(requested)) {
      setSelectedAmount(requested);
      setCustomAmount("");
    }
  }, []);

  const { data: gateway, isLoading: gatewayLoading, isError: gatewayError, refetch: refetchGateway } = useQuery<{
    keyId: string | null;
    isConfigured: boolean;
  }>({
    queryKey: ["wallet-payment-gateway", billingScopeKey],
    queryFn: () => api.get("/api/wallet/razorpay-key"),
  });

  // Restore a captured payment claim so verification can be retried safely.
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(pendingPaymentKey)
        || (organization?.defaultForUserId ? sessionStorage.getItem(PENDING_PAYMENT_KEY) : null);
      if (stored) {
        const parsed = JSON.parse(stored) as PendingPaymentVerification;
        if (parsed.razorpay_order_id && parsed.razorpay_payment_id && parsed.razorpay_signature) {
          sessionStorage.setItem(pendingPaymentKey, JSON.stringify(parsed));
          if (organization?.defaultForUserId) sessionStorage.removeItem(PENDING_PAYMENT_KEY);
          setPendingVerification(parsed);
        }
      }
    } catch {
      sessionStorage.removeItem(pendingPaymentKey);
    }

  }, [organization?.defaultForUserId, pendingPaymentKey]);

  // Load checkout only after the server confirms that Razorpay is configured.
  useEffect(() => {
    if (!gateway?.isConfigured) {
      setCheckoutReady(false);
      setCheckoutLoadError(false);
      return;
    }
    setCheckoutLoadError(false);
    const existing = document.getElementById("razorpay-checkout-script") as HTMLScriptElement | null;
    if (typeof window.Razorpay === "function") {
      setCheckoutReady(true);
      return;
    }
    // A failed script tag does not fire its error event again when this route is
    // revisited. Replace it so transient network/CSP failures can be retried.
    existing?.remove();
    let cancelled = false;
    const script = document.createElement("script");
    script.id = "razorpay-checkout-script";
    script.src = "https://checkout.razorpay.com/v1/checkout.js";
    script.async = true;
    script.onload = () => {
      if (cancelled) return;
      const ready = typeof window.Razorpay === "function";
      setCheckoutReady(ready);
      setCheckoutLoadError(!ready);
    };
    script.onerror = () => {
      if (cancelled) return;
      setCheckoutReady(false);
      setCheckoutLoadError(true);
    };
    document.body.appendChild(script);
    return () => {
      cancelled = true;
    };
  }, [gateway?.isConfigured, checkoutLoadAttempt]);

  const { data: walletData, isLoading: walletLoading, isError: walletError, refetch: refetchWallet } = useQuery<WalletData>({
    queryKey: ["wallet", billingScopeKey],
    queryFn: async () => {
      return api.get<WalletData>("/api/wallet");
    },
  });

  const createOrderMutation = useMutation({
    mutationFn: async (amount: number) => {
      const res = await api.post<{
          orderId: string;
          amount: number;
          currency: string;
          keyId: string;
          creditsToReceive: number;
          rechargeRate: number;
      }>("/api/wallet/recharge/create-order", { amount }, requestOptions);
      return res;
    },
  });

  const verifyPaymentMutation = useMutation({
    mutationFn: async (data: {
      razorpay_order_id: string;
      razorpay_payment_id: string;
      razorpay_signature: string;
    }) => {
      const res = await api.post<{ creditsAdded: number; newBalance: number }>(
        "/api/wallet/recharge/verify", data, requestOptions
      );
      return res;
    },
    onSuccess: (data) => {
      sessionStorage.removeItem(pendingPaymentKey);
      setPendingVerification(null);
      setPaymentSuccess({ creditsAdded: data.creditsAdded, newBalance: data.newBalance });
      queryClient.invalidateQueries({ queryKey: ["wallet"] });
      queryClient.invalidateQueries({ queryKey: ["wallet-transactions"] });
      queryClient.invalidateQueries({ queryKey: ["wallet-daily-usage"] });
      setIsProcessingPayment(false);
    },
    onError: (error) => {
      toast({
        title: "Payment Verification Failed",
        description: error instanceof ApiError ? error.message : "Could not verify payment. Please contact support.",
        variant: "destructive",
      });
      setIsProcessingPayment(false);
    },
  });

  const effectiveAmount = customAmount ? parseFloat(customAmount) : selectedAmount;
  const rechargeRate = walletData?.rechargeRate ?? 0;
  const creditsPreview = effectiveAmount > 0 ? Math.round(effectiveAmount * rechargeRate * 100) / 100 : 0;

  const handleRecharge = useCallback(async () => {
    const amount = effectiveAmount;
    if (!gateway?.isConfigured) {
      toast({ title: "Recharge unavailable", description: "The payment gateway has not been configured by an administrator.", variant: "destructive" });
      return;
    }
    if (!checkoutReady || typeof window.Razorpay !== "function") {
      toast({ title: "Checkout unavailable", description: "The secure payment checkout is still loading. Please try again in a moment.", variant: "destructive" });
      return;
    }
    if (!amount || amount <= 0) {
      toast({ title: "Invalid amount", description: "Please enter a valid recharge amount.", variant: "destructive" });
      return;
    }
    if (amount < 1) {
      toast({ title: "Minimum Amount", description: "Minimum recharge amount is ₹1.", variant: "destructive" });
      return;
    }
    if (amount > 100000) {
      toast({ title: "Maximum Amount", description: "Maximum recharge amount is ₹1,00,000.", variant: "destructive" });
      return;
    }

    setIsProcessingPayment(true);
    try {
      const orderData = await createOrderMutation.mutateAsync(amount);

      const options = {
        key: orderData.keyId,
        amount: orderData.amount,
        currency: orderData.currency,
        name: "AskSales.AI",
        description: `Recharge ${orderData.creditsToReceive.toLocaleString()} credits`,
        order_id: orderData.orderId,
        handler: async (response: Record<string, string>) => {
          const verification = {
            razorpay_order_id: response.razorpay_order_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature: response.razorpay_signature,
          };
          sessionStorage.setItem(pendingPaymentKey, JSON.stringify(verification));
          setPendingVerification(verification);
          try {
            await verifyPaymentMutation.mutateAsync(verification);
          } catch {
            // The mutation shows the error and the stored claim can be retried safely.
          }
        },
        theme: { color: "#2563eb" },
        modal: {
          ondismiss: () => {
            setIsProcessingPayment(false);
          },
        },
      };

      const rzp = new window.Razorpay(options);
      rzp.on("payment.failed", () => {
        toast({ title: "Payment Failed", description: "Payment was not successful. Please try again.", variant: "destructive" });
        setIsProcessingPayment(false);
      });
      rzp.open();
    } catch (error) {
      toast({ title: "Unable to start checkout", description: error instanceof ApiError ? error.message : "Please try again or contact support.", variant: "destructive" });
      setIsProcessingPayment(false);
    }
  }, [effectiveAmount, gateway?.isConfigured, checkoutReady, createOrderMutation, verifyPaymentMutation, toast, pendingPaymentKey]);

  const retryPaymentVerification = useCallback(async () => {
    if (!pendingVerification) return;
    setIsProcessingPayment(true);
    try {
      await verifyPaymentMutation.mutateAsync(pendingVerification);
    } catch {
      // The mutation surfaces the actionable error and keeps the payment for another retry.
    }
  }, [pendingVerification, verifyPaymentMutation]);

  if (subscription.data && !subscription.data.organization.canManageBilling) return <div className="rounded-xl border border-border p-7"><h1 className="text-2xl font-semibold">Ask your business owner</h1><p className="mt-3 text-sm leading-6 text-muted-foreground">Only the business owner or a billing admin can purchase extra credits for this shared wallet.</p><Button className="mt-5" variant="outline" asChild><Link href="/dashboard/billing">Back to billing</Link></Button></div>;

  // Success screen
  if (paymentSuccess) {
    return (
      <div className="min-h-[70vh] flex items-center justify-center px-4">
        <div className="text-center max-w-md w-full">
          <div className="flex justify-center mb-6">
            <div className="w-20 h-20 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center">
              <CheckCircle2 className="w-10 h-10 text-green-600 dark:text-green-400" />
            </div>
          </div>
          <h1 className="mb-2 text-2xl font-semibold tracking-tight">Recharge complete</h1>
          <p className="mb-6 text-muted-foreground">Your wallet has been topped up.</p>

          <div className="mb-6 rounded-xl border border-border bg-card p-6">
            <div className="flex items-center justify-between mb-3">
              <span className="text-sm text-muted-foreground">Credits Added</span>
              <span className="font-mono text-2xl font-semibold tracking-tight text-primary">
                +{paymentSuccess.creditsAdded.toLocaleString()}
              </span>
            </div>
            <div className="mb-3 h-px bg-border" />
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">New Balance</span>
              <div className="flex items-center gap-1.5">
                <Wallet className="h-4 w-4 text-primary" />
                <span className="text-lg font-semibold text-foreground">
                  {paymentSuccess.newBalance.toLocaleString()} credits
                </span>
              </div>
            </div>
          </div>

          <div className="flex gap-3">
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => {
                setPaymentSuccess(null);
                setCustomAmount("");
                setSelectedAmount(1000);
              }}
            >
              <Zap className="w-4 h-4 mr-2" />
              Recharge Again
            </Button>
            <Button
              className="flex-1"
              onClick={() => router.push("/dashboard/billing")}
            >
              View Billing
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 pb-12">
      {/* Back navigation */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push("/dashboard/billing")}
          className="-ml-1 gap-1.5 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Billing
        </Button>
      </div>

      {/* Header */}
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Zap className="h-6 w-6 text-primary" />
          Buy extra credits
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Add credits to your wallet to use AI features, outreach, and more.
        </p>
      </div>

      {pendingVerification && (
        <Callout
          tone="warning"
          announce
          title="Payment received; wallet update pending"
          actions={
            <Button
              variant="outline"
              size="sm"
              onClick={retryPaymentVerification}
              loading={isProcessingPayment || verifyPaymentMutation.isPending}
            >
              Retry verification
            </Button>
          }
        >
          Retry secure verification. You will never be credited twice for the same payment.
        </Callout>
      )}

      {(walletError || gatewayError) && (
        <Callout
          tone="danger"
          title="Recharge details could not be loaded"
          actions={<Button variant="outline" size="sm" onClick={() => { void refetchWallet(); void refetchGateway(); }}>Try again</Button>}
        >
          Retry before starting a payment.
        </Callout>
      )}

      {!gatewayLoading && gateway && !gateway.isConfigured && (
        <Callout tone="warning" announce title="Payment integration required">
          An administrator must add and activate Razorpay credentials before wallet recharges can be accepted.
        </Callout>
      )}

      {!gatewayLoading && gateway?.isConfigured && gateway.keyId?.startsWith("rzp_test_") && (
        <Callout tone="info" announce title="Razorpay Test Mode">
          Payments are simulated and no real money is charged. An administrator must add live credentials before accepting real recharges.
        </Callout>
      )}

      {!gatewayLoading && gateway?.isConfigured && checkoutLoadError && (
        <Callout
          tone="danger"
          title="Secure checkout could not be loaded"
          actions={
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setCheckoutReady(false);
                setCheckoutLoadError(false);
                setCheckoutLoadAttempt((attempt) => attempt + 1);
              }}
            >
              Retry checkout
            </Button>
          }
        >
          Check your connection, then retry loading Razorpay Checkout.
        </Callout>
      )}

      {/* Current balance banner */}
      {!walletLoading && walletData && (
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-muted-foreground">Current balance</p>
              <div className="flex items-center gap-2 mt-1">
                <Wallet className="h-5 w-5 text-primary" />
                <span className="font-mono text-2xl font-semibold tracking-tight">{walletData.balance.toLocaleString()}</span>
                <span className="text-sm text-muted-foreground">credits</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                ≈ ₹{(walletData.balance / rechargeRate).toFixed(0)} equivalent
              </p>
            </div>
            <div className="text-right">
              <p className="text-xs text-muted-foreground">Top-up rate</p>
              <p className="text-xl font-bold">{rechargeRate} credits</p>
              <p className="text-xs text-muted-foreground">per ₹1</p>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-7 gap-6">
        {/* Amount Selection */}
        <div className="lg:col-span-4 space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Choose Amount</CardTitle>
              <CardDescription className="text-xs">Select a preset or enter a custom amount</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Preset packages */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {RECHARGE_AMOUNTS.map((amt) => {
                  const isSelected = selectedAmount === amt && !customAmount;
                  const badgeText = PACKAGE_BADGE[amt];
                  return (
                    <button
                      key={amt}
                      onClick={() => {
                        setSelectedAmount(amt);
                        setCustomAmount("");
                      }}
                      className={`relative p-4 rounded-xl border-2 text-left transition-all ${
                        isSelected
                          ? "border-primary bg-primary/8"
                          : "border-border hover:border-primary/40 hover:bg-muted/50"
                      }`}
                    >
                      {badgeText && (
                        <span className="absolute -top-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">
                          {badgeText}
                        </span>
                      )}
                      <div className="flex items-center gap-1 mb-1">
                        <IndianRupee className="w-3 h-3 text-muted-foreground" />
                        <span className={`text-lg font-bold ${isSelected ? "text-primary" : "text-foreground"}`}>
                          {amt.toLocaleString()}
                        </span>
                      </div>
                      <div className={`text-xs font-medium ${isSelected ? "text-primary" : "text-muted-foreground"}`}>
                        {(amt * rechargeRate).toLocaleString()} credits
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">{PACKAGE_HIGHLIGHTS[amt]}</div>
                    </button>
                  );
                })}
              </div>

              {/* Divider */}
              <div className="flex items-center gap-3">
                <div className="h-px flex-1 bg-border" />
                <span className="text-xs text-muted-foreground">or custom amount</span>
                <div className="h-px flex-1 bg-border" />
              </div>

              {/* Custom amount */}
              <div className="relative">
                <div className="absolute left-3 top-1/2 flex -translate-y-1/2 items-center gap-1 text-muted-foreground">
                  <IndianRupee className="w-4 h-4" />
                </div>
                <Input
                  type="number"
                  placeholder="Enter custom amount"
                  value={customAmount}
                  onChange={(e) => setCustomAmount(e.target.value)}
                  className={`h-11 pl-9 text-base font-medium ${customAmount ? "border-primary ring-1 ring-primary/20" : ""}`}
                  min={1}
                  max={100000}
                  step="0.01"
                />
              </div>
            </CardContent>
          </Card>

          {/* Trust badges */}
          <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-green-500" />
              Secure payment via Razorpay
            </div>
            <div className="flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-blue-500" />
              Credits added instantly
            </div>
            <div className="flex items-center gap-1.5">
              <Info className="w-3.5 h-3.5 text-muted-foreground" />
              GST applicable as per norms
            </div>
          </div>
        </div>

        {/* Order Summary */}
        <div className="lg:col-span-3 space-y-4">
          <Card className="sticky top-6">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                Order summary
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Summary rows */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Amount</span>
                  <span className="text-sm font-semibold text-foreground">
                    {effectiveAmount > 0 ? `₹${effectiveAmount.toLocaleString()}` : "—"}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Rate</span>
                  <span className="text-sm text-foreground">{rechargeRate} credits / ₹1</span>
                </div>
                <div className="h-px bg-border" />
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">You receive</span>
                  <span className="font-mono text-lg font-semibold text-primary">
                    {creditsPreview > 0 ? `${creditsPreview.toLocaleString()} credits` : "—"}
                  </span>
                </div>
                {walletData && effectiveAmount > 0 && (
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>New balance</span>
                    <span>{(walletData.balance + creditsPreview).toLocaleString()} credits</span>
                  </div>
                )}
              </div>

              {/* Rate confirmation */}
              {effectiveAmount > 0 && (
                <div className="space-y-1 rounded-lg border border-border bg-muted/35 p-3 text-xs text-foreground">
                  <p className="font-medium">Your quoted rate is locked into the Razorpay order.</p>
                  <p className="text-muted-foreground">The server verifies the captured amount and credit total before updating your wallet.</p>
                </div>
              )}

              {/* Pay button */}
              {!subscription.data?.access.canTopUp && <p className="mb-4 text-sm text-muted-foreground">An active paid subscription is required for extra credits. <Link href="/dashboard/billing/subscription" className="text-primary underline">Manage subscription</Link></p>}
              <Button
                onClick={handleRecharge}
                disabled={walletLoading || gatewayLoading || walletError || gatewayError || !gateway?.isConfigured || !checkoutReady || effectiveAmount <= 0 || !subscription.data?.access.canTopUp}
                loading={isProcessingPayment || Boolean(gateway?.isConfigured && !checkoutReady && !checkoutLoadError)}
                loadingText={isProcessingPayment ? "Processing…" : "Loading secure checkout…"}
                className="h-11 w-full gap-2 text-base font-semibold"
                size="lg"
              >
                <CreditCard className="w-4 h-4" />
                {effectiveAmount > 0 ? `Pay ₹${effectiveAmount.toLocaleString()}` : "Select an amount"}
              </Button>

              <p className="text-center text-xs text-muted-foreground">
                By proceeding, you agree to our Terms of Service. Payment details are handled by Razorpay.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
