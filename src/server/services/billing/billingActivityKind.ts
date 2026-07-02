import type BillingEvent from '@/models/billing/BillingEvent.js';
import { isAdminGrantBillingEvent } from '@/server/services/billing/tufStellarAdminGrantBillingEvent.js';

export type BillingActivityKind =
  | 'gift_received'
  | 'gift_sent'
  | 'one_time_self'
  | 'admin_grant_received'
  | 'admin_grant_sent'
  | 'default';

/**
 * Classifies a billing row for the viewer (Stripe TUF Stellar checkout: purchaser + beneficiary UUIDs).
 * Handles anonymized rows where one side was nulled after account deletion.
 */
export function classifyBillingActivityKind(row: BillingEvent, viewerUserId: string): BillingActivityKind {
  const me = String(viewerUserId).trim().toLowerCase();
  const purchaserId = row.userId ? String(row.userId).trim().toLowerCase() : '';
  const benId = row.beneficiaryUserId ? String(row.beneficiaryUserId).trim().toLowerCase() : '';

  if (isAdminGrantBillingEvent(row)) {
    if (benId === me) return 'admin_grant_received';
    if (purchaserId === me && benId && benId !== purchaserId) return 'admin_grant_sent';
    return 'default';
  }

  if (!purchaserId && !benId) return 'default';

  if (purchaserId && benId && purchaserId === benId && purchaserId === me) {
    return 'one_time_self';
  }

  if (benId === me && purchaserId !== me) {
    return 'gift_received';
  }

  if (purchaserId === me && (!benId || benId !== purchaserId)) {
    return 'gift_sent';
  }

  return 'default';
}
