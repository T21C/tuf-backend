import mongoose, { Schema, Document } from 'mongoose';
import { IJudgements } from './Judgements';
// Nested interfaces for complex objects


export interface IFlags {
  is12k: boolean;
  isNHT: boolean;
  is16k: boolean;
}

export interface ISubmitter {
  discordUsername: string;
  email: string;
}

// Main interface extending Document
export interface IPassSubmission extends Document {
  levelId: string;
  speed: number;
  passer: string;
  feelingDifficulty: string;
  title: string;
  rawVideoId: string;
  rawTime: Date;
  judgements: IJudgements;
  flags: IFlags;
  submitter: ISubmitter;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

const passSubmissionSchema = new Schema<IPassSubmission>(
  {
    levelId: {
      type: String,
      required: true,
    },
    speed: {
      type: Number,
      default: 1,
    },
    passer: {
      type: String,
      required: true,
    },
    feelingDifficulty: {
      type: String,
      required: true,
    },
    title: {
      type: String,
      required: true,
    },
    rawVideoId: {
      type: String,
      required: true,
    },
    rawTime: {
      type: Date,
      required: true,
    },
    judgements: {
      earlyDouble: { type: Number, default: 0 },
      earlySingle: { type: Number, default: 0 },
      ePerfect: { type: Number, default: 0 },
      perfect: { type: Number, default: 0 },
      lPerfect: { type: Number, default: 0 },
      lateSingle: { type: Number, default: 0 },
      lateDouble: { type: Number, default: 0 },
    },
    flags: {
      is12k: { type: Boolean, default: false },
      isNHT: { type: Boolean, default: false },
      is16k: { type: Boolean, default: false },
      isLegacy: { type: Boolean, default: false },
    },

    status: {
      type: String,
      enum: ['pending', 'approved', 'declined'],
      default: 'pending'
    },
    submitter: {
      discordUsername: { type: String },
      email: { type: String },
    },
  },
  {
    timestamps: true, // Adds createdAt and updatedAt fields automatically
  },
);

// Add any indexes you might need
passSubmissionSchema.index({passer: 1});
passSubmissionSchema.index({rawVideoId: 1});

const PassSubmission = mongoose.model<IPassSubmission>('PassSubmission', passSubmissionSchema);

export default PassSubmission;
