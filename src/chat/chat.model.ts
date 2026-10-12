// Longest message text accepted, after trimming.
export const MAX_MESSAGE_LENGTH = 2000;

// The wire shape of a message (the DTO): what clients receive over WebSocket and HTTP.
// id and createdAt are strings, because JSON has no ObjectId or Date.
export interface ChatMessage {
  id: string;
  roomId: string;
  senderId: string;
  recipientId: string;
  text: string;
  createdAt: string;
}

// One row of the conversation list
export interface ConversationSummary {
  roomId: string;
  otherUserId: string;
  lastMessage: ChatMessage;
}
