import mongoose from 'mongoose';

const rerateSubmissionSchema = new mongoose.Schema(
  {
    levelId: {
      // 'F' column, representing level ID
      type: String,
      required: true,
    },
    song: {
      type: String,
      required: true,
    },
    artists: {
      type: String,
      required: true,
    },
    creators: {
      type: String,
      required: true,
    },
    videoLink: {
      type: String,
      required: true,
    },
    downloadLink: {
      type: String,
      required: true,
    },
    originalDiff: {
      type: String,
      required: true,
    },
    isLowDiff: {
      type: Boolean,
      default: false,
    },
    rerateValue: {
      type: Number,
      required: true,
    },
    requesterFR: {
      type: String,
      required: true,
    },
    average: {
      type: Number,
      required: true,
    },
    comments: {
      type: String,
      default: '',
    },
  },
  {
    timestamps: true,
  },
);

// Add indexes for common queries
rerateSubmissionSchema.index({levelId: 1});
rerateSubmissionSchema.index({song: 1});
rerateSubmissionSchema.index({artists: 1});
rerateSubmissionSchema.index({creators: 1});
rerateSubmissionSchema.index({requesterFR: 1});

const RerateSubmission = mongoose.model(
  'RerateSubmission',
  rerateSubmissionSchema,
);

export default RerateSubmission;
