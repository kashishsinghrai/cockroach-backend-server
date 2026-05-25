import mongoose, { Document, Schema } from 'mongoose';

export enum NotificationType {
  FOLLOW = 'follow',
  LIKE = 'like',
  COMMENT = 'comment',
  MESSAGE = 'message',
}

export interface INotification extends Document {
  recipient: mongoose.Types.ObjectId;  // who receives it
  actor: mongoose.Types.ObjectId;       // who triggered it
  type: NotificationType;
  post?: mongoose.Types.ObjectId;       // relevant post (like/comment)
  read: boolean;
  createdAt: Date;
}

const NotificationSchema = new Schema<INotification>(
  {
    recipient: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    actor: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: Object.values(NotificationType), required: true },
    post: { type: Schema.Types.ObjectId, ref: 'Post' },
    read: { type: Boolean, default: false },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Architectural Rationale:
// Notifications are heavily read (polled for unread count and fetched on tab open).
// We index on `recipient` and `createdAt` (descending) to optimize the `Notification.find({ recipient: userId }).sort({ createdAt: -1 })` query.
NotificationSchema.index({ recipient: 1, createdAt: -1 });

export default mongoose.model<INotification>('Notification', NotificationSchema);
