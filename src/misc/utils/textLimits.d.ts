export const LARGE_TEXT_MAX: number;
export const DISCORD_DESCRIPTION_MAX: number;

export type LargeTextOk = {ok: true; value: string};
export type LargeTextErr = {ok: false; code: string; message: string; max: number};
export type LargeTextResult = LargeTextOk | LargeTextErr;

export function parseLargeText(
  raw: unknown,
  options?: {required?: boolean; label?: string},
): LargeTextResult;

export function clipDiscordDescription(text: unknown): string;
