/**
 * Best-effort terminal / tab title for long-running Node services.
 * - `process.title`: task manager, ps, some hosts (incl. Windows console).
 * - OSC 0 sequence on stdout when TTY: Windows Terminal, most Linux terminals, etc.
 * tmux/IDE terminals may still override depending on `allow-rename` / settings.
 */
export function setTerminalServiceTitle(displayName: string): void {
  const raw = displayName.trim() || 'node';
  const title = raw.length > 200 ? `${raw.slice(0, 197)}...` : raw;
  try {
    process.title = title;
  } catch {
    /* ignore */
  }
  if (process.stdout.isTTY) {
    try {
      const safe = title.replace(/\x07/g, '').replace(/\x1b/g, '');
      process.stdout.write(`\x1b]0;${safe}\x07`);
    } catch {
      /* ignore */
    }
  }
}
