import mongoose from 'mongoose';

const ratingSchema = new mongoose.Schema({
  id: {
    type: Number,
    required: true,
    unique: true
  },
  song: {
    type: String,
    required: true
  },
  artist: {
    type: String,
    required: true
  },
  creator: {
    type: String,
    required: true
  },
  charter: {
    type: String,
    required: true
  },
  vfxer: {
    type: String,
    default: ""
  },
  team: {
    type: String,
    default: ""
  },
  diff: {
    type: Number,
    required: true
  },
  legacyDiff: {
    type: Number,
    required: true
  },
  pguDiff: {
    type: String,
    default: ""
  },
  pguDiffNum: {
    type: Number,
    required: true
  },
  newDiff: {
    type: Number,
    default: 0
  },
  pdnDiff: {
    type: Number,
    required: true
  },
  realDiff: {
    type: Number,
    default: 0
  },
  baseScore: {
    type: Number,
    default: 0
  },
  isCleared: {
    type: Boolean,
    default: false
  },
  clears: {
    type: Number,
    default: 0
  },
  vidLink: {
    type: String,
    required: true
  },
  dlLink: {
    type: String,
    required: true
  },
  workshopLink: {
    type: String,
    default: ""
  },
  publicComments: {
    type: String,
    default: ""
  }
});

export const Rating = mongoose.model('Rating', ratingSchema); 