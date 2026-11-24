"use client";

import { useState, useEffect } from "react";
import { Star, CheckCircle2, AlertCircle } from "lucide-react";
import { BRAND_NAME } from "@/lib/brand";
import { LoadingState } from "@/components/ui/loading-state";
import { Spinner } from "@/components/ui/spinner";
import { Callout } from "@/components/ui/callout";
import { fetchWithReadRetry } from "@/lib/api-client";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "";

export default function PublicReviewPage({ params }: { params: Promise<{ token: string }> }) {
  const [token, setToken] = useState<string>("");
  const [ticketInfo, setTicketInfo] = useState<{
    ticketNumber: string;
    subject: string;
    alreadyReviewed: boolean;
    rating: number | null;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    params.then((p) => setToken(p.token));
  }, [params]);

  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const res = await fetchWithReadRetry(`${API_URL}/api/support/review-public/${token}`);
        const data = await res.json();
        if (!res.ok || !data.success) {
          setError(data.error || "Invalid review link");
          return;
        }
        setTicketInfo(data.data);
        if (data.data.alreadyReviewed) {
          setRating(data.data.rating || 0);
          setSubmitted(true);
        }
      } catch {
        setError("Failed to load review page");
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  const handleSubmit = async () => {
    if (rating < 1) return;
    setError("");
    setSubmitting(true);
    try {
      const res = await fetch(`${API_URL}/api/support/review-public/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rating, comment }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error || "Failed to submit review");
        return;
      }
      setSubmitted(true);
    } catch {
      setError("Failed to submit review");
    } finally {
      setSubmitting(false);
    }
  };

  const ratingLabels = ["", "Poor", "Fair", "Good", "Great", "Excellent"];

  if (loading) {
    return (
      <LoadingState size="page" className="min-h-screen bg-background" label="Loading review" />
    );
  }

  if (error && !ticketInfo) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background px-4 py-12 text-foreground">
        <div className="w-full max-w-md rounded-3xl border border-border bg-card p-8 text-center shadow-xl shadow-black/5 sm:p-10">
          <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-destructive/10">
            <AlertCircle className="h-8 w-8 text-destructive" />
          </div>
          <h1 className="mb-2 text-2xl font-bold tracking-tight">Review link unavailable</h1>
          <p className="text-sm leading-6 text-muted-foreground">{error}</p>
        </div>
      </main>
    );
  }

  if (submitted) {
    return (
      <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-12 text-foreground">
        <div aria-hidden className="absolute -left-24 top-0 h-72 w-72 rounded-full bg-emerald-500/10 blur-3xl" />
        <div aria-hidden className="absolute -right-24 bottom-0 h-72 w-72 rounded-full bg-amber-500/10 blur-3xl" />
        <div className="relative w-full max-w-md rounded-3xl border border-border bg-card p-8 text-center shadow-xl shadow-black/5 sm:p-10">
          <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-2xl bg-emerald-500/10">
            <CheckCircle2 className="h-8 w-8 text-emerald-600 dark:text-emerald-400" />
          </div>
          <h1 className="mb-2 text-2xl font-bold tracking-tight">Thank you for your feedback</h1>
          <p className="mb-6 text-sm leading-6 text-muted-foreground">
            Your review has been recorded and shared with the support team.
          </p>
          <div className="mb-3 flex items-center justify-center gap-1" aria-label={`${rating} out of 5 stars`}>
            {[1, 2, 3, 4, 5].map((star) => (
              <Star
                key={star}
                aria-hidden
                className={`h-8 w-8 ${star <= rating ? "fill-amber-400 text-amber-400" : "text-muted"}`}
              />
            ))}
          </div>
          <p className="text-sm font-semibold text-amber-700 dark:text-amber-300">{ratingLabels[rating]}</p>
          {ticketInfo && (
            <div className="mt-8 rounded-2xl border border-border bg-muted/40 p-4">
              <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{ticketInfo.ticketNumber}</p>
              <p className="mt-1 text-sm font-medium text-foreground">{ticketInfo.subject}</p>
            </div>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="relative min-h-screen overflow-hidden bg-background px-4 py-10 text-foreground sm:py-14">
      <div aria-hidden className="absolute -left-24 top-0 h-80 w-80 rounded-full bg-amber-500/10 blur-3xl" />
      <div aria-hidden className="absolute -right-24 bottom-0 h-80 w-80 rounded-full bg-orange-500/10 blur-3xl" />

      <div className="relative mx-auto w-full max-w-lg">
        <header className="mb-8 text-center">
          <div className="mx-auto mb-5 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 shadow-lg shadow-amber-500/20">
            <Star className="h-8 w-8 fill-white text-white" />
          </div>
          <h1 className="mb-2 text-3xl font-bold tracking-tight">Rate your support experience</h1>
          <p className="text-sm leading-6 text-muted-foreground">Your feedback helps the team improve future support.</p>
        </header>

        {ticketInfo && (
          <div className="mb-5 rounded-2xl border border-border bg-card p-5 shadow-sm">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{ticketInfo.ticketNumber}</p>
            <p className="text-base font-semibold text-foreground sm:text-lg">{ticketInfo.subject}</p>
          </div>
        )}

        <section className="mb-5 rounded-3xl border border-border bg-card p-6 shadow-lg shadow-black/5 sm:p-8">
          <h2 className="mb-6 text-center text-sm font-semibold">How would you rate the support you received?</h2>
          <div className="mb-3 flex items-center justify-center gap-1 sm:gap-3" role="radiogroup" aria-label="Support rating">
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                type="button"
                key={star}
                onMouseEnter={() => setHover(star)}
                onMouseLeave={() => setHover(0)}
                onClick={() => setRating(star)}
                role="radio"
                aria-checked={rating === star}
                aria-label={`${star} star${star === 1 ? "" : "s"}: ${ratingLabels[star]}`}
                className="rounded-xl p-1 transition-transform duration-150 hover:scale-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card active:scale-95"
              >
                <Star
                  aria-hidden
                  className={`h-10 w-10 transition-colors duration-150 sm:h-12 sm:w-12 ${
                    star <= (hover || rating)
                      ? "fill-amber-400 text-amber-400 drop-shadow-sm"
                      : "text-muted-foreground/30 hover:text-muted-foreground/50"
                  }`}
                />
              </button>
            ))}
          </div>
          {(hover || rating) > 0 && (
            <p className="animate-in fade-in text-center text-sm font-semibold text-amber-700 duration-150 dark:text-amber-300" aria-live="polite">
              {ratingLabels[hover || rating]}
            </p>
          )}
        </section>

        <section className="mb-5 rounded-3xl border border-border bg-card p-6 shadow-lg shadow-black/5 sm:p-8">
          <label htmlFor="review-comment" className="mb-3 block text-sm font-semibold">
            Tell us more about your experience <span className="font-normal text-muted-foreground">(optional)</span>
          </label>
          <textarea
            id="review-comment"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="What went well? What could we improve?"
            rows={4}
            maxLength={2000}
            className="w-full resize-none rounded-2xl border border-input bg-background px-4 py-3 text-sm text-foreground outline-none transition-shadow placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
          <p className="mt-2 text-right text-xs text-muted-foreground">{comment.length}/2000</p>
        </section>

        {error && (
          <Callout tone="danger" className="mb-4">
            {error}
          </Callout>
        )}

        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting || rating < 1}
          className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-amber-500 to-orange-500 px-5 text-sm font-bold text-white shadow-lg shadow-amber-500/20 transition-all hover:from-amber-600 hover:to-orange-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? (
            <Spinner size="md" label={null} />
          ) : (
            <Star className="h-5 w-5" />
          )}
          {submitting ? "Submitting..." : "Submit Review"}
        </button>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          Powered by <span className="font-semibold text-foreground">{BRAND_NAME}</span>
        </p>
      </div>
    </main>
  );
}
