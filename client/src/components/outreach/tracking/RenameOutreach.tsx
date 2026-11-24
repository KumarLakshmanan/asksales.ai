"use client";

import { useId, useState, type FormEvent } from "react";
import { Pencil } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/** Renames an outreach. The name is only a label for the tracking pages. */
export function RenameOutreach({ batchId, name, onRenamed }: { batchId: string; name: string; onRenamed: () => void }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const trimmed = value.trim();

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!trimmed || saving) return;
    if (trimmed === name) { setOpen(false); return; }
    setSaving(true); setError("");
    try {
      await api.patch(`/api/outreach/batches/${batchId}`, { name: trimmed });
      setOpen(false);
      onRenamed();
    } catch (reason) {
      setError(reason instanceof Error && reason.message ? reason.message : "The name could not be saved. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={next => { setOpen(next); if (next) { setValue(name); setError(""); } }}>
      <DialogTrigger asChild>
        <Button variant="outline"><Pencil aria-hidden="true" />Rename</Button>
      </DialogTrigger>
      <DialogContent>
        <form onSubmit={save} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Rename this outreach</DialogTitle>
            <DialogDescription>Only you and your team see this name. Recipients never do.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor={`${id}-name`}>Name</Label>
            <Input id={`${id}-name`} value={value} maxLength={200} autoFocus onChange={event => setValue(event.target.value)}
              aria-invalid={Boolean(error) || undefined} aria-describedby={error ? `${id}-error` : undefined} />
            {error ? <p id={`${id}-error`} role="alert" className="text-sm text-destructive">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={!trimmed} loading={saving} loadingText="Saving…">Save name</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
