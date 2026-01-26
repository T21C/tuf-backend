import Artist from './Artist.js';
import ArtistAlias from './ArtistAlias.js';
import ArtistLink from './ArtistLink.js';
import ArtistEvidence from './ArtistEvidence.js';
import ArtistRelation from './ArtistRelation.js';
import SongCredit from '../songs/SongCredit.js';
import Level from '../levels/Level.js';
import Song from '../songs/Song.js';

export function initializeArtistsAssociations() {
  // Artist <-> ArtistAlias associations
  Artist.hasMany(ArtistAlias, {
    foreignKey: 'artistId',
    as: 'aliases',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  ArtistAlias.belongsTo(Artist, {
    foreignKey: 'artistId',
    as: 'artist',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  // Artist <-> ArtistLink associations
  Artist.hasMany(ArtistLink, {
    foreignKey: 'artistId',
    as: 'links',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  ArtistLink.belongsTo(Artist, {
    foreignKey: 'artistId',
    as: 'artist',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  // Artist <-> ArtistEvidence associations
  Artist.hasMany(ArtistEvidence, {
    foreignKey: 'artistId',
    as: 'evidences',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  ArtistEvidence.belongsTo(Artist, {
    foreignKey: 'artistId',
    as: 'artist',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  // Artist <-> SongCredit associations (many-to-many through songCredits)
  Artist.hasMany(SongCredit, {
    foreignKey: 'artistId',
    as: 'songCredits',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  SongCredit.belongsTo(Artist, {
    foreignKey: 'artistId',
    as: 'artist',
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  });

  // Artist <-> Song associations (many-to-many through songCredits)
  Artist.belongsToMany(Song, {
    through: SongCredit,
    foreignKey: 'artistId',
    otherKey: 'songId',
    as: 'songs',
  });

  Song.belongsToMany(Artist, {
    through: SongCredit,
    foreignKey: 'songId',
    otherKey: 'artistId',
    as: 'artists',
  });

  // Artist <-> Artist associations (many-to-many through ArtistRelation)
  Artist.belongsToMany(Artist, {
    through: ArtistRelation,
    foreignKey: 'artistId1',
    otherKey: 'artistId2',
    as: 'relatedArtists',
  });
}
