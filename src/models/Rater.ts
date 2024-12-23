import { Schema, model } from 'mongoose';

interface IRater {
  discordId: string;
  name: string;
  discordAvatar?: string;
  isSuperAdmin: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const raterSchema = new Schema<IRater>(
  {
    discordId: {
      type: String,
      required: true,
      unique: true,
    },
    name: {
      type: String,
      required: true,
    },
    discordAvatar: String,
    isSuperAdmin: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

const Rater = model<IRater>('Rater', raterSchema);

export { Rater, IRater }; 