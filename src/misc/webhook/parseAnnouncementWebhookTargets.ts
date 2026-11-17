export type AnnouncementWebhookTarget = {
  webhookUrl: string;
  ping?: string;
};

export type AnnouncementWebhookCountMismatch = {
  webhookCount: number;
  roleIdCount: number;
};

export type AnnouncementWebhookParseResult = {
  targets: AnnouncementWebhookTarget[];
  mismatch: AnnouncementWebhookCountMismatch | null;
};

/**
 * Pair comma-separated Discord webhook URLs with ping role ids by position.
 * Blank webhook entries are removed before pairing. Blank role entries stay,
 * and a blank role posts that webhook with no ping. Extra roles are dropped.
 * Missing roles are treated as no ping.
 */
export function parseAnnouncementWebhookTargets(
  hooksRaw: string,
  roleIdsRaw: string,
): AnnouncementWebhookParseResult {
  const webhookUrls = hooksRaw
    .split(',')
    .map((url) => url.trim())
    .filter((url) => url.length > 0);

  let pingRoleIds = roleIdsRaw.split(',').map((id) => id.trim());

  if (webhookUrls.length === 0) {
    return {targets: [], mismatch: null};
  }

  let mismatch: AnnouncementWebhookCountMismatch | null = null;
  if (pingRoleIds.length !== webhookUrls.length) {
    mismatch = {
      webhookCount: webhookUrls.length,
      roleIdCount: pingRoleIds.length,
    };
    while (pingRoleIds.length < webhookUrls.length) {
      pingRoleIds.push('');
    }
    if (pingRoleIds.length > webhookUrls.length) {
      pingRoleIds = pingRoleIds.slice(0, webhookUrls.length);
    }
  }

  return {
    mismatch,
    targets: webhookUrls.map((webhookUrl, index) => {
      const pingRoleId = pingRoleIds[index];
      return {
        webhookUrl,
        ping: pingRoleId ? `<@&${pingRoleId}>` : undefined,
      };
    }),
  };
}

export function requireAnnouncementWebhookTargets(
  hooksRaw: string,
  roleIdsRaw: string,
  missingMessage: string,
  onMismatch?: (info: AnnouncementWebhookCountMismatch) => void,
): AnnouncementWebhookTarget[] {
  const parsed = parseAnnouncementWebhookTargets(hooksRaw, roleIdsRaw);
  if (parsed.targets.length === 0) {
    throw new Error(missingMessage);
  }
  if (parsed.mismatch) {
    onMismatch?.(parsed.mismatch);
  }
  return parsed.targets;
}
