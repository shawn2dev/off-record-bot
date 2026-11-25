import { expect } from 'chai';
import { describe, it } from 'mocha';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sinon from 'sinon';
import {
  advanceVoice,
  dayKey,
  levelProgress,
  splitVoiceDays,
  voiceMultiplier,
  xpForLevel,
} from '../src/xp.js';
import { XpStore } from '../src/xp-store.js';
import { XpTracker } from '../src/xp-tracker.js';
import { XP_KO } from '../src/xp-locale-ko.js';
import {
  handleXpInteraction,
  readXpConfig,
  xpCommands,
  xpReply,
} from '../src/xp-bot.js';

describe('XP rules', () => {
  it('matches the screenshot cumulative table and integer level boundaries', () => {
    const thresholds = [
      [0, 0],
      [1, 32],
      [2, 132],
      [3, 299],
      [4, 532],
      [5, 832],
      [10, 3332],
      [20, 13332],
      [30, 29999],
      [50, 83332],
      [100, 333332],
    ];
    for (const [level, xp] of thresholds) {
      expect(xpForLevel(level)).to.equal(xp);
    }
    for (let level = 1; level <= 1000; level += 1) {
      const threshold = xpForLevel(level);
      expect(levelProgress(threshold * 1000).level).to.equal(level);
      expect(levelProgress((threshold - 1) * 1000).level).to.equal(level - 1);
      expect(levelProgress(threshold * 1000 - 1).level).to.equal(level - 1);
    }
    expect(levelProgress(0).level).to.equal(0);
    expect(() => levelProgress(-1)).to.throw(RangeError);
  });

  it('matches the screenshot per-level XP requirements', () => {
    const requirements = [
      [1, 32],
      [2, 100],
      [3, 167],
      [4, 233],
      [5, 300],
      [10, 633],
      [20, 1300],
      [30, 1967],
      [50, 3300],
      [100, 6633],
    ];
    for (const [level, xp] of requirements) {
      expect(xpForLevel(level) - xpForLevel(level - 1)).to.equal(xp);
    }
  });

  it('corrects the reported 520 and 588 XP levels without changing XP balances', () => {
    expect(levelProgress(520000)).to.deep.equal({
      xp: 520,
      level: 3,
      nextLevelXp: 532,
      remainingXp: 12,
    });
    expect(levelProgress(588000)).to.deep.equal({
      xp: 588,
      level: 4,
      nextLevelXp: 832,
      remainingXp: 244,
    });
  });

  it('reduces self mute or self deafen once and ignores server mute', () => {
    expect(
      voiceMultiplier({ channelId: 'voice', serverMute: true }, 2),
    ).to.equal(1);
    expect(voiceMultiplier({ channelId: 'voice', selfMute: true }, 2)).to.equal(
      0.5,
    );
    expect(voiceMultiplier({ channelId: 'voice', selfDeaf: true }, 2)).to.equal(
      0.5,
    );
    expect(
      voiceMultiplier(
        { channelId: 'voice', selfMute: true, selfDeaf: true },
        2,
      ),
    ).to.equal(0.5);
    expect(voiceMultiplier({ channelId: 'voice' }, 1)).to.equal(0);
    expect(voiceMultiplier({ channelId: 'voice' }, 2, true)).to.equal(0);
  });

  it('settles mute transitions without applying the final state retroactively', () => {
    let session = { updatedAt: 0, elapsedMs: 0, weightedMs: 0, multiplier: 1 };
    let result = advanceVoice(session, 120000);
    expect(result.xpMilli).to.equal(0);
    session = { ...result.session, multiplier: 0.5 };
    result = advanceVoice(session, 300000);
    expect(result.xpMilli).to.equal(14000);
    expect(result.session.elapsedMs).to.equal(0);
    expect(advanceVoice(result.session, 600000).xpMilli).to.equal(10000);
  });

  it('keeps partial intervals and handles multiple complete intervals', () => {
    const initial = {
      updatedAt: 0,
      elapsedMs: 0,
      weightedMs: 0,
      multiplier: 1,
    };
    const partial = advanceVoice(initial, 60000);
    expect(partial.xpMilli).to.equal(0);
    expect(advanceVoice(partial.session, 900000).xpMilli).to.equal(60000);
    expect(advanceVoice(partial.session, 30000).session).to.deep.equal(
      partial.session,
    );
  });

  it('uses Korean calendar days and splits voice time across midnight', () => {
    const start = Date.parse('2026-11-23T14:59:00Z');
    const end = Date.parse('2026-11-23T15:01:00Z');
    expect(dayKey(start)).to.equal('2026-11-23');
    expect(dayKey(end)).to.equal('2026-11-24');
    expect(splitVoiceDays(start, end)).to.deep.equal([
      { day: '2026-11-23', durationMs: 60000 },
      { day: '2026-11-24', durationMs: 60000 },
    ]);
  });
});

describe('XP gateway tracking', () => {
  function withTracker(action, excluded = []) {
    const store = new XpStore(':memory:');
    const guild = {
      id: 'guild',
      afkChannelId: 'afk',
      voiceStates: { cache: new Map() },
    };
    const tracker = new XpTracker(store, guild.id, excluded);
    function state(userId, channelId, flags = {}) {
      const value = {
        id: userId,
        guild,
        channelId,
        member: { user: { bot: false } },
        ...flags,
      };
      if (channelId) guild.voiceStates.cache.set(userId, value);
      else guild.voiceStates.cache.delete(userId);
      return value;
    }
    try {
      action({ store, guild, tracker, state });
    } finally {
      store.close();
    }
  }

  it('recomputes eligibility for the remaining member when a human leaves voice', () => {
    withTracker(({ store, guild, tracker, state }) => {
      state('first', 'voice');
      const previous = state('second', 'voice');
      tracker.start(guild, ['first', 'second'], 0);
      tracker.voice(previous, state('second', null), 120000);
      tracker.checkpoint(300000);
      expect(store.profile('guild', 'first')).to.include({
        xp: 8,
        voiceMs: 300000,
      });
      expect(store.profile('guild', 'second')).to.include({
        xp: 0,
        voiceMs: 120000,
      });
    });
  });

  it('applies self flags prospectively while ignoring server mute and server deafen', () => {
    withTracker(({ store, guild, tracker, state }) => {
      const previous = state('first', 'voice', {
        serverMute: true,
        serverDeaf: true,
      });
      state('second', 'voice');
      tracker.start(guild, ['first', 'second'], 0);
      tracker.voice(
        previous,
        state('first', 'voice', { selfMute: true, selfDeaf: true }),
        120000,
      );
      tracker.checkpoint(300000);
      expect(store.profile('guild', 'first').xp).to.equal(14);
      expect(store.profile('guild', 'second').xp).to.equal(20);
    });
  });

  it('does not count bots towards occupancy and excludes AFK and configured channels', () => {
    withTracker(
      ({ store, guild, tracker, state }) => {
        state('solo', 'voice');
        state('bot', 'voice', { member: { user: { bot: true } } });
        state('afk-first', 'afk');
        state('afk-second', 'afk');
        state('excluded-first', 'excluded');
        state('excluded-second', 'excluded');
        tracker.start(
          guild,
          [
            'solo',
            'bot',
            'afk-first',
            'afk-second',
            'excluded-first',
            'excluded-second',
          ],
          0,
        );
        tracker.checkpoint(300000);
        for (const userId of ['solo', 'bot', 'afk-first', 'excluded-first']) {
          expect(store.profile('guild', userId).xp).to.equal(0);
        }
        expect(store.session('guild', 'bot')).to.equal(undefined);
      },
      ['excluded'],
    );
  });

  it('filters other guilds, bots, webhooks and suspended message events', () => {
    withTracker(({ store, guild, tracker }) => {
      const message = {
        id: 'message',
        guildId: 'guild',
        author: { id: 'user', bot: false },
      };
      expect(tracker.message(message, 0)).to.equal(0);
      tracker.start(guild, ['user'], 0);
      expect(tracker.message({ ...message, guildId: 'other' }, 0)).to.equal(0);
      expect(
        tracker.message({ ...message, author: { id: 'bot', bot: true } }, 0),
      ).to.equal(0);
      expect(tracker.message({ ...message, webhookId: 'webhook' }, 0)).to.equal(
        0,
      );
      expect(tracker.message(message, 0)).to.equal(4000);
      expect(store.profile('guild', 'user').messages).to.equal(1);
    });
  });

  it('discards offline time and reconciles members absent after reconnection', () => {
    withTracker(({ store, guild, tracker, state }) => {
      state('first', 'voice');
      state('second', 'voice');
      tracker.start(guild, ['first', 'second'], 0);
      store.message('guild', 'departed', 'message', 0);
      tracker.checkpoint(300000);
      tracker.suspend();
      tracker.checkpoint(86400000);
      expect(store.profile('guild', 'first').xp).to.equal(20);
      tracker.start(guild, ['first', 'second'], 86400000);
      expect(store.profile('guild', 'departed')).to.include({
        xp: 0,
        rank: null,
      });
      tracker.checkpoint(86700000);
      expect(store.profile('guild', 'first')).to.include({
        xp: 40,
        voiceMs: 600000,
      });
    });
  });

  it('resets departing members and immediately updates remaining voice eligibility', () => {
    withTracker(({ store, guild, tracker, state }) => {
      const first = state('first', 'voice');
      state('second', 'voice');
      tracker.start(guild, ['first', 'second'], 0);
      store.attendance('guild', 'first', 0);
      tracker.leave({ id: 'first', guild, user: first.member.user }, 120000);
      tracker.checkpoint(300000);
      expect(store.profile('guild', 'first')).to.include({ xp: 0, rank: null });
      expect(store.profile('guild', 'second').xp).to.equal(8);
    });
  });
});

describe('XP commands and configuration', () => {
  function mockInteraction(commandName = XP_KO.rankCommand) {
    const responses = { deferred: [], edited: [], immediate: [] };
    return {
      commandName,
      guildId: 'guild',
      user: { id: 'user', username: 'Tester' },
      options: { getUser: () => null, getInteger: () => null },
      isChatInputCommand: () => true,
      responses,
      async deferReply(options = {}) {
        responses.deferred.push(options);
        this.deferred = true;
      },
      async editReply(response) {
        responses.edited.push(response);
      },
      async reply(response) {
        responses.immediate.push(response);
      },
    };
  }

  it('publishes every XP command without ephemeral flags', async () => {
    const store = new XpStore(':memory:');
    const tracker = { guildId: 'guild', active: true, checkpoint: () => {} };
    try {
      for (const commandName of [
        XP_KO.rankCommand,
        XP_KO.leaderboardCommand,
        XP_KO.statsCommand,
        XP_KO.attendanceCommand,
      ]) {
        const interaction = mockInteraction(commandName);
        await handleXpInteraction(interaction, store, tracker);
        expect(interaction.responses.deferred).to.deep.equal([{}]);
        expect(interaction.responses.edited).to.have.length(1);
        expect(interaction.responses.edited[0]).not.to.have.property('flags');
        expect(interaction.responses.edited[0]).not.to.have.property(
          'ephemeral',
        );
        expect(
          interaction.responses.edited[0].allowedMentions.parse,
        ).to.deep.equal([]);
      }
    } finally {
      store.close();
    }
  });

  it('publishes unavailable-tracking responses in the channel', async () => {
    for (const active of [true, false]) {
      const interaction = mockInteraction();
      const tracker = { guildId: active ? 'other' : 'guild', active };
      await handleXpInteraction(interaction, null, tracker);
      expect(interaction.responses.deferred).to.deep.equal([{}]);
      expect(interaction.responses.edited).to.deep.equal([
        XP_KO.trackingUnavailable,
      ]);
    }
  });

  it('publishes errors before and after deferring without ephemeral flags', async () => {
    const errorLog = sinon.stub(console, 'error');
    try {
      for (const deferFails of [true, false]) {
        const interaction = mockInteraction();
        if (deferFails)
          interaction.deferReply = async () => {
            throw new Error('Deferral failed.');
          };
        const tracker = {
          guildId: 'guild',
          active: true,
          checkpoint: () => {
            throw new Error('Checkpoint failed.');
          },
        };
        await handleXpInteraction(interaction, null, tracker);
        const responses = deferFails
          ? interaction.responses.immediate
          : interaction.responses.edited;
        expect(responses).to.deep.equal([{ content: XP_KO.commandFailure }]);
      }
    } finally {
      errorLog.restore();
    }
  });

  it('validates independent XP credentials and excluded channel IDs', () => {
    const environment = {
      XP_DISCORD_TOKEN: 'test-only',
      XP_APPLICATION_ID: '123456789012345678',
      XP_GUILD_ID: '234567890123456789',
      XP_EXCLUDED_CHANNEL_IDS: '345678901234567890, 456789012345678901',
    };
    expect(readXpConfig(environment)).to.include({
      guildId: environment.XP_GUILD_ID,
      databasePath: 'storage/xp.sqlite',
      nicknamePaused: false,
    });
    expect(
      readXpConfig({ ...environment, XP_NICKNAME_PAUSED: 'true' })
        .nicknamePaused,
    ).to.equal(true);
    expect(
      readXpConfig({ ...environment, XP_NICKNAME_PAUSED: 'false' })
        .nicknamePaused,
    ).to.equal(false);
    expect(() =>
      readXpConfig({ ...environment, XP_NICKNAME_PAUSED: 'yes' }),
    ).to.throw('XP_NICKNAME_PAUSED');
    expect(readXpConfig(environment).excludedChannelIds).to.have.length(2);
    expect(() =>
      readXpConfig({ ...environment, XP_DISCORD_TOKEN: 'replace-me' }),
    ).to.throw('XP_DISCORD_TOKEN');
    expect(() => readXpConfig({ ...environment, XP_GUILD_ID: '' })).to.throw(
      'XP_GUILD_ID',
    );
    expect(() =>
      readXpConfig({ ...environment, XP_EXCLUDED_CHANNEL_IDS: 'invalid' }),
    ).to.throw('XP_EXCLUDED_CHANNEL_IDS');
  });

  it('registers Korean XP and economy commands with a bounded activity window', () => {
    const commands = xpCommands();
    expect(commands.map((command) => command.name)).to.deep.equal([
      '랭크',
      '순위',
      '통계',
      '출석',
      '상점',
      '내구매',
      '별명동기화',
      '경험치선물',
      '경험치추가',
      '경험치제거',
      '경험치추첨',
      '구매관리',
      '슬롯',
      '돌림판',
      '홀짝',
      '주사위',
    ]);
    for (const command of commands) {
      expect(command.description).to.match(/[가-힣]/u);
      expect(command.description).not.to.match(/[A-Za-z]/);
      for (const option of command.options ?? []) {
        expect([
          '대상',
          '기간',
          '금액',
          '사유',
          '인원',
          '대상역할',
          '주문번호',
          '처리',
          '선택',
        ]).to.include(option.name);
        expect(option.description).to.match(/[가-힣]/u);
        expect(option.description).not.to.match(/[A-Za-z]/);
      }
    }
    const days = commands
      .find((command) => command.name === XP_KO.statsCommand)
      .options.find((option) => option.name === XP_KO.daysOption);
    expect(days).to.include({ min_value: 1, max_value: 30 });
  });

  it('renders all display states in Korean even for English Discord clients', () => {
    const store = new XpStore(':memory:');
    try {
      const responses = [];
      for (const commandName of [
        XP_KO.rankCommand,
        XP_KO.leaderboardCommand,
        XP_KO.statsCommand,
        XP_KO.attendanceCommand,
        XP_KO.attendanceCommand,
        XP_KO.rankCommand,
        XP_KO.leaderboardCommand,
      ]) {
        const interaction = {
          ...mockInteraction(commandName),
          locale: 'en-US',
        };
        responses.push(xpReply(store, interaction, 0));
      }
      const text = responses
        .flatMap((response) => [
          response.content,
          ...(response.embeds ?? []).flatMap((embed) => [
            embed.title,
            embed.description,
            ...(embed.fields ?? []).flatMap((field) => [
              field.name,
              field.value,
            ]),
          ]),
        ])
        .filter((value) => typeof value === 'string')
        .join('\n')
        .replaceAll('Tester', '')
        .replace(/<@[^>]+>/g, '');
      expect(text).to.match(/[가-힣]/u);
      expect(text).not.to.match(/[A-Za-z]/);
      expect(text).to.include('순위 없음');
      expect(text).to.include('아직 기록된 활동이 없습니다.');
      expect(text).to.include('오늘은 이미 출석했습니다.');
      for (const value of Object.values(XP_KO)) {
        if (typeof value !== 'string') continue;
        expect(value).to.match(/[가-힣]/u);
        expect(value).not.to.match(/[A-Za-z]/);
      }
    } finally {
      store.close();
    }
  });

  it('reads Korean option names and preserves user-provided display names', () => {
    const store = new XpStore(':memory:');
    const requestedOptions = [];
    const interaction = mockInteraction();
    interaction.options = {
      getUser: (name) => {
        requestedOptions.push(name);
        return { id: 'other', username: 'Other', globalName: 'Display Name' };
      },
      getInteger: (name) => {
        requestedOptions.push(name);
        return 30;
      },
    };
    try {
      store.message('guild', 'other', 'message', 0);
      const profile = xpReply(store, interaction, 0);
      expect(profile.embeds[0].title).to.equal('Display Name님의 활동 정보');
      const stats = xpReply(
        store,
        { ...interaction, commandName: XP_KO.statsCommand },
        0,
      );
      expect(stats.embeds[0].title).to.equal(
        'Display Name 활동 통계: 최근 30일',
      );
      expect(
        stats.embeds[0].fields.find(
          (field) => field.name === XP_KO.messagesLabel,
        ).value,
      ).to.equal('1');
      expect(requestedOptions).to.deep.equal(['대상', '기간', '대상']);
    } finally {
      store.close();
    }
  });

  it('renders balances and attendance without mentions or direct messages', () => {
    const store = new XpStore(':memory:');
    const interaction = {
      commandName: XP_KO.attendanceCommand,
      guildId: 'guild',
      user: { id: 'user', username: 'Tester' },
      options: { getUser: () => null, getInteger: () => null },
    };
    try {
      expect(xpReply(store, interaction, 0).content).to.include('500점');
      expect(xpReply(store, interaction, 0).content).to.equal(
        XP_KO.attendanceAlready,
      );
      const rank = xpReply(
        store,
        { ...interaction, commandName: XP_KO.rankCommand },
        0,
      );
      expect(
        rank.embeds[0].fields.find((field) => field.name === XP_KO.xpLabel)
          .value,
      ).to.equal('500');
      expect(rank.allowedMentions.parse).to.deep.equal([]);
      const stats = xpReply(
        store,
        { ...interaction, commandName: XP_KO.statsCommand },
        0,
      );
      expect(
        stats.embeds[0].fields.find(
          (field) => field.name === XP_KO.earnedXpLabel,
        ).value,
      ).to.equal('500');
      const leaderboard = xpReply(
        store,
        { ...interaction, commandName: XP_KO.leaderboardCommand },
        0,
      );
      expect(leaderboard.embeds[0].description).to.include('경험치 500점');
      expect(() =>
        xpReply(store, { ...interaction, commandName: 'gift' }, 0),
      ).to.throw('Unknown');
    } finally {
      store.close();
    }
  });
});

describe('XP storage', () => {
  function withStore(action) {
    const store = new XpStore(':memory:');
    try {
      action(store);
    } finally {
      store.close();
    }
  }

  it('deduplicates messages while counting messages during cooldown', () => {
    withStore((store) => {
      expect(store.message('guild', 'user', 'first', 0)).to.equal(4000);
      expect(store.message('guild', 'user', 'first', 5000)).to.equal(0);
      expect(store.message('guild', 'user', 'second', 500)).to.equal(0);
      expect(store.message('guild', 'user', 'third', 1000)).to.equal(4000);
      expect(store.profile('guild', 'user')).to.include({
        xp: 8,
        messages: 3,
        level: 0,
      });
    });
  });

  it('awards attendance once per Korean calendar day, even after leaving', () => {
    withStore((store) => {
      const timestamp = Date.parse('2026-11-23T14:59:00Z');
      expect(store.attendance('guild', 'user', timestamp)).to.equal(true);
      expect(store.attendance('guild', 'user', timestamp)).to.equal(false);
      store.leave('guild', 'user', timestamp);
      expect(store.profile('guild', 'user')).to.include({ xp: 0, rank: null });
      expect(store.attendance('guild', 'user', timestamp)).to.equal(false);
      store.activate('guild', 'user', timestamp + 1);
      expect(store.attendance('guild', 'user', timestamp + 60000)).to.equal(
        true,
      );
    });
  });

  it('accounts for mute transitions and discards incomplete intervals on voice departure', () => {
    withStore((store) => {
      store.voice('guild', 'user', 'channel', 1, 0);
      store.voice('guild', 'user', 'channel', 0.5, 120000);
      store.checkpoint(300000);
      expect(store.profile('guild', 'user')).to.include({
        xp: 14,
        voiceMs: 300000,
      });
      store.voice('guild', 'user', null, 0, 360000);
      expect(store.profile('guild', 'user')).to.include({
        xp: 14,
        voiceMs: 360000,
      });
      store.checkpoint(900000);
      expect(store.profile('guild', 'user').voiceMs).to.equal(360000);
    });
  });

  it('isolates guilds, ranks active users, and aggregates bounded daily statistics', () => {
    withStore((store) => {
      store.message('guild', 'first', 'one', 0);
      store.message('guild', 'second', 'two', 0);
      store.attendance('guild', 'second', 0);
      store.attendance('other', 'first', 0);
      expect(store.profile('guild', 'first').rank).to.equal(2);
      expect(
        store.leaderboard('guild').map((member) => member.userId),
      ).to.deep.equal(['second', 'first']);
      expect(store.stats('guild', null, 7, 0)).to.include({
        messages: 2,
        earnedXp: 508,
        participants: 2,
      });
      expect(() => store.stats('guild', null, 31, 0)).to.throw(RangeError);
      store.leave('guild', 'second', 0);
      expect(store.profile('guild', 'first').rank).to.equal(1);
    });
  });

  it('persists balances across restarts without awarding offline voice time', () => {
    const directory = mkdtempSync(join(tmpdir(), 'xp-test-'));
    try {
      const filename = join(directory, 'xp.sqlite');
      let store = new XpStore(filename);
      store.message('guild', 'user', 'message', 0);
      store.voice('guild', 'user', 'channel', 1, 0);
      store.checkpoint(300000);
      store.close();
      store = new XpStore(filename);
      try {
        store.resetVoice();
        store.checkpoint(86400000);
        expect(store.profile('guild', 'user')).to.include({
          xp: 24,
          voiceMs: 300000,
        });
        expect(store.message('guild', 'user', 'message', 86400000)).to.equal(0);
      } finally {
        store.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
