import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getDisplayBioText,
  toLapsedPlainBio,
  toPlainText,
  type BioCanvasBlock,
  type BioCanvasDocument,
} from './schema.js';
import {createDefaultLayout} from './layout.js';
import {textBlockDescriptor} from './blocks/text.js';
import {linkBlockDescriptor} from './blocks/link.js';
import {socialBlockDescriptor} from './blocks/social.js';
import {embedBlockDescriptor} from './blocks/embed.js';
import {featuredLevelsBlockDescriptor} from './blocks/featuredLevels.js';

function block(type: string, data: Record<string, unknown>, descriptor: {createDefault?: () => Record<string, unknown>; defaultSize?: {w: number; h: number}}): BioCanvasBlock {
  return {
    id: `stock-${type}`,
    type: type as BioCanvasBlock['type'],
    layout: createDefaultLayout(descriptor as never),
    data,
  };
}

function canvas(blocks: BioCanvasBlock[]): BioCanvasDocument {
  return {version: 1, blocks};
}

test('toLapsedPlainBio keeps text, link, and social and skips premium widgets', () => {
  const doc = canvas([
    block('text', {heading: 'Hello', body: 'World'}, textBlockDescriptor),
    block('embed', {url: 'https://www.youtube.com/watch?v=vooAfs2IVZA'}, embedBlockDescriptor),
    block(
      'social',
      {links: [{platform: 'youtube', url: 'https://www.youtube.com/c/@V0W4N'}]},
      socialBlockDescriptor,
    ),
    block('featuredLevels', {mode: 'levels', levelIds: [8486, 7623]}, featuredLevelsBlockDescriptor),
    block('link', {label: 'Site', url: 'https://tuforums.com'}, linkBlockDescriptor),
  ]);

  const lapsed = toLapsedPlainBio(doc);
  assert.equal(
    lapsed,
    'Hello\nWorld\n\nyoutube: https://www.youtube.com/c/@V0W4N\n\nSite (https://tuforums.com)',
  );
  assert.equal(lapsed?.includes('[video]'), false);
  assert.equal(lapsed?.includes('[levels'), false);

  const dumped = toPlainText(doc);
  assert.equal(dumped?.includes('[video]'), true);
  assert.equal(dumped?.includes('[levels'), true);
});

test('toLapsedPlainBio is null when canvas is only premium widgets', () => {
  const doc = canvas([
    block('embed', {url: 'https://www.youtube.com/watch?v=vooAfs2IVZA'}, embedBlockDescriptor),
    block('featuredLevels', {mode: 'levels', levelIds: [1]}, featuredLevelsBlockDescriptor),
  ]);
  assert.equal(toLapsedPlainBio(doc), null);
  assert.ok(toPlainText(doc));
});

test('getDisplayBioText uses lapsed canvas text and ignores the stored dump', () => {
  const doc = canvas([
    block('text', {heading: null, body: 'Keep me'}, textBlockDescriptor),
    block('embed', {url: 'https://www.youtube.com/watch?v=vooAfs2IVZA'}, embedBlockDescriptor),
  ]);
  assert.equal(
    getDisplayBioText({
      bio: '[video] https://www.youtube.com/watch?v=vooAfs2IVZA\n\nKeep me',
      bioCanvas: doc,
    }),
    'Keep me',
  );
});

test('getDisplayBioText falls back to bio only when there is no canvas', () => {
  assert.equal(getDisplayBioText({bio: 'Plain bio', bioCanvas: null}), 'Plain bio');
  assert.equal(
    getDisplayBioText({
      bio: '[video] https://example.com',
      bioCanvas: canvas([
        block('embed', {url: 'https://www.youtube.com/watch?v=vooAfs2IVZA'}, embedBlockDescriptor),
      ]),
    }),
    null,
  );
});
