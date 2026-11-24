import type { Metadata } from 'next';
import CreateAssistant from '@/components/outreach/assistants/CreateAssistant';

export const metadata: Metadata = { title: 'Create assistant', description: 'Create a customer reply assistant in Ask Sales.' };

export default function CreateAssistantPage() { return <CreateAssistant />; }
