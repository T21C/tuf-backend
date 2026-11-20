export type IdentityMode = 'level' | 'chartSubgroup' | 'vfxSubgroup' | 'group';

export type LinkInfo = {
  groupId: number | null;
  chartSubgroup: number | null;
  vfxSubgroup: number | null;
};

/** A clear always keeps its own chart. Siblings only share an identity key. */
export function identityKey(mode: IdentityMode, levelId: number, link: LinkInfo | null | undefined): string {
  if (!link || link.groupId == null || mode === 'level') return `L:${levelId}`;
  if (mode === 'group') return `G:${link.groupId}`;
  if (mode === 'chartSubgroup') {
    if (link.chartSubgroup == null) return `L:${levelId}`;
    return `C:${link.groupId}:${link.chartSubgroup}`;
  }
  if (link.vfxSubgroup == null) return `L:${levelId}`;
  return `V:${link.groupId}:${link.vfxSubgroup}`;
}

export function difficultyFamily(name: string | null | undefined): string {
  const token = String(name || '').trim().split(/[\s(]/)[0].toUpperCase();
  if (!token) return 'ETC';
  if (token.startsWith('GQ')) return 'GQ';
  if (token.startsWith('UQ')) return 'UQ';
  if (token === 'QQ' || /^Q[0-4]$/.test(token)) return 'QQ';
  if (/^P\d+$/.test(token)) return 'P';
  if (/^G\d+$/.test(token)) return 'G';
  if (/^U\d+$/.test(token)) return 'U';
  return 'ETC';
}

export function difficultyNumber(name: string | null | undefined): number | null {
  const token = String(name || '').trim().split(/[\s(]/)[0].toUpperCase();
  const match = token.match(/^(?:P|G|U|GQ|UQ)(\d+)$/);
  if (!match) return null;
  return Number(match[1]);
}
