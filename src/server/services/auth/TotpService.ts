import User from '@/models/auth/User.js';
import TotpRecoveryCode from '@/models/auth/TotpRecoveryCode.js';
import {decodeAes256GcmKey, decryptSecret, encryptSecret} from '@/misc/utils/crypto/secretBox.js';
import {logger} from '@/server/services/core/LoggerService.js';
import {
  asStep,
  buildOtpauthUri,
  decodeBase32,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  isTotpCode,
  normalizeRecoveryCode,
  TOTP_ISSUER,
  verifyTotp,
} from '@/misc/utils/auth/totp.js';

export class TotpError extends Error {
  constructor(
    message: string,
    public statusCode: number = 400,
    public code?: string,
  ) {
    super(message);
    this.name = 'TotpError';
  }
}

export interface TotpSetupResult {
  otpauthUri: string;
  secret: string;
}

let warnedAboutKey = false;

function encryptionKey(): Buffer {
  const raw = process.env.TOTP_ENCRYPTION_KEY;
  if (typeof raw !== 'string' || !raw.trim()) {
    if (!warnedAboutKey) {
      warnedAboutKey = true;
      logger.warn('totp_encryption_key_missing');
    }
    throw new TotpError(
      'Authenticator setup is unavailable',
      503,
      'TOTP_ENCRYPTION_UNAVAILABLE',
    );
  }
  const key = decodeAes256GcmKey(raw);
  if (!key) {
    if (!warnedAboutKey) {
      warnedAboutKey = true;
      logger.warn('totp_encryption_key_invalid');
    }
    throw new TotpError(
      'Authenticator setup is unavailable',
      503,
      'TOTP_ENCRYPTION_UNAVAILABLE',
    );
  }
  return key;
}

function encryptTotpSecret(plainBase32: string): string {
  return encryptSecret(plainBase32, encryptionKey());
}

function secretBytesFromEnc(payload: string | null | undefined): Buffer {
  if (!payload) {
    throw new TotpError('Authenticator is not set up', 400, 'TOTP_SETUP_REQUIRED');
  }
  let base32: string;
  try {
    base32 = decryptSecret(payload, encryptionKey());
  } catch {
    logger.warn('totp_secret_decrypt_failed');
    throw new TotpError('Authenticator is not set up', 400, 'TOTP_SETUP_REQUIRED');
  }
  try {
    return decodeBase32(base32);
  } catch {
    throw new TotpError('Authenticator is not set up', 400, 'TOTP_SETUP_REQUIRED');
  }
}

function requireUser(user: User | null): User {
  if (!user) {
    throw new TotpError('User not found', 401, 'USER_NOT_FOUND');
  }
  return user;
}

function requireEnabled(user: User): void {
  if (!user.totpEnabled) {
    throw new TotpError('Authenticator is not enabled', 400, 'TOTP_NOT_ENABLED');
  }
}

function invalidCode(): never {
  throw new TotpError('Invalid authenticator or recovery code', 400, 'TOTP_INVALID_CODE');
}

async function consumeRecoveryCode(user: User, code: string): Promise<boolean> {
  const normalized = normalizeRecoveryCode(code);
  if (normalized.length < 8) return false;
  const codeHash = hashRecoveryCode(user.id, normalized);
  const row = await TotpRecoveryCode.findOne({
    where: {userId: user.id, codeHash, usedAt: null},
  });
  if (!row) return false;
  await row.update({usedAt: new Date()});
  return true;
}

async function verifyEnabledTotp(user: User, code: string): Promise<number> {
  const secret = secretBytesFromEnc(user.totpSecretEnc);
  const result = verifyTotp({
    secret,
    code,
    lastAcceptedStep: asStep(user.totpLastAcceptedStep),
  });
  if (!result.ok) invalidCode();
  await user.update({totpLastAcceptedStep: result.step});
  return result.step;
}

async function assertCurrentFactor(user: User, code: string | undefined): Promise<void> {
  requireEnabled(user);
  if (!code || typeof code !== 'string' || !code.trim()) {
    throw new TotpError(
      'Authenticator or recovery code is required',
      400,
      'TOTP_CODE_REQUIRED',
    );
  }
  if (isTotpCode(code)) {
    await verifyEnabledTotp(user, code);
    return;
  }
  const used = await consumeRecoveryCode(user, code);
  if (!used) invalidCode();
}

function otpauthFor(user: User, secretBase32: string): TotpSetupResult {
  return {
    secret: secretBase32,
    otpauthUri: buildOtpauthUri({
      issuer: TOTP_ISSUER,
      account: user.username || user.email || user.id,
      secretBase32,
    }),
  };
}

class TotpService {
  async setup(userId: string, code?: string): Promise<TotpSetupResult> {
    const user = requireUser(await User.findByPk(userId));
    if (user.totpEnabled) {
      await assertCurrentFactor(user, code);
    }

    const generated = generateTotpSecret();
    const encrypted = encryptTotpSecret(generated.base32);
    if (user.totpEnabled) {
      await user.update({totpPendingSecretEnc: encrypted});
    } else {
      await user.update({
        totpSecretEnc: encrypted,
        totpPendingSecretEnc: null,
        totpLastAcceptedStep: null,
        totpEnabled: false,
      });
    }
    return otpauthFor(user, generated.base32);
  }

  async confirm(userId: string, code: string | undefined): Promise<{recoveryCodes: string[]}> {
    const user = requireUser(await User.findByPk(userId));
    if (!code || typeof code !== 'string' || !isTotpCode(code)) {
      throw new TotpError('Authenticator code is required', 400, 'TOTP_CODE_REQUIRED');
    }

    const pendingEnc = user.totpEnabled ? user.totpPendingSecretEnc : null;
    const secretEnc = pendingEnc || (!user.totpEnabled ? user.totpSecretEnc : null);
    if (!secretEnc) {
      throw new TotpError('Authenticator setup has not been started', 400, 'TOTP_SETUP_REQUIRED');
    }

    const secret = secretBytesFromEnc(secretEnc);
    const result = verifyTotp({secret, code});
    if (!result.ok) invalidCode();

    const sequelize = User.sequelize;
    if (!sequelize) {
      throw new TotpError('Authenticator setup failed', 500, 'TOTP_SETUP_FAILED');
    }

    const recoveryCodes = generateRecoveryCodes();
    const now = new Date();
    await sequelize.transaction(async (transaction) => {
      await user.update(
        {
          totpSecretEnc: secretEnc,
          totpPendingSecretEnc: null,
          totpEnabled: true,
          totpLastAcceptedStep: result.step,
        },
        {transaction},
      );
      await TotpRecoveryCode.destroy({where: {userId: user.id}, transaction});
      await TotpRecoveryCode.bulkCreate(
        recoveryCodes.map((recovery) => ({
          userId: user.id,
          codeHash: hashRecoveryCode(user.id, recovery),
          createdAt: now,
          updatedAt: now,
        })),
        {transaction},
      );
    });

    return {recoveryCodes};
  }

  async regenerateRecovery(userId: string, code: string | undefined): Promise<{recoveryCodes: string[]}> {
    const user = requireUser(await User.findByPk(userId));
    await assertCurrentFactor(user, code);
    const recoveryCodes = generateRecoveryCodes();
    const now = new Date();
    const sequelize = User.sequelize;
    if (!sequelize) {
      throw new TotpError('Failed to regenerate recovery codes', 500, 'TOTP_SETUP_FAILED');
    }
    await sequelize.transaction(async (transaction) => {
      await TotpRecoveryCode.destroy({where: {userId: user.id}, transaction});
      await TotpRecoveryCode.bulkCreate(
        recoveryCodes.map((recovery) => ({
          userId: user.id,
          codeHash: hashRecoveryCode(user.id, recovery),
          createdAt: now,
          updatedAt: now,
        })),
        {transaction},
      );
    });
    return {recoveryCodes};
  }

  async disable(userId: string, code: string | undefined): Promise<void> {
    const user = requireUser(await User.findByPk(userId));
    await assertCurrentFactor(user, code);
    const sequelize = User.sequelize;
    if (!sequelize) {
      throw new TotpError('Failed to disable authenticator', 500, 'TOTP_DISABLE_FAILED');
    }
    await sequelize.transaction(async (transaction) => {
      await user.update(
        {
          totpSecretEnc: null,
          totpPendingSecretEnc: null,
          totpEnabled: false,
          totpLastAcceptedStep: null,
        },
        {transaction},
      );
      await TotpRecoveryCode.destroy({where: {userId: user.id}, transaction});
    });
  }

  async verifyLoginTotp(userId: string, code: string | undefined): Promise<User> {
    const user = requireUser(await User.findByPk(userId));
    requireEnabled(user);
    if (!code || typeof code !== 'string' || !isTotpCode(code)) {
      throw new TotpError('Authenticator code is required', 400, 'TOTP_CODE_REQUIRED');
    }
    await verifyEnabledTotp(user, code);
    return user;
  }

  async verifyLoginRecovery(userId: string, code: string | undefined): Promise<User> {
    const user = requireUser(await User.findByPk(userId));
    requireEnabled(user);
    if (!code || typeof code !== 'string' || !code.trim()) {
      throw new TotpError('Recovery code is required', 400, 'TOTP_CODE_REQUIRED');
    }
    if (isTotpCode(code)) invalidCode();
    const used = await consumeRecoveryCode(user, code);
    if (!used) invalidCode();
    return user;
  }
}

export const totpService = new TotpService();
