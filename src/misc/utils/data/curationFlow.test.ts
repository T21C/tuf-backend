import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assignCurationFlow,
  curationAnnouncementKind,
  curationFieldsForLevelIndex,
  curationFlowForRequestType,
  isCurationDiscordVoteCard,
  curationDiscordVoteWhereSql,
  parseCurationFlow,
} from './curationFlow.js';
import {reasonWithRequester} from './levelRequestValidation.js';

test('parseCurationFlow accepts the three stored flows', () => {
  assert.equal(parseCurationFlow('recent'), 'recent');
  assert.equal(parseCurationFlow('RERATE'), 'rerate');
  assert.equal(parseCurationFlow(' bulk '), 'bulk');
  assert.equal(parseCurationFlow('vote'), null);
});

test('assignCurationFlow prefers bulk, then published types, then recent', () => {
  assert.equal(assignCurationFlow({bulk: true, hasPublishedCuration: true}), 'bulk');
  assert.equal(assignCurationFlow({hasPublishedCuration: true}), 'rerate');
  assert.equal(assignCurationFlow({}), 'recent');
  assert.equal(assignCurationFlow({bulk: true, explicit: 'recent'}), 'recent');
});

test('curationFlowForRequestType maps accept onto Recent or Rerates', () => {
  assert.equal(curationFlowForRequestType('curation'), 'recent');
  assert.equal(curationFlowForRequestType('curation_rerate'), 'rerate');
  assert.equal(curationFlowForRequestType('rerate'), null);
});

test('accept of a curation request opens Recent and copies the requester onto the reason', () => {
  assert.equal(curationFlowForRequestType('curation'), 'recent');
  assert.equal(
    reasonWithRequester('please curate', 'alice'),
    'please curate\nRequested by @alice',
  );
});

test('accept of a curation rerate request opens Rerates with the requester line', () => {
  assert.equal(curationFlowForRequestType('curation_rerate'), 'rerate');
  assert.equal(
    reasonWithRequester('old C1', 'bob'),
    'old C1\nRequested by @bob',
  );
});

test('curationAnnouncementKind posts recent and bulk together', () => {
  assert.equal(curationAnnouncementKind('recent'), 'NEW');
  assert.equal(curationAnnouncementKind('bulk'), 'NEW');
  assert.equal(curationAnnouncementKind('rerate'), 'RERATE');
});

test('isCurationDiscordVoteCard follows an open thread or a vote prefix', () => {
  assert.equal(isCurationDiscordVoteCard({discordMessageUrl: 'https://discord.com/channels/1/2/3'}), true);
  assert.equal(isCurationDiscordVoteCard({
    discordMessageUrl: 'https://discord.com/channels/1/2/3',
    discordThreadClosed: true,
  }), false);
  assert.equal(isCurationDiscordVoteCard({discordMessageUrl: ''}), false);
  assert.equal(isCurationDiscordVoteCard({discordMessageUrl: '   '}), false);
  assert.equal(isCurationDiscordVoteCard({curationRerateNum: 'vote C1'}), true);
  assert.equal(isCurationDiscordVoteCard({curationRerateNum: 'C1'}), false);
});

test('curationDiscordVoteWhereSql negates the vote predicate for exclude', () => {
  const only = curationDiscordVoteWhereSql('only');
  const exclude = curationDiscordVoteWhereSql('exclude');
  assert.equal(exclude.startsWith('NOT '), true);
  assert.equal(only.startsWith('NOT '), false);
  assert.equal(exclude.endsWith(only), true);
  assert.match(only, /NULLIF\(TRIM\(CurationRating\.discordMessageUrl\), ''\) IS NOT NULL/);
  assert.match(only, /curationRerateNum/);
});

test('curationFieldsForLevelIndex writes boolean toCuration and a known flow', () => {
  assert.deepEqual(
    curationFieldsForLevelIndex({
      toCuration: true,
      curationFlow: 'BULK',
      curationRerateNum: 'vote C1',
      curationRerateReason: 'please look',
    }),
    {
      toCuration: true,
      curationFlow: 'bulk',
      curationRerateNum: 'vote C1',
      curationRerateReason: 'please look',
    },
  );
  assert.deepEqual(
    curationFieldsForLevelIndex({toCuration: 1, curationFlow: 'vote'}),
    {
      toCuration: false,
      curationFlow: null,
      curationRerateNum: null,
      curationRerateReason: null,
    },
  );
});
