"use client";

import { useQuery } from "@tanstack/react-query";
import api from "@/lib/api";

/** Mirrors server MarketingLimitCheck (services/whatsapp/WhatsAppMarketingLimit.ts). */
type MarketingLimitCheck = { marketing: boolean; leadIds: number[] };

const MAX_LEADS = 5000;

/**
 * Warns before launch when Meta recently held a marketing template back from
 * some of these contacts (error 131049). Meta does not publish the limit, so
 * this is guidance only; the send still goes ahead and is retried by the queue.
 */
export function WhatsAppMarketingLimitNotice({
  leadIds,
  phoneNumberId,
  templateName,
  templateLanguage,
}: {
  leadIds: number[];
  phoneNumberId?: string | null;
  templateName?: string;
  templateLanguage?: string;
}) {
  const checked = leadIds.slice(0, MAX_LEADS);
  const key = JSON.stringify([phoneNumberId ?? null, templateName ?? null, templateLanguage ?? null, checked]);
  const query = useQuery<MarketingLimitCheck, Error>({
    queryKey: ["whatsapp-marketing-limit", key],
    queryFn: () =>
      api.post<MarketingLimitCheck>("/api/whatsapp/marketing-limit", {
        phoneNumberId: phoneNumberId ?? undefined,
        templateName,
        templateLanguage,
        leadIds: checked,
      }),
    enabled: checked.length > 0 && !!templateName,
    staleTime: 60_000,
  });
  const held = query.data?.marketing ? query.data.leadIds.length : 0;
  if (!held) return null;
  return (
    <div>
      <dt className="text-xs text-muted-foreground">WhatsApp marketing limit</dt>
      <dd role="status" className="mt-1 text-sm text-amber-700 dark:text-amber-400">
        {held === 1 ? "1 recipient has" : `${held.toLocaleString("en-IN")} recipients have`} reached
        WhatsApp&apos;s marketing message limit in the last 24 hours. Meta may hold this
        message back from them again; it is then retried every 4 hours. Utility
        templates and replies after they message you are not limited.
      </dd>
    </div>
  );
}
