"use client";

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { DM_DESTINATIONS, dmOutreachPath } from '@/lib/dmOutreach';

export function useDmOutreach() {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const openOutreach = (text: string, platform?: string) => {
    const path = dmOutreachPath(platform, text);
    if (path) router.push(path);
    else setMessage(text);
  };
  const destinationDialog = (
    <Dialog open={message !== null} onOpenChange={open => { if (!open) setMessage(null); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Choose an outreach channel</DialogTitle>
          <DialogDescription>This draft is not tied to a single channel. Choose where to review recipients and connection settings. Nothing is sent yet.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 sm:grid-cols-2">
          {DM_DESTINATIONS.map(destination => <Button key={destination.value} variant="outline" onClick={() => {
            if (message !== null) openOutreach(message, destination.value);
            setMessage(null);
          }}>{destination.label}</Button>)}
        </div>
      </DialogContent>
    </Dialog>
  );
  return { openOutreach, destinationDialog };
}
