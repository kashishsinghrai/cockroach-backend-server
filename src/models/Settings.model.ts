import mongoose, { Schema, Document, Model } from 'mongoose';

export interface ISettings extends Document {
  isScreenProtectorEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const SettingsSchema = new Schema<ISettings>(
  {
    isScreenProtectorEnabled: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export const Settings = mongoose.model<ISettings, Model<ISettings>>('Settings', SettingsSchema);
