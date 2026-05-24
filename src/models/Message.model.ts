import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IMessage extends Document {
  senderId: mongoose.Types.ObjectId;
  receiverId: mongoose.Types.ObjectId;
  text: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date; // For auto-deletion 2 hours after going offline
}

const MessageSchema = new Schema<IMessage>(
  {
    senderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    receiverId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    text: { type: String, required: true, trim: true, maxlength: 2000 },
    expiresAt: { type: Date, default: null }, // Null means it stays until set
  },
  { timestamps: true }
);

// TTL index: MongoDB will automatically delete documents when the `expiresAt` timestamp is reached.
// If expiresAt is null or missing, the document is NOT deleted.
MessageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Indexes for fast history querying
MessageSchema.index({ senderId: 1, receiverId: 1, createdAt: 1 });

const Message = mongoose.model<IMessage, Model<IMessage>>('Message', MessageSchema);
export default Message;
