import { expect } from 'chai';
import { describe, it } from 'mocha';
import { PermissionFlagsBits } from 'discord.js';
import sinon from 'sinon';
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
    role,
  };
}

describe('Trusted Discord economy adapter', () => {
  it('does not retain revoked roles after member-event invalidation', async () => {
    const { discord, member } = fixture();
    expect(
      (await discord.member(userId, { cached: true })).roleIds,
    ).to.deep.equal([roleId]);
    member.roles.cache.clear();
    discord.invalidateReadCache();
    expect(
      (await discord.member(userId, { cached: true })).roleIds,
    ).to.deep.equal([]);
  });

  it('shares read lookups, isolates returned values and expires them after five seconds', async () => {
    const clock = sinon.useFakeTimers({ now: 1000, toFake: ['Date'] });
    try {
      const { discord, calls } = fixture();
      const values = await Promise.all(
        Array.from({ length: 10 }, () =>
          discord.member(userId, { cached: true }),
        ),
      );
      expect(calls).to.have.length(1);
      values[0].roleIds.push(unsafeId);
      expect(
        (await discord.member(userId, { cached: true })).roleIds,
      ).to.deep.equal([roleId]);
      await discord.member(userId);
      expect(calls).to.have.length(2);
      clock.setSystemTime(6000);
      await discord.member(userId, { cached: true });
      expect(calls).to.have.length(3);
    } finally {
      clock.restore();
    }
  });

  it('shares read-only role snapshots but always fetches fresh roles for mutations', async () => {
    const { discord, guild, role } = fixture();
    const roles = sinon.spy(guild.roles, 'fetch');
    const self = sinon.spy(guild.members, 'fetchMe');
    await Promise.all(
      Array.from({ length: 6 }, () => discord.roles({ cached: true })),
    );
    expect(roles.calledOnce).to.equal(true);
    expect(self.calledOnce).to.equal(true);
    role.name = '변경된 역할';
    expect((await discord.roles())[0].name).to.equal(role.name);
    expect(roles.callCount).to.equal(2);
    discord.invalidateReadCache();
    expect((await discord.roles({ cached: true }))[0].name).to.equal(role.name);
    expect(roles.callCount).to.equal(3);
  });

  it('rejects a read started before invalidation and does not delete the newer in-flight lookup', async () => {
    const { discord, guild, member } = fixture();
    const releases = [];
    guild.members.fetch = () =>
      new Promise((resolve) => releases.push(() => resolve(member)));
    const old = discord.member(userId, { cached: true }).then(
      () => expect.fail('Invalidated metadata must not be returned.'),
      (error) => expect(error.code).to.equal('UNAVAILABLE'),
    );
    discord.invalidateReadCache();
    const current = discord.member(userId, { cached: true });
    releases[0]();
    await old;
    const shared = discord.member(userId, { cached: true });
    expect(releases).to.have.length(2);
    releases[1]();
    expect(await current).to.deep.equal(await shared);
  });

  it('does not cache missing members or failed requests', async () => {
    const { discord, guild, member } = fixture();
    let calls = 0;
    guild.members.fetch = async () => {
      calls += 1;
      if (calls === 1)
        throw Object.assign(new Error('missing'), { code: 10007 });
      if (calls === 2) throw new Error('offline');
      return member;
    };
    expect(await discord.member(userId, { cached: true })).to.equal(null);
    await discord.member(userId, { cached: true }).then(
      () => expect.fail('Provider failures must be visible.'),
      (error) => expect(error.message).to.equal('offline'),
    );
    expect((await discord.member(userId, { cached: true })).userId).to.equal(
      userId,
    );
    expect(calls).to.equal(3);
  });

  it('bounds read-cache entries instead of retaining every user indefinitely', async () => {
    const { discord, guild, member } = fixture();
    let calls = 0;
    guild.members.fetch = async ({ user }) => {
      calls += 1;
      return { ...member, id: user };
    };
    const users = Array.from({ length: 257 }, (_, index) =>
      String(700000000000000000n + BigInt(index)),
    );
    for (const id of users) await discord.member(id, { cached: true });
    expect(calls).to.equal(257);
    await discord.member(users[0], { cached: true });
    expect(calls).to.equal(258);
    await discord.member(users.at(-1), { cached: true });
    expect(calls).to.equal(258);
  });

  it('invalidates cached metadata on mutation attempts and refuses cached reads while disconnected', async () => {
    const { discord, calls, client } = fixture();
    await discord.member(userId, { cached: true });
    await discord.addRole(userId, roleId, { joinedAt: 12 });
    await discord.member(userId, { cached: true });
    expect(calls.filter((call) => !Array.isArray(call))).to.have.length(3);
    client.isReady = () => false;
    await discord.member(userId, { cached: true }).then(
      () => expect.fail('Disconnected sessions must not use cached metadata.'),
      (error) =>
        expect(error.message).to.equal('Discord guild is unavailable.'),
    );
  });

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
