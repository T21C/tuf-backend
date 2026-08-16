import {z} from 'zod';

export const NOTIFICATION_TYPES = {
  PassSubmissionApproved: 'pass.submission.approved',
  PassSubmissionDeclined: 'pass.submission.declined',
} as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES];

export type NotificationCategory = 'submissions';

export type NotificationChannel = 'inApp' | 'email' | 'discord';

export const passSubmissionPayloadSchema = z.object({
  submissionId: z.number().int().positive(),
  passId: z.number().int().positive().nullable(),
  levelId: z.number().int().positive(),
  song: z.string().nullable(),
  artist: z.string().nullable(),
});

export type PassSubmissionPayload = z.infer<typeof passSubmissionPayloadSchema>;

export type NotificationPayloadByType = {
  [NOTIFICATION_TYPES.PassSubmissionApproved]: PassSubmissionPayload;
  [NOTIFICATION_TYPES.PassSubmissionDeclined]: PassSubmissionPayload;
};

export type NotificationChannelDefaults = Record<NotificationChannel, boolean>;

export type NotificationLockedChannels = Partial<Record<NotificationChannel, boolean>>;

export interface NotificationTypeDefinition<K extends NotificationType = NotificationType> {
  id: K;
  category: NotificationCategory;
  payload: z.ZodType<NotificationPayloadByType[K]>;
  defaults: NotificationChannelDefaults;
  lockedChannels: NotificationLockedChannels;
  i18nKey: string;
  href: (payload: NotificationPayloadByType[K]) => string | null;
}

const DEFAULT_CHANNELS: NotificationChannelDefaults = {
  inApp: true,
  email: false,
  discord: false,
};

function passSubmissionHref(payload: PassSubmissionPayload): string | null {
  if (payload.passId) return `/passes/${payload.passId}`;
  if (payload.levelId) return `/levels/${payload.levelId}`;
  return null;
}

const notificationTypeRegistry: {
  [K in NotificationType]: NotificationTypeDefinition<K>;
} = {
  [NOTIFICATION_TYPES.PassSubmissionApproved]: {
    id: NOTIFICATION_TYPES.PassSubmissionApproved,
    category: 'submissions',
    payload: passSubmissionPayloadSchema,
    defaults: DEFAULT_CHANNELS,
    lockedChannels: {},
    i18nKey: 'notifications.types.pass.submission.approved',
    href: passSubmissionHref,
  },
  [NOTIFICATION_TYPES.PassSubmissionDeclined]: {
    id: NOTIFICATION_TYPES.PassSubmissionDeclined,
    category: 'submissions',
    payload: passSubmissionPayloadSchema,
    defaults: DEFAULT_CHANNELS,
    lockedChannels: {},
    i18nKey: 'notifications.types.pass.submission.declined',
    href: passSubmissionHref,
  },
};

export function isNotificationType(value: string): value is NotificationType {
  return Object.values(NOTIFICATION_TYPES).includes(value as NotificationType);
}

export function getNotificationTypeDefinition<K extends NotificationType>(
  type: K,
): NotificationTypeDefinition<K> {
  return notificationTypeRegistry[type];
}

export function listNotificationTypeDefinitions(): NotificationTypeDefinition[] {
  return Object.values(NOTIFICATION_TYPES).map(
    (type) => notificationTypeRegistry[type] as NotificationTypeDefinition,
  );
}

export function resolveNotificationHref(type: string, payload: unknown): string | null {
  if (!isNotificationType(type)) return null;
  const definition = getNotificationTypeDefinition(type);
  const parsed = definition.payload.safeParse(payload);
  if (!parsed.success) return null;
  return definition.href(parsed.data);
}

export function channelEnabled(
  definition: {
    defaults: NotificationChannelDefaults;
    lockedChannels: NotificationLockedChannels;
  },
  channel: NotificationChannel,
  override: boolean | undefined,
): boolean {
  if (definition.lockedChannels[channel]) {
    return definition.defaults[channel];
  }
  if (typeof override === 'boolean') return override;
  return definition.defaults[channel];
}
