import { voiceMultiplier } from './xp.js';

export class XpTracker {
  constructor(store, guildId, excludedChannelIds = []) {
    this.store = store;
    this.guildId = guildId;
    this.excludedChannelIds = new Set(excludedChannelIds);
    this.active = false;
    this.store.resetVoice();
  }

  start(guild, members, timestamp) {
    if (guild.id !== this.guildId) return;
    this.store.resetVoice();
    const present = new Map(
      [...members]
        .filter(
          (member) => typeof member === 'string' || member.user.bot === false,
        )
        .map((member) =>
          typeof member === 'string'
            ? [member, null]
            : [member.id, member.joinedTimestamp ?? null],
        ),
    );
    this.store.transaction(() => {
      for (const userId of this.store.activeUserIds(this.guildId)) {
        if (!present.has(userId))
          this.store.leave(this.guildId, userId, timestamp);
      }
      for (const [userId, joinedAt] of present) {
        this.store.activate(this.guildId, userId, timestamp, joinedAt);
      }
    });
    this.active = true;
    this.refresh(
      guild,
      new Set(
        [...guild.voiceStates.cache.values()].map((state) => state.channelId),
      ),
      timestamp,
    );
  }

  refresh(guild, channelIds, timestamp) {
    if (!this.active || guild.id !== this.guildId) return;
    const states = [...guild.voiceStates.cache.values()].filter(
      (state) => state.member?.user.bot === false,
    );
    for (const channelId of channelIds) {
      if (!channelId) continue;
      const members = states.filter((state) => state.channelId === channelId);
      const excluded =
        channelId === guild.afkChannelId ||
        this.excludedChannelIds.has(channelId);
      for (const state of members) {
        this.store.voice(
          this.guildId,
          state.id,
          channelId,
          voiceMultiplier(state, members.length, excluded),
          timestamp,
        );
      }
    }
  }

  voice(oldState, newState, timestamp) {
    if (!this.active || newState.guild.id !== this.guildId) return;
    if (!newState.channelId && newState.member?.user.bot === false) {
      this.store.voice(this.guildId, newState.id, null, 0, timestamp);
    }
    this.refresh(
      newState.guild,
      new Set([oldState.channelId, newState.channelId]),
      timestamp,
    );
  }

  message(message, timestamp) {
    if (
      !this.active ||
      message.guildId !== this.guildId ||
      message.author.bot ||
      message.webhookId
    )
      return 0;
    return this.store.message(
      this.guildId,
      message.author.id,
      message.id,
      timestamp,
    );
  }

  leave(member, timestamp) {
    if (member.guild.id !== this.guildId || member.user.bot) return;
    const channelId = this.store.session(this.guildId, member.id)?.channelId;
    this.store.leave(this.guildId, member.id, timestamp);
    member.guild.voiceStates.cache.delete(member.id);
    this.refresh(member.guild, new Set([channelId]), timestamp);
  }

  checkpoint(timestamp) {
    if (this.active) this.store.checkpoint(timestamp);
  }

  suspend() {
    this.active = false;
    this.store.resetVoice();
  }
}
