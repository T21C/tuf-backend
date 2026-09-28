export function validateFeelingRating(value: string): boolean {
  const number = '(?:[1-9]|1[0-9]|20)';
  const pgu = `[PGUpgu]${number}`;
  const legacy = '(?:[1-9]|1[0-7]|1[8-9]\\+?|20(?:\\.[0-9])?\\+?|21(?:\\.[0-4])?\\+?)';
  const q = '[qQ][2-4]\\+?';
  const regex = new RegExp(
    `^(?:${pgu}(?:[-~](?:${pgu}|${number}))?|${legacy}(?:[-~]${legacy})?|${q}(?:[-~]${q})?|-2|-21|Marathon|MA|Impossible|Censored|P0)?$`,
  );
  return regex.test(value);
}
