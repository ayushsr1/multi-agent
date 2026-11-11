export interface OutboundMessage {
  to: string;
  subject: string;
  body: string;
}

export interface InboundMessage {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: string;
  subject: string;
  text: string;
}

/** A way to reach people and read their responses. Email today; add others by implementing this. */
export interface Channel {
  name: string;
  send(msg: OutboundMessage): Promise<{ messageId: string }>;
  pollInbound(): Promise<InboundMessage[]>;
}

/** A way to tell the human something. */
export interface Notifier {
  name: string;
  notify(title: string, text: string): Promise<void>;
}
