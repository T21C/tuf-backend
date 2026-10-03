/**
 * Multer 2 only applies these when they are present. This app's multipart
 * fields are flat names, so a shallow cap closes the nested-name and oversized
 * array-index denial-of-service issues without rejecting real uploads.
 */
const FIELD_NAME_LIMITS = {
  fieldNestingDepth: 5,
  fieldArrayIndexLimit: 100,
} as const;

export function multipartFieldLimits<T extends Record<string, number>>(limits: T) {
  return {...limits, ...FIELD_NAME_LIMITS};
}
