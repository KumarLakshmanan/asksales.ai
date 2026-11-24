"use client";
import { useMemo } from "react";
import api, { type ApiOptions } from "@/lib/api";
import { BUSINESS_PROFILE_HEADER } from "@/lib/business-profile";
import { BILLING_ORGANIZATION_HEADER } from "@/lib/billing-organization";
import { useBillingOrganizations } from "./use-billing-organizations";

/** Capture both business access and payment responsibility for the lifetime of a request. */
export function useBillingApi() {
  const { organizationId, businessProfileId } = useBillingOrganizations();
  return useMemo(() => {
    const scope = (options: ApiOptions = {}): ApiOptions => {
      const headers = new Headers(options.headers);
      if (businessProfileId)
        headers.set(BUSINESS_PROFILE_HEADER, String(businessProfileId));
      if (organizationId)
        headers.set(BILLING_ORGANIZATION_HEADER, String(organizationId));
      return { ...options, headers };
    };
    return {
      get: <T = unknown>(endpoint: string, options?: ApiOptions) =>
        api.get<T>(endpoint, scope(options)),
      post: <T = unknown>(
        endpoint: string,
        data?: unknown,
        options?: ApiOptions,
      ) => api.post<T>(endpoint, data, scope(options)),
      put: <T = unknown>(
        endpoint: string,
        data?: unknown,
        options?: ApiOptions,
      ) => api.put<T>(endpoint, data, scope(options)),
      patch: <T = unknown>(
        endpoint: string,
        data?: unknown,
        options?: ApiOptions,
      ) => api.patch<T>(endpoint, data, scope(options)),
      delete: <T = unknown>(endpoint: string, options?: ApiOptions) =>
        api.delete<T>(endpoint, scope(options)),
    };
  }, [organizationId, businessProfileId]);
}
