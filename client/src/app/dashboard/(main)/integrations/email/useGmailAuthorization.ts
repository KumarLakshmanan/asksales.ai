import { useCallback, useEffect, useRef, useState } from "react";
import api from "@/lib/api";
import { selectedBusinessProfileId, subscribeBusinessProfile } from "@/lib/business-profile";
import { gmailAuthorizationUrl, gmailSignedInAccount } from "@/lib/gmail-oauth";

export const GMAIL_AUTHORIZATION_TIMEOUT_MS = 15_000;
type Attempt = { controller: AbortController; promise: Promise<void> };
const navigate = (url: string) => window.location.assign(url);

export function useGmailAuthorization(onError: (message: string) => void, redirect = navigate) {
  const [connecting, setConnecting] = useState(false);
  const mounted = useRef(false);
  const active = useRef<Attempt | null>(null);

  useEffect(() => {
    mounted.current = true;
    const cancel = () => {
      active.current?.controller.abort();
      active.current = null;
      if (mounted.current) setConnecting(false);
    };
    const unsubscribe = subscribeBusinessProfile(cancel);
    window.addEventListener("auth:unauthorized", cancel);
    const storageChanged = (event: StorageEvent) => {
      if (event.key === "user" || event.key === "token" || event.key === null) cancel();
    };
    window.addEventListener("storage", storageChanged);
    return () => {
      mounted.current = false;
      cancel();
      unsubscribe();
      window.removeEventListener("auth:unauthorized", cancel);
      window.removeEventListener("storage", storageChanged);
    };
  }, []);

  const connect = useCallback((): Promise<void> => {
    if (!mounted.current) return Promise.resolve();
    if (active.current) return active.current.promise;
    const attempt: Attempt = { controller: new AbortController(), promise: Promise.resolve() };
    const profileId = selectedBusinessProfileId();
    const accountId = gmailSignedInAccount();
    const current = () => mounted.current && active.current === attempt
      && selectedBusinessProfileId() === profileId && gmailSignedInAccount() === accountId;
    active.current = attempt;
    setConnecting(true);
    attempt.promise = (async () => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let onAbort = () => {};
      try {
        const cancelled = new Promise<never>((_, reject) => {
          onAbort = () => reject(new DOMException("Gmail authorization cancelled", "AbortError"));
          attempt.controller.signal.addEventListener("abort", onAbort, { once: true });
          timeout = setTimeout(() => attempt.controller.abort(), GMAIL_AUTHORIZATION_TIMEOUT_MS);
        });
        const data = await Promise.race([
          api.get<{ url?: string; authUrl?: string }>("/api/gmail/oauth/authorize", { signal: attempt.controller.signal }),
          cancelled,
        ]);
        if (!current()) return;
        redirect(gmailAuthorizationUrl(data.url || data.authUrl));
      } catch {
        if (current()) onError("Gmail sign-in could not be opened. Try again, or ask the app administrator to check Gmail sign-in settings.");
      } finally {
        clearTimeout(timeout);
        attempt.controller.signal.removeEventListener("abort", onAbort);
        if (active.current === attempt) {
          active.current = null;
          if (mounted.current) setConnecting(false);
        }
      }
    })();
    return attempt.promise;
  }, [onError, redirect]);

  return { connecting, connect };
}
