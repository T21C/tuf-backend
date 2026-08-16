import {z} from 'zod';

export const NOTIFICATION_TYPES = {
  PassSubmissionSubmitted: 'pass.submission.submitted',
  PassSubmissionApproved: 'pass.submission.approved',
  PassSubmissionDeclined: 'pass.submission.declined',
  PassModified: 'pass.modified',
  PassDeleted: 'pass.deleted',
  ChartSubmissionSubmitted: 'chart.submission.submitted',
  ChartSubmissionApproved: 'chart.submission.approved',
  ChartSubmissionDeclined: 'chart.submission.declined',
  ChartDeleted: 'chart.deleted',
  ChartVisibilityChanged: 'chart.visibility.changed',
  ChartModified: 'chart.modified',
  ChartCurated: 'chart.curated',
  ChartCurationRemoved: 'chart.curation.removed',
  ChartWeeklySelected: 'chart.weekly.selected',
} as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[keyof typeof NOTIFICATION_TYPES];

export const NOTIFICATION_CATEGORIES = ['submissions', 'chart', 'clears'] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export type NotificationChannel = 'inApp' | 'email' | 'discord';

export const chartSnapshotPayloadSchema = z.object({
  levelId: z.number().int().positive(),
  song: z.string().nullable(),
  artist: z.string().nullable(),
});

export type ChartSnapshotPayload = z.infer<typeof chartSnapshotPayloadSchema>;

export const passSubmissionPayloadSchema = chartSnapshotPayloadSchema.extend({
  submissionId: z.number().int().positive(),
  passId: z.number().int().positive().nullable(),
});

export type PassSubmissionPayload = z.infer<typeof passSubmissionPayloadSchema>;

export const passLifecyclePayloadSchema = chartSnapshotPayloadSchema.extend({
  passId: z.number().int().positive(),
});

export type PassLifecyclePayload = z.infer<typeof passLifecyclePayloadSchema>;

export const chartSubmissionPayloadSchema = z.object({
  submissionId: z.number().int().positive(),
  levelId: z.number().int().positive().nullable(),
  song: z.string().nullable(),
  artist: z.string().nullable(),
});

export type ChartSubmissionPayload = z.infer<typeof chartSubmissionPayloadSchema>;

export const chartVisibilityPayloadSchema = chartSnapshotPayloadSchema.extend({
  isHidden: z.boolean(),
});

export type ChartVisibilityPayload = z.infer<typeof chartVisibilityPayloadSchema>;

export const chartWeeklyPayloadSchema = chartSnapshotPayloadSchema.extend({
  weekStart: z.string(),
});

export type ChartWeeklyPayload = z.infer<typeof chartWeeklyPayloadSchema>;

export type NotificationPayloadByType = {
  [NOTIFICATION_TYPES.PassSubmissionSubmitted]: PassSubmissionPayload;
  [NOTIFICATION_TYPES.PassSubmissionApproved]: PassSubmissionPayload;
  [NOTIFICATION_TYPES.PassSubmissionDeclined]: PassSubmissionPayload;
  [NOTIFICATION_TYPES.PassModified]: PassLifecyclePayload;
  [NOTIFICATION_TYPES.PassDeleted]: PassLifecyclePayload;
  [NOTIFICATION_TYPES.ChartSubmissionSubmitted]: ChartSubmissionPayload;
  [NOTIFICATION_TYPES.ChartSubmissionApproved]: ChartSubmissionPayload;
  [NOTIFICATION_TYPES.ChartSubmissionDeclined]: ChartSubmissionPayload;
  [NOTIFICATION_TYPES.ChartDeleted]: ChartSnapshotPayload;
  [NOTIFICATION_TYPES.ChartVisibilityChanged]: ChartVisibilityPayload;
  [NOTIFICATION_TYPES.ChartModified]: ChartSnapshotPayload;
  [NOTIFICATION_TYPES.ChartCurated]: ChartSnapshotPayload;
  [NOTIFICATION_TYPES.ChartCurationRemoved]: ChartSnapshotPayload;
  [NOTIFICATION_TYPES.ChartWeeklySelected]: ChartWeeklyPayload;
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

function chartSubmissionHref(payload: ChartSubmissionPayload): string | null {
  if (payload.levelId) return `/levels/${payload.levelId}`;
  return null;
}

function levelHref(payload: {levelId: number}): string {
  return `/levels/${payload.levelId}`;
}

function passOrLevelHref(payload: {passId?: number | null; levelId: number}): string {
  if (payload.passId) return `/passes/${payload.passId}`;
  return levelHref(payload);
}

function def<K extends NotificationType>(
  id: K,
  category: NotificationCategory,
  payload: z.ZodType<NotificationPayloadByType[K]>,
  href: (payload: NotificationPayloadByType[K]) => string | null,
): NotificationTypeDefinition<K> {
  return {
    id,
    category,
    payload,
    defaults: DEFAULT_CHANNELS,
    lockedChannels: {},
    i18nKey: `notifications.types.${id}`,
    href,
  };
}

const notificationTypeRegistry: {
  [K in NotificationType]: NotificationTypeDefinition<K>;
} = {
  [NOTIFICATION_TYPES.PassSubmissionSubmitted]: def(
    NOTIFICATION_TYPES.PassSubmissionSubmitted,
    'submissions',
    passSubmissionPayloadSchema,
    passOrLevelHref,
  ),
  [NOTIFICATION_TYPES.PassSubmissionApproved]: def(
    NOTIFICATION_TYPES.PassSubmissionApproved,
    'submissions',
    passSubmissionPayloadSchema,
    passOrLevelHref,
  ),
  [NOTIFICATION_TYPES.PassSubmissionDeclined]: def(
    NOTIFICATION_TYPES.PassSubmissionDeclined,
    'submissions',
    passSubmissionPayloadSchema,
    passOrLevelHref,
  ),
  [NOTIFICATION_TYPES.PassModified]: def(
    NOTIFICATION_TYPES.PassModified,
    'clears',
    passLifecyclePayloadSchema,
    (payload) => `/passes/${payload.passId}`,
  ),
  [NOTIFICATION_TYPES.PassDeleted]: def(
    NOTIFICATION_TYPES.PassDeleted,
    'clears',
    passLifecyclePayloadSchema,
    (payload) => `/passes/${payload.passId}`,
  ),
  [NOTIFICATION_TYPES.ChartSubmissionSubmitted]: def(
    NOTIFICATION_TYPES.ChartSubmissionSubmitted,
    'submissions',
    chartSubmissionPayloadSchema,
    chartSubmissionHref,
  ),
  [NOTIFICATION_TYPES.ChartSubmissionApproved]: def(
    NOTIFICATION_TYPES.ChartSubmissionApproved,
    'submissions',
    chartSubmissionPayloadSchema,
    chartSubmissionHref,
  ),
  [NOTIFICATION_TYPES.ChartSubmissionDeclined]: def(
    NOTIFICATION_TYPES.ChartSubmissionDeclined,
    'submissions',
    chartSubmissionPayloadSchema,
    chartSubmissionHref,
  ),
  [NOTIFICATION_TYPES.ChartDeleted]: def(
    NOTIFICATION_TYPES.ChartDeleted,
    'chart',
    chartSnapshotPayloadSchema,
    levelHref,
  ),
  [NOTIFICATION_TYPES.ChartVisibilityChanged]: def(
    NOTIFICATION_TYPES.ChartVisibilityChanged,
    'chart',
    chartVisibilityPayloadSchema,
    levelHref,
  ),
  [NOTIFICATION_TYPES.ChartModified]: def(
    NOTIFICATION_TYPES.ChartModified,
    'chart',
    chartSnapshotPayloadSchema,
    levelHref,
  ),
  [NOTIFICATION_TYPES.ChartCurated]: def(
    NOTIFICATION_TYPES.ChartCurated,
    'chart',
    chartSnapshotPayloadSchema,
    levelHref,
  ),
  [NOTIFICATION_TYPES.ChartCurationRemoved]: def(
    NOTIFICATION_TYPES.ChartCurationRemoved,
    'chart',
    chartSnapshotPayloadSchema,
    levelHref,
  ),
  [NOTIFICATION_TYPES.ChartWeeklySelected]: def(
    NOTIFICATION_TYPES.ChartWeeklySelected,
    'chart',
    chartWeeklyPayloadSchema,
    levelHref,
  ),
};

export function isNotificationType(value: string): value is NotificationType {
  return Object.values(NOTIFICATION_TYPES).includes(value as NotificationType);
}

export function isNotificationCategory(value: string): value is NotificationCategory {
  return (NOTIFICATION_CATEGORIES as readonly string[]).includes(value);
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

export function listNotificationCategories(): NotificationCategory[] {
  return [...NOTIFICATION_CATEGORIES];
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
