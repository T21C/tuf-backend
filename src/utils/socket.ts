import {Server} from 'socket.io';

let io: Server;

export const getIO = (): Server => {
  if (!io) {
    throw new Error('Socket.IO not initialized');
  }
  return io;
};

export const setIO = (ioServer: Server): void => {
  io = ioServer;
  console.log('Socket.IO initialized');
};
