import mongoose from 'mongoose';

const ratingSchema = new mongoose.Schema({
  ID: {
    type: Number,
    required: true,
    unique: true
  },
  song: {
    type: String,
    default: "" 
  },
  artist: {
    type: String,
    default: ""
  },
  creator: {
    type: String,
    default: ""
  },
  rawVideoLink: {
    type: String,
    default: ""
  },
  rawDLLink: {
    type: String,
    default: ""
  },
  currentDiff: {
    type: String,
    default: "0"
  },
  lowDiff: {
    type: Boolean,
    default: false
  },
  rerateNum: {
    type: String,
    default: ""
  },
  requesterFR: {
    type: String,
    default: ""
  },
  average: {
    type: String,
    default: "0"
  },
  comments: {
    type: String,
    default: ""
  },
  rerateReason: {
    type: String,
    default: ""
  },
  ratings: {
    type: Object,
    default: {}
  }
}, {
  timestamps: true // Adds createdAt and updatedAt fields 
});

export const Rating = mongoose.model('Rating', ratingSchema, 'ratings'); 