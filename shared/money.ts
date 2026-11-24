/** Round to two decimal places (cents), nudged by EPSILON so 1.005 rounds up. */
export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
