"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import api, { ApiError } from "@/lib/api";
import { creatorSessionScope } from "@/lib/creator-session";
export interface ImportResult {
  importId: number;
  id?: number;
  totalRecords: number;
  successCount: number;
  duplicateCount: number;
  errorCount: number;
  skippedCount: number;
  warningCount: number;
  issues: Array<{
    row: number;
    type: "duplicate" | "skipped" | "error" | "warning";
    message: string;
  }>;
  importStatus?: string;
  processedRecords?: number;
}
interface Receipt {
  version: 1;
  importId?: number;
  operationId?: string;
  fileHash: string;
  mapping: Record<string, string>;
}
async function digest(file: File) {
  const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new Error("The file could not be read."));
    reader.readAsArrayBuffer(file);
  });
  const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
export function useCrmImportRecovery(
  scope: string,
  onCompleted: (result: ImportResult) => void,
) {
  const [receipt, setReceipt] = useState<Receipt | null>(null),
    [status, setStatus] = useState<ImportResult | null>(null);
  const [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const active = useRef(true),
    working = useRef(false),
    saved = useRef<Receipt | null>(null),
    completed = useRef(onCompleted);
  useEffect(() => { completed.current = onCompleted; }, [onCompleted]);
  const key = `crm-import-recovery:${scope}`;
  const current = useCallback(
    () => active.current && creatorSessionScope() === scope,
    [scope],
  );
  const remember = useCallback(
    (value: Receipt | null) => {
      saved.current = value;
      setReceipt(value);
      try {
        if (value) sessionStorage.setItem(key, JSON.stringify(value));
        else sessionStorage.removeItem(key);
      } catch {
        /* A full/private browser store leaves the current in-memory receipt intact. */
      }
    },
    [key],
  );
  const accept = useCallback(
    (result: ImportResult, id: number) => {
      if (!current()) return;
      setStatus(result);
      if (result.importStatus === "completed") {
        setMessage("");
        completed.current({ ...result, importId: id });
      } else
        setMessage(
          "Saved rows are retained. Resume using the original file and mapping.",
        );
    },
    [current],
  );
  const readStatus = useCallback(
    async (id: number) => {
      try {
        const result = await api.get<ImportResult>(`/api/crm/imports/${id}`);
        accept(result, id);
      } catch {
        if (current())
          setMessage(
            "Saved status could not be loaded. Keep this receipt and check again before resuming.",
          );
      }
    },
    [accept, current],
  );
  useEffect(() => {
    active.current = true;
    try {
      const value = JSON.parse(sessionStorage.getItem(key) || "null");
      if (
        value?.version === 1 &&
        /^[a-f0-9]{64}$/.test(value.fileHash) &&
        value.mapping &&
        typeof value.mapping === "object" &&
        (!value.importId ||
          (Number.isSafeInteger(value.importId) && value.importId > 0))
      ) {
        saved.current = value;
        setReceipt(value);
        setMessage(
          value.operationId ? 'This file has a saved background import. Open it to follow progress or resume.' : "A previous import needs reconciliation. Select the original file; its saved mapping will be reused.",
        );
        if (value.importId) void readStatus(value.importId);
      }
    } catch {
      /* Ignore invalid browser state. Server ownership remains authoritative. */
    }
    return () => {
      active.current = false;
    };
  }, [key, readStatus]);
  const verifyFile = useCallback(async (file: File) => {
    const value = saved.current;
    if (value && (await digest(file)) !== value.fileHash)
      throw new Error(
        "Choose the exact original CSV file to resume this import.",
      );
    return value?.mapping;
  }, []);
  const run = useCallback(
    async (file: File, mapping: Record<string, string>) => {
      if (working.current) return;
      working.current = true;
      setBusy(true);
      setMessage("");
      try {
        const fileHash = await digest(file);
        if (!current()) return;
        if (
          saved.current &&
          (saved.current.fileHash !== fileHash ||
            JSON.stringify(saved.current.mapping) !== JSON.stringify(mapping))
        )
          throw new Error(
            "Keep the original file and saved mapping to reconcile this import.",
          );
        const intent = {
          version: 1 as const,
          fileHash,
          mapping,
          ...(saved.current?.importId
            ? { importId: saved.current.importId }
            : {}),
        };
        remember(intent);
        const form = new FormData();
        form.append("file", file);
        form.append("columnMapping", JSON.stringify(mapping));
        try {
          const result = await api.postForm<ImportResult | {operationId:string;importStatus:string}>(
            "/api/crm/contacts/import",
            form,
          );
          if (!current()) return;
          if('operationId' in result) {
            if(!/^[a-f0-9-]{36}$/i.test(result.operationId))throw new Error('The background import receipt is invalid. Reconcile this same file.');
            remember({...intent,operationId:result.operationId});
            setMessage('The import is queued in the background. Open its saved operation to follow progress; you can leave this page.');
            return;
          }
          remember({ ...intent, importId: result.importId });
          setStatus(result);
          if (result.importStatus && result.importStatus !== "completed") {
            setMessage(
              "Some rows are saved. Check the receipt before resuming.",
            );
            return;
          }
          completed.current(result);
        } catch (error) {
          if (!current()) return;
          const payload =
            error instanceof ApiError &&
            error.data &&
            typeof error.data === "object"
              ? (error.data as { importId?: number })
              : {};
          if (
            Number.isSafeInteger(payload.importId) &&
            Number(payload.importId) > 0
          ) {
            remember({ ...intent, importId: payload.importId });
            setMessage("Import interrupted; committed rows are retained.");
            await readStatus(payload.importId!);
          } else if (
            error instanceof ApiError &&
            error.status &&
            error.status < 500
          ) {
            remember(null);
            setMessage(error.message);
          } else
            setMessage(
              "The response was lost or interrupted. Reconcile the same import to recover saved rows without repeating committed work.",
            );
        }
      } catch (error) {
        if (current())
          setMessage(
            error instanceof Error
              ? error.message
              : "The import could not be prepared.",
          );
      } finally {
        working.current = false;
        if (current()) setBusy(false);
      }
    },
    [current, readStatus, remember],
  );
  const check = useCallback(async () => {
    if (working.current || !saved.current?.importId) return;
    working.current = true;
    setBusy(true);
    try {
      await readStatus(saved.current.importId);
    } finally {
      working.current = false;
      if (current()) setBusy(false);
    }
  }, [current, readStatus]);
  const clear = useCallback(() => {
    remember(null);
    setStatus(null);
    setMessage("");
  }, [remember]);
  const operationLink=receipt?.operationId ? `/dashboard/crm/import/analyze?operationId=${receipt.operationId}` : undefined;
  return { receipt, status, message, busy, run, check, clear, verifyFile,operationLink };
}
