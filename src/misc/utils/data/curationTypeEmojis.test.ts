import assert from 'node:assert/strict';
import test from 'node:test';
import {curationTypeEmojiMarkup} from './curationTypeEmojis.js';

const MARKUPS: Record<string, string> = {
  C0: '<:TUF75_C0:1490733220302422217>',
  C1: '<:TUF76_C1:1490733260991365192>',
  C2: '<:TUF76_C2:1490733306663276675>',
  C3: '<a:TUF76_C3_animated:1490733584485711942>',
  V0: '<:TUF77_V0:1490733980138340493>',
  V1: '<:TUF78_V1:1490734009930747995>',
  V2: '<:TUF78_V2:1490734042172231750>',
  V3: '<a:TUF78_V3_Animated:1467362762295476224>',
  O1: '<:TUF79_O1:1490734084358672566>',
  O2: '<:TUF79_O2:1490734130504270034>',
  O3: '<a:TUF80_O3_animated:1502606163202805921>',
  Epic: '<:TUF83_Epic:1466779187523096776>',
  H1: '<:TUF81_H1:1467362689541079151>',
  H2: '<:TUF82_H2:1467362724081303776>',
};

test('curationTypeEmojiMarkup maps each short type name to Discord markup', () => {
  for (const [name, markup] of Object.entries(MARKUPS)) {
    assert.equal(curationTypeEmojiMarkup(name), markup);
    assert.equal(curationTypeEmojiMarkup(name.toLowerCase()), markup);
  }
});

test('curationTypeEmojiMarkup leaves unknown names empty', () => {
  assert.equal(curationTypeEmojiMarkup('Legendary'), undefined);
  assert.equal(curationTypeEmojiMarkup(''), undefined);
  assert.equal(curationTypeEmojiMarkup(null), undefined);
});
