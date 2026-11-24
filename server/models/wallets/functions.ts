import { resolveBillingOrganization } from '../../services/billing/organizations.js';
/**
 * Wallets Functions
 * CRUD operations for user wallets
 */

import { eq, sql, and, gte } from "drizzle-orm";
import { db } from "../db.js";
import { walletsTable, type WalletRecord } from "./schema.js";

// Every caller keeps its actor/resource user ID; the payer is resolved separately.
export async function getOrCreateWallet(userId: number): Promise<WalletRecord> {
  const organizationId = await resolveBillingOrganization(userId);
  const [existing] = await db.select().from(walletsTable).where(eq(walletsTable.organizationId, organizationId));
  if(existing) return existing;
  await db.execute(sql`INSERT INTO wallets(user_id,organization_id)
    SELECT owner_user_id,id FROM billing_organizations WHERE id=${organizationId}
    ON CONFLICT(organization_id) DO NOTHING`);
  const [wallet] = await db.select().from(walletsTable).where(eq(walletsTable.organizationId, organizationId));
  if(!wallet) throw new Error('Unable to initialize organization wallet');
  return wallet;
}

// Add credits to wallet (recharge)
export async function addCredits(userId: number, amount: number): Promise<WalletRecord> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const wallet = await getOrCreateWallet(userId);
  const [updated] = await db
    .update(walletsTable)
    .set({
      balance: sql`${walletsTable.balance} + ${amount}`,
      totalCreditsAdded: sql`${walletsTable.totalCreditsAdded} + ${amount}`,
      updatedAt: new Date(),
    })
    .where(eq(walletsTable.id, wallet.id))
    .returning();
  return updated;
}

// Deduct credits from wallet (atomic - prevents race conditions)
export async function deductCredits(userId: number, amount: number): Promise<WalletRecord | null> {
  // Ensure wallet exists
  const wallet = await getOrCreateWallet(userId);

  // Atomic update: only succeeds if balance >= amount
  const result = await db
    .update(walletsTable)
    .set({
      balance: sql`${walletsTable.balance} - ${amount}`,
      totalCreditsUsed: sql`${walletsTable.totalCreditsUsed} + ${amount}`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(walletsTable.id, wallet.id),
      gte(walletsTable.balance, amount.toString())
    ))
    .returning();

  return result[0] || null;
}

// Get wallet balance
export async function getBalance(userId: number): Promise<number> {
  const wallet = await getOrCreateWallet(userId);
  return parseFloat(wallet.balance as string);
}
