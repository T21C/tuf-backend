-- Destructive: clears all local TUFStellar subscription/billing state and webhook history.
-- Does NOT cancel subscriptions at Xsolla — do that in Publisher Account if needed.
-- After running, re-run player search reindex if you use Elasticsearch for subscription-derived fields.
--
-- MySQL / MariaDB. Column names match Sequelize migrations (camelCase on `users`).

START TRANSACTION;

DELETE FROM billing_events;

UPDATE users
SET
  tufStellarSubscriptionExpiresAt = NULL,
  tufStellarSubscriptionExternalId = NULL,
  tufStellarSubscriptionPlanExternalId = NULL,
  tufStellarSubscriptionCancelledAt = NULL,
  tufStellarBillingLifecycleState = 'inactive',
  tufStellarPendingAutoRenew = NULL,
  tufStellarPendingGiftBeneficiaryUserId = NULL,
  tufStellarPendingGiftMonths = NULL,
  tufStellarRecurringPeriodEndAt = NULL,
  tufStellarXsollaBillingSyncAt = NULL;

UPDATE players
SET tufStellarIconVariant = '1';

UPDATE creators
SET tufStellarIconVariant = '1';

COMMIT;
