import mongoose, { Schema, Document } from 'mongoose';

// Nested interface for submitter
interface ISubmitter {
  discordUsername: string;
  email: string;
}

// Main interface extending Document
export interface IChartSubmission extends Document {
  artist: string;
  charter: string;
  diff: string;
  song: string;
  team: string;
  vfxer: string;
  videoLink: string;
  directDL: string;
  wsLink: string;
  submitter: ISubmitter;
  status: 'pending' | 'approved' | 'declined';
  toRate: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const chartSubmissionSchema = new Schema<IChartSubmission>(
  {
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
  },
  {
    timestamps: true
  }
);

// Add indexes for common queries
chartSubmissionSchema.index({ charter: 1 });
chartSubmissionSchema.index({ artist: 1 });

export default mongoose.model<IChartSubmission>('ChartSubmission', chartSubmissionSchema);