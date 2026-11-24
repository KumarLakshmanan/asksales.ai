import {Suspense} from 'react';
import {PrepareOutreachForm} from '@/components/outreach/create/PrepareOutreachForm';
export default function Page() {return <Suspense fallback={<p className="p-6">Loading outreach preparation…</p>}><PrepareOutreachForm/></Suspense>;}
