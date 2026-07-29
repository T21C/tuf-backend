import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import { Op } from 'sequelize';
import PasskeyCredential from '@/models/auth/PasskeyCredential.js';
import WebAuthnChallenge, {
  type WebAuthnChallengeType,
} from '@/models/auth/WebAuthnChallenge.js';
import User from '@/models/auth/User.js';
import {
  RP_ID,
  RP_NAME,
  EXPECTED_ORIGIN,
  WEBAUTHN_CHALLENGE_TTL_SEC,
  MAX_PASSKEYS_PER_USER,
} from '@/config/webauthn.config.js';
import { summarizeUserAgent } from '@/server/services/accounts/SecurityNotificationService.js';
import { logger } from '@/server/services/core/LoggerService.js';

export class PasskeyError extends Error {
  constructor(
    message: string,
    public statusCode: number = 400,
    public code?: string,
  ) {
    super(message);
    this.name = 'PasskeyError';
  }
}

export interface PasskeyListItem {
  id: string;
  name: string;
  deviceType: string | null;
  backedUp: boolean;
  createdAt: Date;
  lastUsedAt: Date | null;
}

function parseTransports(raw: string | null): AuthenticatorTransportFuture[] | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as AuthenticatorTransportFuture[];
  } catch {
    // ignore
  }
  return undefined;
}

function serializeTransports(
  transports: AuthenticatorTransportFuture[] | undefined,
): string | null {
  if (!transports || transports.length === 0) return null;
  return JSON.stringify(transports);
}

function clampName(name: string): string {
  return name.trim().slice(0, 64) || 'Passkey';
}

function userIdToBytes(userId: string): Uint8Array {
  return new TextEncoder().encode(userId);
}

class PasskeyService {
  private async purgeExpiredChallenges(): Promise<void> {
    await WebAuthnChallenge.destroy({
      where: { expiresAt: { [Op.lt]: new Date() } },
    });
  }

  private async storeChallenge(
    challenge: string,
    type: WebAuthnChallengeType,
    userId: string | null,
  ): Promise<void> {
    await this.purgeExpiredChallenges();
    await WebAuthnChallenge.create({
      challenge,
      type,
      userId,
      expiresAt: new Date(Date.now() + WEBAUTHN_CHALLENGE_TTL_SEC * 1000),
    });
  }

  /**
   * Look up by the challenge echoed in clientDataJSON, validate type/user, burn it.
   */
  private async consumeChallenge(
    challenge: string,
    type: WebAuthnChallengeType,
    expectedUserId?: string | null,
  ): Promise<void> {
    const row = await WebAuthnChallenge.findOne({ where: { challenge } });
    if (!row || row.type !== type || row.expiresAt.getTime() <= Date.now()) {
      if (row) await row.destroy();
      throw new PasskeyError(
        'Passkey challenge expired. Please try again.',
        400,
        'PASSKEY_CHALLENGE_EXPIRED',
      );
    }
    if (
      expectedUserId !== undefined &&
      expectedUserId !== null &&
      row.userId &&
      row.userId !== expectedUserId
    ) {
      await row.destroy();
      throw new PasskeyError(
        'Passkey challenge mismatch',
        400,
        'PASSKEY_CHALLENGE_MISMATCH',
      );
    }
    await row.destroy();
  }

  async registrationOptions(user: User) {
    const existing = await PasskeyCredential.findAll({
      where: { userId: user.id },
      attributes: ['credentialId', 'transports'],
    });

    const options = await generateRegistrationOptions({
      rpName: RP_NAME,
      rpID: RP_ID,
      userID: userIdToBytes(user.id),
      userName: user.username || user.email || user.id,
      userDisplayName: user.nickname || user.username || user.email || 'User',
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'required',
        userVerification: 'preferred',
      },
      excludeCredentials: existing.map((row) => ({
        id: row.credentialId,
        transports: parseTransports(row.transports),
      })),
    });

    await this.storeChallenge(options.challenge, 'registration', user.id);
    return options;
  }

  async verifyRegistration(
    user: User,
    response: RegistrationResponseJSON,
    name?: string | null,
    userAgent?: string | null,
  ): Promise<PasskeyListItem> {
    const count = await PasskeyCredential.count({ where: { userId: user.id } });
    if (count >= MAX_PASSKEYS_PER_USER) {
      throw new PasskeyError(
        `You can register at most ${MAX_PASSKEYS_PER_USER} passkeys`,
        400,
        'PASSKEY_LIMIT',
      );
    }

    const clientChallenge =
      typeof response?.response?.clientDataJSON === 'string'
        ? (() => {
            try {
              const json = Buffer.from(response.response.clientDataJSON, 'base64url').toString(
                'utf8',
              );
              return (JSON.parse(json) as { challenge?: string }).challenge || '';
            } catch {
              return '';
            }
          })()
        : '';

    if (!clientChallenge) {
      throw new PasskeyError('Invalid registration response', 400, 'PASSKEY_INVALID');
    }

    await this.consumeChallenge(clientChallenge, 'registration', user.id);

    const verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: clientChallenge,
      expectedOrigin: EXPECTED_ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: false,
    });

    if (!verification.verified || !verification.registrationInfo) {
      throw new PasskeyError('Passkey registration failed', 400, 'PASSKEY_INVALID');
    }

    const { credential, credentialDeviceType, credentialBackedUp } =
      verification.registrationInfo;

    const duplicate = await PasskeyCredential.findOne({
      where: { credentialId: credential.id },
    });
    if (duplicate) {
      throw new PasskeyError('This passkey is already registered', 400, 'PASSKEY_EXISTS');
    }

    const displayName = clampName(
      (typeof name === 'string' && name.trim()) || summarizeUserAgent(userAgent),
    );

    const row = await PasskeyCredential.create({
      userId: user.id,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey),
      signCount: credential.counter,
      transports: serializeTransports(credential.transports),
      deviceType: credentialDeviceType || null,
      backedUp: Boolean(credentialBackedUp),
      name: displayName,
      lastUsedAt: null,
    });

    return {
      id: row.id,
      name: row.name,
      deviceType: row.deviceType,
      backedUp: row.backedUp,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
    };
  }

  async authenticationOptions(allowUserId?: string) {
    let allowCredentials:
      | { id: string; transports?: AuthenticatorTransportFuture[] }[]
      | undefined;

    if (allowUserId) {
      const rows = await PasskeyCredential.findAll({
        where: { userId: allowUserId },
        attributes: ['credentialId', 'transports'],
      });
      allowCredentials = rows.map((row) => ({
        id: row.credentialId,
        transports: parseTransports(row.transports),
      }));
    }

    const options = await generateAuthenticationOptions({
      rpID: RP_ID,
      allowCredentials,
      userVerification: allowUserId ? 'preferred' : 'required',
    });

    await this.storeChallenge(
      options.challenge,
      'authentication',
      allowUserId ?? null,
    );
    return options;
  }

  async verifyAuthentication(
    response: AuthenticationResponseJSON,
    opts: {
      requireUserId?: string;
      /** First-factor usernameless login requires UV; MFA tier does not. */
      requireUserVerification?: boolean;
    } = {},
  ): Promise<{ user: User; credential: PasskeyCredential }> {
    const credentialId = response?.id;
    if (!credentialId || typeof credentialId !== 'string') {
      throw new PasskeyError('Unknown passkey', 404, 'PASSKEY_UNKNOWN');
    }

    const row = await PasskeyCredential.findOne({ where: { credentialId } });
    if (!row) {
      throw new PasskeyError('Unknown passkey', 404, 'PASSKEY_UNKNOWN');
    }

    if (opts.requireUserId && row.userId !== opts.requireUserId) {
      throw new PasskeyError('Passkey does not belong to this login', 400, 'PASSKEY_USER_MISMATCH');
    }

    const clientChallenge =
      typeof response?.response?.clientDataJSON === 'string'
        ? (() => {
            try {
              const json = Buffer.from(response.response.clientDataJSON, 'base64url').toString(
                'utf8',
              );
              return (JSON.parse(json) as { challenge?: string }).challenge || '';
            } catch {
              return '';
            }
          })()
        : '';

    if (!clientChallenge) {
      throw new PasskeyError('Invalid authentication response', 400, 'PASSKEY_INVALID');
    }

    await this.consumeChallenge(
      clientChallenge,
      'authentication',
      opts.requireUserId ?? row.userId,
    );

    const publicKeyBytes =
      row.publicKey instanceof Buffer
        ? new Uint8Array(row.publicKey)
        : new Uint8Array(Buffer.from(row.publicKey as unknown as ArrayBuffer));

    const verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: clientChallenge,
      expectedOrigin: EXPECTED_ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: opts.requireUserVerification !== false,
      credential: {
        id: row.credentialId,
        publicKey: publicKeyBytes,
        counter: Number(row.signCount) || 0,
        transports: parseTransports(row.transports),
      },
    });

    if (!verification.verified) {
      throw new PasskeyError('Passkey verification failed', 400, 'PASSKEY_INVALID');
    }

    const newCounter = verification.authenticationInfo.newCounter;
    const prev = Number(row.signCount) || 0;
    if (prev > 0 && newCounter > 0 && newCounter <= prev) {
      logger.warn('[Passkey] signCount did not increase (possible clone or synced credential)', {
        credentialId: row.credentialId,
        userId: row.userId,
        prev,
        newCounter,
      });
    }

    await row.update({
      signCount: newCounter,
      lastUsedAt: new Date(),
      backedUp: Boolean(verification.authenticationInfo.credentialBackedUp),
      deviceType:
        verification.authenticationInfo.credentialDeviceType || row.deviceType,
    });

    const user = await User.findByPk(row.userId);
    if (!user) {
      throw new PasskeyError('User not found', 404, 'PASSKEY_UNKNOWN');
    }

    return { user, credential: row };
  }

  async listForUser(userId: string): Promise<PasskeyListItem[]> {
    const rows = await PasskeyCredential.findAll({
      where: { userId },
      order: [['createdAt', 'DESC']],
    });
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      deviceType: row.deviceType,
      backedUp: row.backedUp,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
    }));
  }

  async rename(userId: string, passkeyId: string, name: string): Promise<PasskeyListItem> {
    const row = await PasskeyCredential.findOne({
      where: { id: passkeyId, userId },
    });
    if (!row) {
      throw new PasskeyError('Passkey not found', 404, 'PASSKEY_UNKNOWN');
    }
    const next = clampName(name);
    await row.update({ name: next });
    return {
      id: row.id,
      name: row.name,
      deviceType: row.deviceType,
      backedUp: row.backedUp,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
    };
  }

  async remove(userId: string, passkeyId: string): Promise<{ name: string }> {
    const row = await PasskeyCredential.findOne({
      where: { id: passkeyId, userId },
    });
    if (!row) {
      throw new PasskeyError('Passkey not found', 404, 'PASSKEY_UNKNOWN');
    }
    const name = row.name;
    await row.destroy();
    return { name };
  }

  async userHasPasskeys(userId: string): Promise<boolean> {
    const count = await PasskeyCredential.count({ where: { userId } });
    return count > 0;
  }
}

export const passkeyService = new PasskeyService();
