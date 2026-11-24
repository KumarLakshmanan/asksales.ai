import { z } from 'zod';

export const reviewedMediaCountSchema = z.number().int().min(1).max(4);
const promptSchema = z.array(z.string().trim().min(1).max(10_000)).max(4);

/** A model supplies candidate prompts, never authority to increase the reviewed
 * number of provider operations. Missing legacy counts mean one operation. */
export function reviewedMediaPrompts(prompts: unknown, count?: number): string[] {
  const maximum = reviewedMediaCountSchema.parse(count ?? 1);
  return promptSchema.parse(prompts).slice(0, maximum);
}
