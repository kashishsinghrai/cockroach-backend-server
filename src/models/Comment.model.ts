import mongoose, { Document, Schema } from 'mongoose';

export interface IComment extends Document {
  post: mongoose.Types.ObjectId;
  author: mongoose.Types.ObjectId;
  content: string;
  createdAt: Date;
}

const CommentSchema: Schema = new Schema(
  {
    post: { type: Schema.Types.ObjectId, ref: 'Post', required: true },
    author: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    content: { type: String, required: true, maxlength: 280 },
  },
  { timestamps: true }
);

// Architectural Rationale:
// We index by `post` to quickly retrieve all comments for a single Post Detail Screen,
// and sort them by `createdAt` to show the newest or oldest first.
CommentSchema.index({ post: 1, createdAt: -1 });

export default mongoose.model<IComment>('Comment', CommentSchema);
