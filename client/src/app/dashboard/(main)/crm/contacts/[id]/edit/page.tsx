"use client";

import { useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { api } from '@/lib/api';
import { selectedBusinessProfileId, subscribeBusinessProfile } from '@/lib/business-profile';
import { ContactEditForm } from '@/components/crm/ContactEditForm';
import { CrmNavigation } from '@/components/crm/CrmNavigation';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { contactDisplayName, type Contact } from '@/lib/crm-workspace';

export default function ContactEditPage() {
  const {id}=useParams<{id:string}>();
  const router=useRouter();
  const client=useQueryClient();
  const {user}=useAuth();
  const profileId=useSyncExternalStore(subscribeBusinessProfile,selectedBusinessProfileId,()=>null);
  const contactId=Number(id);
  const scope=`${user?.id ?? 'anonymous'}:${profileId ?? user?.businessProfileId ?? 'default'}:${contactId}`;
  // A malformed link never enables the query; show an error, not a spinner.
  const validContactId=Number.isSafeInteger(contactId) && contactId!==0;
  const contact=useQuery({queryKey:['crm-contact-workspace',user?.id ?? null,profileId,contactId,'contact'],
    queryFn:({signal})=>api.get<Contact>(`/api/crm/contacts/${contactId}`,{signal}),enabled:!!user && validContactId,staleTime:0,retry:false});
  const saved=(updated:Contact)=>{
    const canonicalId=updated.id || contactId;
    client.setQueryData(['crm-contact-workspace',user?.id ?? null,profileId,canonicalId,'contact'],updated);
    void client.invalidateQueries({queryKey:['crm-contact-workspace',user?.id ?? null,profileId,contactId]});
    router.push(`/dashboard/crm/contacts/${canonicalId}`);
  };
  return <div className="mx-auto max-w-4xl space-y-5 p-4 sm:p-6 lg:p-8"><CrmNavigation current="contacts" /><Link href={`/dashboard/crm/contacts/${id}`} className="inline-flex items-center gap-2 rounded text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><ArrowLeft className="h-4 w-4" />Back to contact</Link><header><p className="mb-1 text-xs font-medium uppercase tracking-widest text-muted-foreground">Contact editor</p><h1 className="text-2xl font-semibold tracking-tight sm:text-3xl" style={{fontFamily:'var(--font-heading)'}}>Edit {contact.data ? contactDisplayName(contact.data) : 'contact'}</h1><p className="mt-2 text-sm text-muted-foreground">Manage contact details, ownership, deal information, and relationship context.</p></header>{contact.isPending && validContactId ? <div role="status" className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Spinner size="sm" label={null} />Loading contact…</div> : contact.error || !contact.data ? <Alert variant="destructive"><AlertTitle>Contact could not be loaded</AlertTitle><AlertDescription>{!validContactId ? 'This contact link is not valid.' : contact.error instanceof Error ? contact.error.message : 'Check the selected business profile.'}<Button size="sm" variant="outline" className="ml-2" onClick={()=>void contact.refetch()}>Try again</Button></AlertDescription></Alert> : <div className="overflow-hidden rounded-xl border border-border bg-card"><ContactEditForm key={scope} contact={contact.data} scope={scope} onCancel={()=>router.push(`/dashboard/crm/contacts/${contactId}`)} onSaved={saved} /></div>}</div>;
}
