import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Workspace configuration',
  description: 'Find configuration for the selected Ask Sales workspace.',
};

export default function Layout({ children }: { children: React.ReactNode }) { return children; }
