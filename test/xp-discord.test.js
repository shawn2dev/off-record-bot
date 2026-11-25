import { expect } from 'chai';
import { describe, it } from 'mocha';
import { PermissionFlagsBits } from 'discord.js';
import { createXpDiscord, normalizeDiscordMember } from '../src/xp-discord.js';

const guildId = '111111111111111111';
const userId = '222222222222222222';
const roleId = '333333333333333333';
const unsafeId = '444444444444444444';
const permissions = (...values) => ({
  has: (permission) => values.includes(permission),
});

function fixture() {
  const calls = [];
  const role = {
    id: roleId,
    name: '역할',
    position: 2,
    managed: false,
    permissions: permissions(),
  };
  const dangerous = {
    id: unsafeId,
    name: '관리',
    position: 1,
    managed: false,
    permissions: permissions(PermissionFlagsBits.ManageRoles),
  };
  const self = {
    permissions: permissions(
      PermissionFlagsBits.ManageRoles,
      PermissionFlagsBits.ManageNicknames,
    ),
    roles: {
      highest: { comparePositionTo: (item) => (item.id === roleId ? 1 : -1) },
    },
  };
  const guild = {
    id: guildId,
    available: true,
    roles: {
      async fetch() {
        return new Map([
          [role.id, role],
          [dangerous.id, dangerous],
        ]);
      },
    },
    members: {
      me: self,
      async fetchMe() {
        return self;
      },
      async fetch(input) {
        calls.push(input);
        return input.user
          ? member
          : new Map([
              [member.id, member],
              [bot.id, bot],
            ]);
      },
    },
  };
  const member = {
    id: userId,
    user: { bot: false, username: 'name' },
    guild,
    roles: {
      cache: new Map([[roleId, role]]),
      async add(id) {
        calls.push(['addRole', id]);
      },
    },
    joinedTimestamp: 12,
    displayName: '별명',
    nickname: '별명',
    manageable: true,
    async setNickname(name) {
      calls.push(['nickname', name]);
    },
  };
  const bot = { ...member, id: '555555555555555555', user: { bot: true } };
  const client = {
    isReady: () => true,
    guilds: { cache: new Map([[guildId, guild]]) },
    rest: {
      async put(route, { signal }) {
        signal.throwIfAborted();
        calls.push(['addRole', route.split('/').at(-1)]);
      },
      async patch(route, { body, signal }) {
        signal.throwIfAborted();
        calls.push(['nickname', body.nick]);
      },
    },
  };
  return {
    discord: createXpDiscord(client, guildId),
    calls,
    member,
    guild,
    client,
  };
}

describe('Trusted Discord economy adapter', () => {
  it('forces fresh uncached member fetches and exposes normalized membership', async () => {
    const { discord, calls } = fixture();
    expect(await discord.member(userId)).to.deep.equal({
      userId,
      roleIds: [roleId],
      bot: false,
      joinedAt: 12,
      displayName: '별명',
      nickname: '별명',
      manageable: true,
    });
    expect(calls[0]).to.deep.equal({ user: userId, force: true, cache: false });
  });

  it('treats unknown members as absent but does not hide Discord outages', async () => {
    const { discord, guild } = fixture();
    guild.members.fetch = async () => {
      throw Object.assign(new Error('missing'), { code: 10007 });
    };
    expect(await discord.member(userId)).to.equal(null);
    guild.members.fetch = async () => {
      throw new Error('offline');
    };
    let caught;
    try {
      await discord.member(userId);
    } catch (error) {
      caught = error;
    }
    expect(caught?.message).to.equal('offline');
  });

  it('classifies dangerous and hierarchy-blocked roles using the current bot member', async () => {
    const { discord } = fixture();
    expect(await discord.roles()).to.deep.equal([
      {
        id: roleId,
        name: '역할',
        position: 2,
        managed: false,
        dangerous: false,
        manageable: true,
      },
      {
        id: unsafeId,
        name: '관리',
        position: 1,
        managed: false,
        dangerous: true,
        manageable: false,
      },
    ]);
  });

  it('returns only current humans and applies optional role filters', async () => {
    const { discord, member } = fixture();
    expect(await discord.members(roleId)).to.deep.equal([
      normalizeDiscordMember(member),
    ]);
    expect(await discord.members(unsafeId)).to.deep.equal([]);
  });

  it('checks join generation immediately before role and nickname side effects', async () => {
    const { discord, calls } = fixture();
    for (const action of [
      () => discord.addRole(userId, roleId, { joinedAt: 1 }),
      () => discord.setNickname(userId, '이름', { joinedAt: 1 }),
    ]) {
      let caught;
      try {
        await action();
      } catch (error) {
        caught = error;
      }
      expect(caught?.message).to.equal('STALE_MEMBER');
    }
    expect(calls.filter(Array.isArray)).to.have.length(0);
    await discord.addRole(userId, roleId, { joinedAt: 12 });
    await discord.setNickname(userId, null, { joinedAt: 12 });
    expect(calls.filter(Array.isArray)).to.deep.equal([
      ['addRole', roleId],
      ['nickname', null],
    ]);
  });

  it('reports nickname permission failures and refuses disconnected guild calls', async () => {
    const { discord, member, guild, client } = fixture();
    guild.members.me.permissions = permissions();
    expect(normalizeDiscordMember(member).manageable).to.equal(false);
    client.isReady = () => false;
    let caught;
    try {
      await discord.member(userId);
    } catch (error) {
      caught = error;
    }
    expect(caught?.message).to.equal('Discord guild is unavailable.');
  });
});
