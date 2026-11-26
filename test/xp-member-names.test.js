import { expect } from 'chai';
import { afterEach, beforeEach, describe, it } from 'mocha';
import { escapeMarkdown } from 'discord.js';
import { XpStore } from '../src/xp-store.js';
import { migrateXpDatabase } from '../src/xp-migrations.js';
import { memberIds } from '../src/xp-member-names.js';
import { normalizeDiscordMember, createXpDiscord } from '../src/xp-discord.js';
import { XP_KO } from '../src/xp-locale-ko.js';
import { xpRankingReply, xpReply } from '../src/xp-bot.js';

const guild = '111111111111111111';
const user = '222222222222222222';
const actor = '333333333333333333';
const name = '서버 *별명*';
const member = (userId, displayName) => ({ userId, displayName });

describe('Guild member display names', () => {
  let store;
  beforeEach(() => {
    store = new XpStore(':memory:');
  });
  afterEach(() => {
    store.close();
  });

  it('persists renames and retains the last confirmed name after leaving or resetting XP', () => {
    store.activate(guild, user, 1, 1);
    store.rememberMemberNames(guild, [member(user, '이전 별명')], 10);
    store.rememberMemberNames(guild, [member(user, name)], 20);
    store.leave(guild, user, 30);
    expect(store.memberNames(guild, [user])).to.deep.equal({ [user]: name });
    store.activate(guild, user, 40, 40);
    expect(store.memberNames(guild, [user])).to.deep.equal({ [user]: name });
  });

  it('isolates guilds and does not overwrite a newer Gateway name with an older lookup', () => {
    store.rememberMemberNames(guild, [member(user, name)], 20);
    store.rememberMemberNames(
      'another-guild',
      [member(user, '다른 서버 별명')],
      30,
    );
    store.rememberMemberNames(guild, [member(user, '오래된 조회')], 10);
    expect(store.memberNames(guild, [user, actor])).to.deep.equal({
      [user]: name,
    });
    expect(store.memberNames('another-guild', [user])).to.deep.equal({
      [user]: '다른 서버 별명',
    });
    store.rememberMemberNames(guild, [member(user, name)], 40);
    expect(
      store.database.prepare('SELECT changes() AS count').get().count,
    ).to.equal(0);
  });

  it('rolls back an invalid name batch and surfaces invalid timestamps', () => {
    expect(() =>
      store.rememberMemberNames(
        guild,
        [member(user, name), member(actor, '')],
        10,
      ),
    ).to.throw(TypeError);
    expect(store.memberNames(guild, [user])).to.deep.equal({});
    expect(() => store.rememberMemberNames(guild, [], NaN)).to.throw(TypeError);
  });

  it('upgrades schema v3 and backfills historical names without changing balances or attendance', () => {
    store.message(guild, user, 'before-upgrade', 1);
    store.checkIn(guild, user, 1);
    const profile = store.profile(guild, user);
    const attendance = store.attendanceProfile(guild, user, 1);
    store.database.exec('DROP TABLE xp_member_names; PRAGMA user_version = 3;');
    store.database
      .prepare(
        `
      INSERT INTO xp_nicknames (guild_id, user_id, base_name, original_nickname,
        applied_name, generation, updated_at) VALUES (?, ?, ?, ?, ?, 1, 10)
    `,
      )
      .run(guild, user, '기본 이름', '원래 별명', name);
    migrateXpDatabase(store.database);
    migrateXpDatabase(store.database);
    expect(store.memberNames(guild, [user])).to.deep.equal({ [user]: name });
    expect(store.profile(guild, user)).to.deep.equal(profile);
    expect(store.attendanceProfile(guild, user, 1)).to.deep.equal(attendance);
    expect(
      store.database.prepare('PRAGMA user_version').get().user_version,
    ).to.equal(4);
    expect(
      store.database.prepare('PRAGMA integrity_check').get().integrity_check,
    ).to.equal('ok');
  });

  it('adds names to nested records without modifying IDs, cursors, reasons or the stored response', () => {
    store.rememberMemberNames(
      guild,
      [member(user, name), member(actor, '운영자')],
      10,
    );
    const raw = {
      actorId: actor,
      details: { userId: user, reason: user },
      winners: [{ userId: user }],
      roleId: actor,
      nextCursor: 123,
    };
    const original = JSON.stringify(raw);
    expect(memberIds(raw)).to.deep.equal([actor, user]);
    const result = store.withMemberNames(guild, raw);
    expect(result).to.include({
      actorId: actor,
      actorDisplayName: '운영자',
      roleId: actor,
      nextCursor: 123,
    });
    expect(result.details).to.deep.equal({
      userId: user,
      displayName: name,
      reason: user,
    });
    expect(result.winners[0]).to.deep.equal({
      userId: user,
      displayName: name,
    });
    expect(JSON.stringify(raw)).to.equal(original);
    expect(store.withMemberNames(guild, { userId: 'unknown' })).to.deep.equal({
      userId: 'unknown',
      displayName: null,
    });
  });

  it('prioritizes the guild nickname and records trusted lookups without requiring a complete Discord cache', async () => {
    const discordMember = {
      id: user,
      nickname: name,
      displayName: '계정 이름',
      user: { bot: false, globalName: '전체 표시 이름', username: 'username' },
      joinedTimestamp: 1,
      manageable: false,
      roles: { cache: new Map() },
      guild: { members: {} },
    };
    const normalized = normalizeDiscordMember(discordMember);
    expect(normalized.displayName).to.equal(name);
    const adapter = createXpDiscord(
      {
        isReady: () => true,
        guilds: {
          cache: new Map([
            [
              guild,
              {
                available: true,
                members: { fetch: async () => discordMember },
              },
            ],
          ]),
        },
      },
      guild,
      store,
    );
    await adapter.member(user, { cached: true });
    expect(store.memberNames(guild, [user])).to.deep.equal({ [user]: name });
    discordMember.nickname = null;
    discordMember.displayName = undefined;
    expect(normalizeDiscordMember(discordMember).displayName).to.equal(
      '전체 표시 이름',
    );
  });

  it('renders bot rankings and economy results with escaped guild names instead of user IDs', () => {
    store.rememberMemberNames(guild, [member(user, name)], 10);
    store.message(guild, user, 'ranking-message', 10);
    store.checkIn(guild, user, 10);
    for (const kind of ['xp', 'total', 'streak']) {
      const reply = xpRankingReply(store, guild, user, kind, 10);
      expect(reply.embeds[0].description).to.include(escapeMarkdown(name));
      expect(reply.embeds[0].description).not.to.include(user);
      expect(reply.allowedMentions).to.deep.equal({ parse: [] });
    }
    const named = store.withMemberNames(guild, {
      userId: user,
      amountXp: 10,
      receivedXp: 9,
      feeXp: 1,
      operation: 'add',
      reason: '보상',
    });
    expect(XP_KO.giftResult(named)).to.include(escapeMarkdown(name));
    expect(XP_KO.adjustResult(named)).not.to.include(user);
    expect(
      XP_KO.raffleResult({ totalXp: 10, winners: [named] }),
    ).not.to.include(user);
    expect(XP_KO.giftResult({ ...named, displayName: null })).to.include(
      XP_KO.departedMember,
    );
  });

  it('uses guild nicknames for profile and statistics titles while preserving account-name fallback', () => {
    store.rememberMemberNames(guild, [member(user, name)], 10);
    const interaction = {
      guildId: guild,
      user: { id: actor },
      options: {
        getUser: () => ({ id: user, globalName: '계정 이름' }),
        getInteger: () => 7,
      },
    };
    expect(
      xpReply(store, { ...interaction, commandName: XP_KO.rankCommand }, 10)
        .embeds[0].title,
    ).to.equal(`${name}님의 활동 정보`);
    expect(
      xpReply(store, { ...interaction, commandName: XP_KO.statsCommand }, 10)
        .embeds[0].title,
    ).to.equal(`${name} 활동 통계: 최근 7일`);
    interaction.options.getMember = () => ({ nick: '현재 서버 별명' });
    expect(
      xpReply(store, { ...interaction, commandName: XP_KO.rankCommand }, 10)
        .embeds[0].title,
    ).to.equal('현재 서버 별명님의 활동 정보');
  });
});
