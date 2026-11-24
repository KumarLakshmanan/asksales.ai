'use client';
import { AeoView } from './AeoView';
import { GeoView } from './GeoView';
export function PromptView({ projectId, kind }: { projectId: number; kind: 'aeo' | 'geo' }) {
  return kind === 'aeo' ? <AeoView projectId={projectId} /> : <GeoView projectId={projectId} />;
}
