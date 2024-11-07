import mongoose from 'mongoose';

const submissionSchema = new mongoose.Schema(
  {
    speedTrial: {
      type: Boolean,
      required: true,
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
      earlyDouble: {type: Number, default: 0}, // Early!!
      earlySingle: {type: Number, default: 0}, // Early!
      ePerfect: {type: Number, default: 0}, // EPerfect!
      perfect: {type: Number, default: 0}, // Perfect!
      lPerfect: {type: Number, default: 0}, // LPerfect!
      lateSingle: {type: Number, default: 0}, // Late!
      lateDouble: {type: Number, default: 0}, // Late!!
    },
    flags: {
      is12k: {type: Boolean, default: false},
      isNHT: {type: Boolean, default: false},
      is16k: {type: Boolean, default: false},
      isLegacy: {type: Boolean, default: false},
    },
    submitter: {
      discordUsername: {type: String},
      email: {type: String},
    },
  },
  {
    timestamps: true, // Adds createdAt and updatedAt fields automatically
  },
);

// Add any indexes you might need
submissionSchema.index({passer: 1});
submissionSchema.index({rawVideoId: 1});

const PassSubmission = mongoose.model('PassSubmission', submissionSchema);

export default PassSubmission;
