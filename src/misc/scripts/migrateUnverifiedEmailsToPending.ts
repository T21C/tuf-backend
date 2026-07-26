/**
 * Optional dry-run preview for unverified email → pendingEmail backfill.
 * Schema + real backfill live in sequelize-cli migrations:
 *   1785073043_add_email_credential_security_schema.cjs
 *   1785073044_backfill_unverified_emails_to_pending.cjs
 *
 * Preferred:
 *   cd server && npm run migrate
 *
 * Preview only:
 *   npx tsx src/misc/scripts/migrateUnverifiedEmailsToPending.ts
 */
import dotenv from 'dotenv';
dotenv.config();

import { Op } from 'sequelize';
import User from '@/models/auth/User.js';
import { permissionFlags } from '@/config/constants.js';
import { logger } from '@/server/services/core/LoggerService.js';
import sequelize from '@/config/db.js';

async function main() {
  await sequelize.authenticate();
  logger.info(
    'Preview only — apply schema/data with: npm run migrate (migrations 1785073043 / 1785073044)',
  );

  const users = await User.findAll({
    where: {
      email: { [Op.ne]: null },
    },
    attributes: ['id', 'email', 'pendingEmail', 'permissionFlags', 'passwordResetToken'],
  });

  let wouldMove = 0;
  let wouldClearToken = 0;

  for (const user of users) {
    const flags = BigInt(user.permissionFlags || 0);
    const verified = (flags & permissionFlags.EMAIL_VERIFIED) === permissionFlags.EMAIL_VERIFIED;

    if (!verified && user.email) {
      logger.info(`Would move unverified email for user ${user.id}`);
      wouldMove++;
      continue;
    }

    if (user.passwordResetToken) {
      wouldClearToken++;
    }
  }

  logger.info(`Preview done. wouldMove=${wouldMove} wouldClearLegacyTokens=${wouldClearToken}`);
  process.exit(0);
}

main().catch((err) => {
  logger.error('Preview failed', err);
  process.exit(1);
});
