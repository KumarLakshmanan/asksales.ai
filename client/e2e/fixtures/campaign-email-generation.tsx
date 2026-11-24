// Browser-only workbench: the real production composers and UI, fictional inputs, no send handler.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SendEmailModal } from '../../src/components/modals/SendEmailModal';
import { OutreachDialog } from '../../src/components/OutreachDialog';
import { Toaster } from '../../src/components/ui/toaster';

const lead = { id: 901, name: 'Fixture Ada', email: 'ada@example.test', company: 'Fixture Company', role: 'Operations' };
declare global {
  interface Window {
    emailWorkbench: { recipient: () => void; close: () => void; reopen: () => void; navigate: () => void };
  }
}

function Workbench() {
  const [open, setOpen] = useState(true);
  const [leads, setLeads] = useState([lead]);
  const [mounted, setMounted] = useState(true);
  const caller = new URLSearchParams(window.location.search).get('caller');
  useEffect(() => {
    window.emailWorkbench = {
      recipient: () => setLeads([{ ...lead, id: 902, name: 'Fixture Bob' }]),
      close: () => setOpen(false), reopen: () => setOpen(true), navigate: () => setMounted(false),
    };
  }, []);
  return <>
    <main><h1>Campaign email generation browser fixture</h1></main>
    {mounted && (caller === 'send'
      ? <SendEmailModal open={open} onOpenChange={setOpen} leads={leads} initialSubject="Existing reviewed subject" initialBody="Existing reviewed manual body." />
      : <OutreachDialog open={open} onOpenChange={setOpen} leads={leads} onConfirm={async () => { throw new Error('Sending is disabled in this fixture.'); }} />)}
    <Toaster />
  </>;
}

createRoot(document.getElementById('root')!).render(<Workbench />);
