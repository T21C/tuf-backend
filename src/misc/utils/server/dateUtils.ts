import { logger } from '../../../server/services/LoggerService.js';

// Define reasonable date bounds (TUF website context)
const MIN_VALID_DATE = new Date('2020-01-01'); // Earliest reasonable date
const MAX_VALID_DATE = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // One year in the future
/**
 * Validates and clamps a date to reasonable bounds
 * @param dateString - The date string to validate
 * @param defaultDate - The default date to use if validation fails
 * @returns A valid Date object within reasonable bounds
 */
export function validateAndClampDate(dateString: string, defaultDate: Date): Date {
  let parsedDate = new Date(dateString);

  // Check if date is invalid
  if (isNaN(parsedDate.getTime())) {
    logger.debug(`Invalid date string provided: ${dateString}, using default`);
    return defaultDate;
  }
  // Check if year is unreasonably far in past or future
  const year = parsedDate.getFullYear();
  if (year < 1000 || year > 9999) {
    logger.debug(`Date with invalid year (${year}) provided: ${dateString}, using default`);
    return defaultDate;
  }
  // Clamp to minimum valid date
  if (parsedDate < MIN_VALID_DATE) {
    logger.debug(`Date ${dateString} is before minimum valid date, clamping to ${MIN_VALID_DATE.toISOString()}`);
    parsedDate = new Date(MIN_VALID_DATE);
  }
  // Clamp to maximum valid date
  if (parsedDate > MAX_VALID_DATE) {
    logger.debug(`Date ${dateString} is after maximum valid date, clamping to ${MAX_VALID_DATE.toISOString()}`);
    parsedDate = new Date(MAX_VALID_DATE);
  }
  return parsedDate;
}
