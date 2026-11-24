import type { Metadata } from 'next';
import AssistantList from '@/components/outreach/assistants/AssistantList';

export const metadata: Metadata = { title: 'Assistants', description: 'Choose who replies on each account in Ask Sales.' };

export default function OutreachSettingsPage() { return <AssistantList />; }
