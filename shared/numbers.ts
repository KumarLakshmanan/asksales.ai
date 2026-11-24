/** True for safe integers greater than zero (record ids). */
export const isPositiveSafeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
