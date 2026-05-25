import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';

import { User } from './models/User.model';
import FollowerGraph from './models/FollowerGraph.model';
import Message from './models/Message.model';
import Notification from './models/Notification.model';

let ioInstance: Server | null = null;

// Map of userId -> Set of socketIds
const connectedUsers = new Map<string, Set<string>>();
// Map of socketId -> userId (for quick reverse lookup on disconnect)
const socketToUser = new Map<string, string>();

export function initializeSocket(httpServer: HttpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: '*', // In production, restrict this to allowed origins
      methods: ['GET', 'POST'],
    },
  });

  ioInstance = io;

  io.on('connection', (socket: Socket) => {
    console.log(`[SOCKET] User connected: ${socket.id}`);

    // --- Authentication & Presence ---
    socket.on('authenticate', (data: { userId: string }) => {
      if (!data || !data.userId) return;
      const userId = data.userId.toString();
      
      socketToUser.set(socket.id, userId);

      if (!connectedUsers.has(userId)) {
        connectedUsers.set(userId, new Set());
        // First time this user connected (from any device), broadcast online status
        io.emit('user_online', { userId });

        // User came online -> cancel auto-delete for their messages
        Message.updateMany(
          { $or: [{ senderId: userId }, { receiverId: userId }] },
          { $unset: { expiresAt: 1 } }
        ).catch(err => console.error('[SOCKET] Failed to clear expiresAt for user', userId, err));
      }
      connectedUsers.get(userId)?.add(socket.id);
      
      console.log(`[SOCKET] User ${userId} authenticated on socket ${socket.id}`);
      
      // Optionally, send them the current list of all online users so they can initialize
      const onlineUserIds = Array.from(connectedUsers.keys());
      socket.emit('initial_presence', { onlineUsers: onlineUserIds });
    });

    // --- Persistent Chat ---
    socket.on('send_message', async (data: { senderId: string; receiverId: string; text: string }) => {
      try {
        const { senderId, receiverId, text } = data;
        if (!senderId || !receiverId || !text) return;

        // Check mutual friends
        const isTargetFollowingCaller = await FollowerGraph.exists({ followerId: receiverId, followingId: senderId });
        const isCallerFollowingTarget = await FollowerGraph.exists({ followerId: senderId, followingId: receiverId });
        
        if (!isTargetFollowingCaller || !isCallerFollowingTarget) {
          emitToUser(senderId, 'message_error', { error: 'You can only message mutual friends.' });
          return;
        }

        // Save to database
        const newMessage = await Message.create({
          senderId,
          receiverId,
          text
        });
        
        const messageJson = newMessage.toJSON();

        // Emit to receiver
        emitToUser(receiverId, 'receive_message', messageJson);
        // Also emit back to sender (useful if they have multiple devices)
        emitToUser(senderId, 'receive_message', messageJson);

        // --- Notification logic ---
        const existingNotif = await Notification.findOne({
          recipient: receiverId,
          actor: senderId,
          type: 'message',
          read: false
        });

        if (!existingNotif) {
          await Notification.create({
            recipient: receiverId,
            actor: senderId,
            type: 'message',
          });
          emitToUser(receiverId, 'new_notification', {});
        }

      } catch (err) {
        console.error('[SOCKET] send_message error:', err);
      }
    });

    socket.on('edit_message', async (data: { messageId: string; newText: string }) => {
      try {
        const { messageId, newText } = data;
        const userId = socketToUser.get(socket.id);
        if (!userId || !messageId || !newText) return;

        const message = await Message.findById(messageId);
        if (!message) return;

        if (message.senderId.toString() !== userId) {
          emitToUser(userId, 'message_error', { error: 'You can only edit your own messages.' });
          return;
        }

        message.text = newText;
        message.isEdited = true;
        await message.save();
        
        const messageJson = message.toJSON();

        const receiverId = message.receiverId.toString();
        emitToUser(receiverId, 'message_edited', messageJson);
        emitToUser(userId, 'message_edited', messageJson);
      } catch (err) {
        console.error('[SOCKET] edit_message error:', err);
      }
    });

    socket.on('delete_message', async (data: { messageId: string }) => {
      try {
        const { messageId } = data;
        const userId = socketToUser.get(socket.id);
        if (!userId || !messageId) return;

        const message = await Message.findById(messageId);
        if (!message) return;

        if (message.senderId.toString() !== userId) {
          emitToUser(userId, 'message_error', { error: 'You can only delete your own messages.' });
          return;
        }

        message.isDeleted = true;
        message.text = ''; // Clear content for privacy
        await message.save();
        
        const messageJson = message.toJSON();

        const receiverId = message.receiverId.toString();
        emitToUser(receiverId, 'message_deleted', messageJson);
        emitToUser(userId, 'message_deleted', messageJson);
      } catch (err) {
        console.error('[SOCKET] delete_message error:', err);
      }
    });

    // --- Disconnect ---
    socket.on('disconnect', () => {
      console.log(`[SOCKET] User disconnected: ${socket.id}`);
      
      const userId = socketToUser.get(socket.id);
      if (userId) {
        socketToUser.delete(socket.id);
        const userSockets = connectedUsers.get(userId);
        if (userSockets) {
          userSockets.delete(socket.id);
          if (userSockets.size === 0) {
            connectedUsers.delete(userId);
            // User has no more active sockets, broadcast offline status
            io.emit('user_offline', { userId });
            console.log(`[SOCKET] User ${userId} went offline`);

            // Auto-delete logic: set expiresAt to 2 hours from now
            const twoHoursFromNow = new Date(Date.now() + 2 * 60 * 60 * 1000);
            Message.updateMany(
              { $or: [{ senderId: userId }, { receiverId: userId }] },
              { $set: { expiresAt: twoHoursFromNow } }
            ).catch(err => console.error('[SOCKET] Failed to set expiresAt for user', userId, err));
          }
        }
      }
    });
  });

  return io;
}

export function getIO(): Server {
  if (!ioInstance) {
    throw new Error('Socket.io has not been initialized');
  }
  return ioInstance;
}

export function emitToUser(userId: string, event: string, payload: any) {
  if (!ioInstance) return;
  const userSockets = connectedUsers.get(userId.toString());
  if (userSockets && userSockets.size > 0) {
    userSockets.forEach((socketId) => {
      ioInstance!.to(socketId).emit(event, payload);
    });
  }
}
