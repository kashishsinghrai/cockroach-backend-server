import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';

import { User } from './models/User.model';
import FollowerGraph from './models/FollowerGraph.model';

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
      }
      connectedUsers.get(userId)?.add(socket.id);
      
      console.log(`[SOCKET] User ${userId} authenticated on socket ${socket.id}`);
      
      // Optionally, send them the current list of all online users so they can initialize
      const onlineUserIds = Array.from(connectedUsers.keys());
      socket.emit('initial_presence', { onlineUsers: onlineUserIds });
    });

    // --- WebRTC & Chat ---
    // Join a unique chat room based on user IDs
    socket.on('join_chat', (data: { roomId: string }) => {
      if (data && data.roomId) {
        socket.join(data.roomId);
        console.log(`[SOCKET] ${socket.id} joined room: ${data.roomId}`);
        // Notify EVERYONE in the room that a peer joined (so the caller can re-send offer)
        io.to(data.roomId).emit('peer_joined', { roomId: data.roomId });
      }
    });

    socket.on('leave_chat', (data: { roomId: string }) => {
      if (data && data.roomId) {
        socket.leave(data.roomId);
        console.log(`[SOCKET] ${socket.id} left room: ${data.roomId}`);
      }
    });

    // --- Chat Request Handshake ---
    socket.on('chat_request', async (data: { targetUserId: string; callerId: string; callerUsername: string }) => {
      console.log(`[SOCKET] chat_request from ${data.callerId} to ${data.targetUserId}`);
      
      try {
        const caller = await User.findById(data.callerId).select('gender communityPreference');
        const target = await User.findById(data.targetUserId).select('gender communityPreference');
        
        if (target && caller) {
          // Check if they are mutual followers (friends)
          const isTargetFollowingCaller = await FollowerGraph.exists({ followerId: target._id, followingId: caller._id });
          const isCallerFollowingTarget = await FollowerGraph.exists({ followerId: caller._id, followingId: target._id });
          const isMutualFriends = isTargetFollowingCaller && isCallerFollowingTarget;

          if (!isMutualFriends) {
            // Strictly enforce friends-only chat
            emitToUser(data.callerId, 'chat_request_rejected', { targetUserId: data.targetUserId, callerId: data.callerId, reason: 'friends_only' });
            return;
          }
        }
      } catch (err) {
        console.error('[SOCKET] Error checking community preferences for chat:', err);
      }

      emitToUser(data.targetUserId, 'chat_request', data);
    });

    socket.on('chat_request_accepted', (data: { targetUserId: string; callerId: string }) => {
      console.log(`[SOCKET] chat_request_accepted from ${data.targetUserId} to ${data.callerId}`);
      emitToUser(data.callerId, 'chat_request_accepted', data);
    });

    socket.on('chat_request_rejected', (data: { targetUserId: string; callerId: string }) => {
      console.log(`[SOCKET] chat_request_rejected from ${data.targetUserId} to ${data.callerId}`);
      emitToUser(data.callerId, 'chat_request_rejected', data);
      emitToUser(data.targetUserId, 'chat_request_rejected', data);
    });

    // WebRTC Signaling: Offer
    socket.on('webrtc_offer', (data: { roomId: string; offer: any }) => {
      socket.to(data.roomId).emit('webrtc_offer', { offer: data.offer });
    });

    socket.on('request_webrtc_offer', (data: { roomId: string }) => {
      socket.to(data.roomId).emit('request_webrtc_offer', { roomId: data.roomId });
    });

    // WebRTC Signaling: Answer
    socket.on('webrtc_answer', (data: { roomId: string; answer: any }) => {
      socket.to(data.roomId).emit('webrtc_answer', { answer: data.answer });
    });

    // WebRTC Signaling: ICE Candidate
    socket.on('webrtc_ice_candidate', (data: { roomId: string; candidate: any }) => {
      socket.to(data.roomId).emit('webrtc_ice_candidate', { candidate: data.candidate });
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
