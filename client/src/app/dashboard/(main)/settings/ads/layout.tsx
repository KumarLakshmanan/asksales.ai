import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Ad Settings',
  description: 'Campaign budget, targeting, provider safety, and autonomous optimization settings.',
};

export default function AdSettingsLayout({ children }: { children: React.ReactNode }) {
  return children;
}
