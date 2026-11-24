"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { Save, RefreshCw } from "lucide-react";
import { validateMSG91Settings, type MSG91SenderSettings } from "@/lib/msg91";

export type MSG91FormData = MSG91SenderSettings & { authKey: string };

interface MSG91ConfigProps {
  formData: MSG91FormData;
  onFormChange: (data: Partial<MSG91FormData>) => void;
  onSave: () => Promise<void>;
  onTest: () => Promise<void>;
  saving: boolean;
  testing: boolean;
  hasAuthKey: boolean;
  disabled?: boolean;
}

export function MSG91Config({ formData, onFormChange, onSave, onTest, saving, testing, hasAuthKey, disabled = false }: MSG91ConfigProps) {
  const validation = validateMSG91Settings(formData);
  const incomplete = Boolean(validation || (!formData.authKey.trim() && !hasAuthKey));
  const busy = disabled || saving || testing;

  return <Card className="overflow-hidden rounded-xl border bg-card shadow-sm">
    <div className="border-b bg-muted/25 px-4 py-3"><h3 className="text-sm font-semibold">MSG91 sender details</h3></div>
    <CardContent className="p-4">
      <form onSubmit={event => { event.preventDefault(); if (!busy && !incomplete) void onSave(); }}>
        <fieldset disabled={busy} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="msg91-auth-key">MSG91 Auth Key</Label>
            <Input id="msg91-auth-key" type="password" autoComplete="off" spellCheck={false} maxLength={1024}
              value={formData.authKey} onChange={event => onFormChange({ authKey: event.target.value })}
              placeholder={hasAuthKey ? "Saved securely" : "Enter your MSG91 Auth Key"} aria-describedby="msg91-auth-help" />
            <p id="msg91-auth-help" className="text-xs leading-5 text-muted-foreground">{hasAuthKey ? "Leave blank to keep your saved Auth Key, or enter a replacement." : "Copy a key with SMS API access from your MSG91 account."}</p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor="msg91-sender-id">Approved Sender ID</Label>
              <Input id="msg91-sender-id" value={formData.senderId} maxLength={6} spellCheck={false}
                onChange={event => onFormChange({ senderId: event.target.value.toUpperCase() })} placeholder="ABCDEF" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="msg91-template-id">SMS Template ID</Label>
              <Input id="msg91-template-id" value={formData.flowId} maxLength={255} spellCheck={false}
                onChange={event => onFormChange({ flowId: event.target.value })} placeholder="Copy from MSG91" />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="msg91-message-variable">Message variable</Label>
              <Input id="msg91-message-variable" value={formData.messageVariable} maxLength={64} spellCheck={false}
                onChange={event => onFormChange({ messageVariable: event.target.value })} placeholder="message" />
            </div>
          </div>
          <p className="text-xs leading-6 text-muted-foreground">Use the Template ID shown in MSG91 and a template with one text variable, such as <code>##message##</code>. Enter only the variable name; it is case-sensitive.</p>
          {validation && (formData.senderId || formData.flowId) && <p className="text-sm text-amber-700 dark:text-amber-300" role="status">{validation}</p>}
          <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
            <Button type="button" variant="outline" className="rounded-full" onClick={() => void onTest()} loading={testing} loadingText="Test connection" disabled={busy || incomplete}>
              <RefreshCw className="mr-2 h-4 w-4" />Test connection
            </Button>
            <Button type="submit" className="rounded-full" loading={saving} loadingText="Save connection" disabled={busy || incomplete}>
              <Save className="mr-2 h-4 w-4" />Save connection
            </Button>
          </div>
          <p className="text-xs leading-5 text-muted-foreground">Testing and saving verify your sender and template without sending an SMS.</p>
        </fieldset>
      </form>
    </CardContent>
  </Card>;
}
