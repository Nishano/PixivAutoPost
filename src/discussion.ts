export interface DiscussionTarget {
  chatId: string;
  messageId: number;
  messageThreadId?: number;
}

export class DiscussionTracker {
  private map = new Map<string, DiscussionTarget>();
  private waiters = new Map<string, Array<(target: DiscussionTarget) => void>>();
  private pendingByChannel = new Map<string, string[]>();
  private orphanTargetsByChannel = new Map<string, DiscussionTarget[]>();

  registerPending(channelId: string, channelMessageId: number): void {
    const key = this.key(channelId, channelMessageId);
    const orphanQueue = this.orphanTargetsByChannel.get(channelId) || [];
    const orphanTarget = orphanQueue.shift();
    if (orphanTarget) {
      this.orphanTargetsByChannel.set(channelId, orphanQueue);
      this.bindTarget(key, orphanTarget);
      return;
    }

    const queue = this.pendingByChannel.get(channelId) || [];
    queue.push(key);
    this.pendingByChannel.set(channelId, queue);
  }

  noteMessage(message: any): void {
    if (!message) {
      return;
    }

    const isAutoForward = Boolean(message.is_automatic_forward);
    if (!isAutoForward) {
      return;
    }

    const sourceChannelId = this.extractSourceChannelId(message);
    const sourceMessageId = this.extractSourceMessageId(message);
    if (!sourceChannelId) {
      return;
    }

    const discussionChatId = String(message.chat?.id || '');
    const discussionMessageId = Number(message.message_id);
    if (!discussionChatId || !discussionMessageId) {
      return;
    }

    const target = {
      chatId: discussionChatId,
      messageId: discussionMessageId,
      messageThreadId: Number.isFinite(Number(message.message_thread_id))
        ? Number(message.message_thread_id)
        : undefined
    };

    if (sourceMessageId) {
      const key = this.key(sourceChannelId, sourceMessageId);
      this.map.set(key, target);
      this.removePendingKey(sourceChannelId, key);
      const listeners = this.waiters.get(key) || [];
      listeners.forEach((resolve) => resolve(target));
      this.waiters.delete(key);
    } else {
      // Some Telegram setups omit forward_from_message_id for auto-forwards.
      // In that case, bind to the oldest pending channel post we just sent.
      const queue = this.pendingByChannel.get(sourceChannelId) || [];
      const pendingKey = queue.shift();
      this.pendingByChannel.set(sourceChannelId, queue);
      if (pendingKey) {
        this.bindTarget(pendingKey, target);
      } else {
        const orphanQueue = this.orphanTargetsByChannel.get(sourceChannelId) || [];
        orphanQueue.push(target);
        this.orphanTargetsByChannel.set(sourceChannelId, orphanQueue);
      }
    }
  }

  waitForTarget(channelId: string, channelMessageId: number, timeoutMs = 7000): Promise<DiscussionTarget | null> {
    const key = this.key(channelId, channelMessageId);
    const existing = this.map.get(key);
    if (existing) {
      return Promise.resolve(existing);
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const listeners = this.waiters.get(key) || [];
        this.waiters.set(
          key,
          listeners.filter((fn) => fn !== onResolve)
        );
        resolve(null);
      }, timeoutMs);

      const onResolve = (target: DiscussionTarget) => {
        clearTimeout(timer);
        resolve(target);
      };

      const listeners = this.waiters.get(key) || [];
      listeners.push(onResolve);
      this.waiters.set(key, listeners);
    });
  }

  cancelPending(channelId: string, channelMessageId: number): void {
    const key = this.key(channelId, channelMessageId);
    this.removePendingKey(channelId, key);
  }

  getKnownTarget(channelId: string, channelMessageId: number): DiscussionTarget | null {
    return this.map.get(this.key(channelId, channelMessageId)) || null;
  }

  private extractSourceChannelId(message: any): string | null {
    if (message.sender_chat?.id) {
      return String(message.sender_chat.id);
    }

    if (message.forward_from_chat?.id) {
      return String(message.forward_from_chat.id);
    }

    if (message.forward_origin?.chat?.id) {
      return String(message.forward_origin.chat.id);
    }

    return null;
  }

  private extractSourceMessageId(message: any): number | null {
    if (message.forward_from_message_id) {
      return Number(message.forward_from_message_id);
    }

    if (message.reply_to_message?.forward_from_message_id) {
      return Number(message.reply_to_message.forward_from_message_id);
    }

    if (message.forward_origin?.message_id) {
      return Number(message.forward_origin.message_id);
    }

    return null;
  }

  private key(channelId: string, channelMessageId: number): string {
    return `${channelId}:${channelMessageId}`;
  }

  private removePendingKey(channelId: string, key: string): void {
    const queue = this.pendingByChannel.get(channelId) || [];
    this.pendingByChannel.set(
      channelId,
      queue.filter((item) => item !== key)
    );
  }

  private bindTarget(key: string, target: DiscussionTarget): void {
    this.map.set(key, target);
    const listeners = this.waiters.get(key) || [];
    listeners.forEach((resolve) => resolve(target));
    this.waiters.delete(key);
  }
}
