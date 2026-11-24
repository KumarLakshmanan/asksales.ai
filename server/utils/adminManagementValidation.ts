import { z } from 'zod';
import { passwordSchema } from '../middleware/schemas.js';
import { DEFAULT_BUSINESS_TIMEZONE, isValidIanaTimezone } from './timezone.js';

const name = z.string().trim().min(1, 'Name is required').max(255);
const email = z.string().trim().toLowerCase().max(255).email('Invalid email address');
const timezone = z.string().trim().max(100)
  .refine(value => !value || isValidIanaTimezone(value), 'Invalid timezone')
  .transform(value => value || DEFAULT_BUSINESS_TIMEZONE);
const profileFields = {
  name, email,
  role: z.enum(['user', 'admin']),
  phone: z.string().trim().max(50).nullable(),
  bio: z.string().trim().max(2000).nullable(),
  timezone,
};

export const adminUserCreateSchema = z.object({
  ...profileFields,
  password: passwordSchema,
  role: profileFields.role.optional().default('user'),
  phone: profileFields.phone.optional(),
  bio: profileFields.bio.optional(),
  timezone: timezone.optional(),
}).strict();

// Password changes have a dedicated, super-admin-authorized endpoint.
export const adminUserUpdateSchema = z.object(profileFields).partial().strict()
  .refine(value => Object.values(value).some(field => field !== undefined), 'At least one field is required');

export const adminManagementIdSchema = z.object({
  id: z.string().regex(/^[1-9]\d*$/, 'ID must be a positive integer')
    .refine(value => Number(value) <= 2147483647, 'ID is outside the supported range'),
});

// Preserve numeric-day reporting without inventing a new retention horizon.
export const adminUserUsageQuerySchema = z.object({
  days: z.string().regex(/^[1-9]\d*$/, 'Days must be a positive integer').default('30')
    .transform(Number).refine(Number.isSafeInteger, 'Days are outside the supported range'),
}).strict();
