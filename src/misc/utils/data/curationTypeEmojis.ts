const CURATION_TYPE_EMOJI_MARKUP: Record<string, string> = {
  c0: '<:TUF75_C0:1490733220302422217>',
  c1: '<:TUF76_C1:1490733260991365192>',
  c2: '<:TUF76_C2:1490733306663276675>',
  c3: '<a:TUF76_C3_animated:1490733584485711942>',
  v0: '<:TUF77_V0:1490733980138340493>',
  v1: '<:TUF78_V1:1490734009930747995>',
  v2: '<:TUF78_V2:1490734042172231750>',
  v3: '<a:TUF78_V3_Animated:1467362762295476224>',
  o1: '<:TUF79_O1:1490734084358672566>',
  o2: '<:TUF79_O2:1490734130504270034>',
  o3: '<a:TUF80_O3_animated:1502606163202805921>',
  epic: '<:TUF83_Epic:1466779187523096776>',
  h1: '<:TUF81_H1:1467362689541079151>',
  h2: '<:TUF82_H2:1467362724081303776>',
};

export function curationTypeEmojiMarkup(name: string | null | undefined): string | undefined {
  const key = String(name || '').trim().toLowerCase();
  return key ? CURATION_TYPE_EMOJI_MARKUP[key] : undefined;
}
