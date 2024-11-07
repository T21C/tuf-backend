import mongoose from 'mongoose';

const chartSubmissionSchema = new mongoose.Schema({
  artist: {
    type: String,
    required: true
  },
  charter: {
    type: String,
    required: true
  },
  diff: {
    type: String,
    required: true
  },
  song: {
    type: String,
    required: true
  },
  team: {
    type: String,
    default: ''
  },
  vfxer: {
    type: String,
    default: ''
  },
  videoLink: {
    type: String,
    required: true
  },
  directDL: {
    type: String,
    required: true
  },
  wsLink: {
    type: String,
    default: ''
  },
  submitter: {
    discordUsername: { type: String },
    email: { type: String }
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'declined'],
    default: 'pending'
  },
  toRate: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// Add indexes for common queries
chartSubmissionSchema.index({ charter: 1 });
chartSubmissionSchema.index({ artist: 1 });

const ChartSubmission = mongoose.model('ChartSubmission', chartSubmissionSchema);

export default ChartSubmission;
