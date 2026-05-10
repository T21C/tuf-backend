import UserTufStellarBilling from '@/models/billing/UserTufStellarBilling.js';

/** Read billing extension; missing row means “empty” billing (APIs that need a row should use {@link loadOrCreateUserTufStellarBilling}). */
export async function loadUserTufStellarBilling(userId: string): Promise<UserTufStellarBilling | null> {
  return UserTufStellarBilling.findByPk(userId);
}

/** Ensures a persisted row exists before updates (lazy 1:1 materialization). */
export async function loadOrCreateUserTufStellarBilling(userId: string): Promise<UserTufStellarBilling> {
  const [row] = await UserTufStellarBilling.findOrCreate({
    where: { userId },
    defaults: {
      userId,
    },
  });
  return row;
}
