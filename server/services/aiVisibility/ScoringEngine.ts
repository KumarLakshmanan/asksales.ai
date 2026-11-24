import { createHash } from 'node:crypto';
import type { AiVisibilityProfile, PillarStatus } from '../../models/aiVisibility/schema.js';

export interface PillarInput {
  score: number | null;
  status: PillarStatus;
}

const PROFILE_WEIGHTS: Record<
  AiVisibilityProfile,
  Record<'seo' | 'aeo' | 'geo' | 'commerce', number>
> = {
  b2b_saas: { seo: 0.35, aeo: 0.25, geo: 0.4, commerce: 0 },
  ecommerce: { seo: 0.25, aeo: 0.2, geo: 0.3, commerce: 0.25 },
  local_business: { seo: 0.4, aeo: 0.25, geo: 0.35, commerce: 0 },
  general: { seo: 0.35, aeo: 0.25, geo: 0.4, commerce: 0 },
};

export function calculateVisibilityScore(
  profile: AiVisibilityProfile,
  pillars: Record<'seo' | 'aeo' | 'geo' | 'commerce', PillarInput>,
) {
  const configured = PROFILE_WEIGHTS[profile];
  const available = Object.entries(pillars).filter(
    ([, pillar]) => pillar.status === 'scored' && pillar.score !== null,
  ) as Array<[keyof typeof pillars, PillarInput]>;
  const availableWeight = available.reduce((sum, [key]) => sum + configured[key], 0);
  const normalizedWeights = Object.fromEntries(
    Object.keys(configured).map((key) => [
      key,
      availableWeight > 0 && pillars[key as keyof typeof pillars].status === 'scored'
        ? configured[key as keyof typeof configured] / availableWeight
        : 0,
    ]),
  );
  const overallScore =
    availableWeight === 0
      ? 0
      : available.reduce(
          (sum, [key, pillar]) => sum + (pillar.score || 0) * (normalizedWeights[key] || 0),
          0,
        );
  const inputFingerprint = createHash('sha256')
    .update(JSON.stringify({ version: 2, profile, pillars, normalizedWeights }))
    .digest('hex');
  return {
    overallScore: Math.round(overallScore * 100) / 100,
    normalizedWeights,
    inputFingerprint,
    version: 2,
  };
}
