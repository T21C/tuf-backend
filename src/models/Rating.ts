import mongoose from 'mongoose';

const ratingSchema = new mongoose.Schema({
  ID: {
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
  rawVideoLink: {
    type: String,
    required: true
  },
  rawDLLink: {
    type: String,
    required: true
  },
  currentDiff: {
    type: Number,
    default: 0
  },
  lowDiff: {
    type: Number,
    default: 0
  },
  rerateNum: {
    type: Number,
    default: 0
  },
  requesterFR: {
    type: String,
    default: ""
  },
  average: {
    type: Number,
    default: 0
  },
  comments: {
    type: String,
    default: ""
  },
  ratings: {
    type: Object,
    default: {}
  }
});

export const Rating = mongoose.model('Rating', ratingSchema, 'ratings'); 