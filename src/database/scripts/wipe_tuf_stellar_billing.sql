-- Destructive: clears all local TUFStellar subscription/billing state and webhook history.
-- Does NOT cancel subscriptions at Xsolla — do that in Publisher Account if needed.
-- After running, re-run player/creator search reindex if you use Elasticsearch for subscription-derived fields.
--
-- MySQL / MariaDB.

SET SQL_SAFE_UPDATES = 0;
START TRANSACTION;

DELETE FROM billing_events;

DELETE FROM user_tuf_stellar_entitlement_segments;

DELETE FROM user_tuf_stellar_billing;

UPDATE players
SET tufStellarIconVariant = '1';

UPDATE creators
SET tufStellarIconVariant = '1';

SET SQL_SAFE_UPDATES = 1;
COMMIT;
