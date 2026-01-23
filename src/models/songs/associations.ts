import Song from './Song.js';
import SongAlias from './SongAlias.js';
import SongLink from './SongLink.js';
import SongEvidence from './SongEvidence.js';
import SongCredit from './SongCredit.js';
import Artist from '../artists/Artist.js';
import Level from '../levels/Level.js';

export function initializeSongsAssociations() {
  // Song <-> SongAlias associations
  Song.hasMany(SongAlias, {
    foreignKey: 'songId',
    as: 'aliases',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  SongAlias.belongsTo(Song, {
    foreignKey: 'songId',
    as: 'song',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  // Song <-> SongLink associations
  Song.hasMany(SongLink, {
    foreignKey: 'songId',
    as: 'links',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  SongLink.belongsTo(Song, {
    foreignKey: 'songId',
    as: 'song',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  // Song <-> SongEvidence associations
  Song.hasMany(SongEvidence, {
    foreignKey: 'songId',
    as: 'evidences',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  SongEvidence.belongsTo(Song, {
    foreignKey: 'songId',
    as: 'song',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  // Song <-> SongCredit associations
  Song.hasMany(SongCredit, {
    foreignKey: 'songId',
    as: 'credits',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  SongCredit.belongsTo(Song, {
    foreignKey: 'songId',
    as: 'song',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  // Song <-> Level associations
  Song.hasMany(Level, {
    foreignKey: 'songId',
    as: 'levels',
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
  });

  Level.belongsTo(Song, {
    foreignKey: 'songId',
    as: 'songObject',
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
  });
}
