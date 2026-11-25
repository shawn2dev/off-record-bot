import { PermissionFlagsBits, Routes } from 'discord.js';
import { XpError } from './xp-errors.js';

const dangerousPermissions = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.ModerateMembers,
  PermissionFlagsBits.MentionEveryone,
  PermissionFlagsBits.ManageMessages,
  PermissionFlagsBits.ManageNicknames,
  PermissionFlagsBits.ViewAuditLog,
  PermissionFlagsBits.ManageGuildExpressions,
  PermissionFlagsBits.ManageThreads,
  PermissionFlagsBits.ManageEvents,
];

export function normalizeDiscordMember(member) {
  return {
    userId: member.id,
    roleIds: [...member.roles.cache.keys()],
    bot: member.user.bot,
    joinedAt: member.joinedTimestamp,
    displayName:
      member.displayName ?? member.user.globalName ?? member.user.username,
    nickname: member.nickname ?? null,
    manageable:
      member.manageable &&
      Boolean(
        member.guild.members.me?.permissions.has(
          PermissionFlagsBits.ManageNicknames,
        ),
      ),
  };
}

export function createXpDiscord(client, guildId) {
  const bounded = async (action) => {
    let timer;
    const controller = new AbortController();
    try {
      return await Promise.race([
        action(controller.signal),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error('Discord request timed out.'));
          }, 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const guild = () => {
    const value = client.guilds.cache.get(guildId);
    if (!client.isReady() || !value?.available)
      throw new Error('Discord guild is unavailable.');
    return value;
  };
  return {
    async member(userId) {
      try {
        return normalizeDiscordMember(
          await bounded(() =>
            guild().members.fetch({ user: userId, force: true, cache: false }),
          ),
        );
      } catch (error) {
        if (error.code === 10007 || error.code === 10013) return null;
        throw error;
      }
    },
    async roles() {
      const currentGuild = guild();
      const [roles, self] = await bounded(() =>
        Promise.all([
          currentGuild.roles.fetch(),
          currentGuild.members.fetchMe({ force: true }),
        ]),
      );
      return [...roles.values()].filter(Boolean).map((role) => ({
        id: role.id,
        name: role.name,
        position: role.position,
        managed: role.managed,
        dangerous: dangerousPermissions.some((permission) =>
          role.permissions.has(permission),
        ),
        manageable:
          role.id !== guildId &&
          !role.managed &&
          self.permissions.has(PermissionFlagsBits.ManageRoles) &&
          self.roles.highest.comparePositionTo(role) > 0,
      }));
    },
    async members(roleId) {
      const members = await bounded(() =>
        guild().members.fetch({ withPresences: false, time: 4000 }),
      );
      return [...members.values()]
        .filter(
          (member) =>
            !member.user.bot && (!roleId || member.roles.cache.has(roleId)),
        )
        .map(normalizeDiscordMember);
    },
    async addRole(userId, roleId, expected = {}) {
      await bounded(async (signal) => {
        const member = await guild().members.fetch({
          user: userId,
          force: true,
          cache: false,
        });
        if (
          expected.joinedAt !== undefined &&
          member.joinedTimestamp !== expected.joinedAt
        )
          throw new XpError('STALE_MEMBER');
        signal.throwIfAborted();
        await client.rest.put(Routes.guildMemberRole(guildId, userId, roleId), {
          signal,
        });
      });
    },
    async setNickname(userId, nickname, expected = {}) {
      await bounded(async (signal) => {
        const member = await guild().members.fetch({
          user: userId,
          force: true,
          cache: false,
        });
        if (
          expected.joinedAt !== undefined &&
          member.joinedTimestamp !== expected.joinedAt
        )
          throw new XpError('STALE_MEMBER');
        signal.throwIfAborted();
        await client.rest.patch(Routes.guildMember(guildId, userId), {
          body: { nick: nickname },
          signal,
        });
      });
    },
  };
}
