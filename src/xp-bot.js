import process from 'node:process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Client,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Options,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';
import { XpStore } from './xp-store.js';
import { XpTracker } from './xp-tracker.js';
import { XP_KO } from './xp-locale-ko.js';
import { XpError } from './xp-errors.js';
import { XpEconomy } from './xp-economy.js';
import { createXpDiscord, normalizeDiscordMember } from './xp-discord.js';
import {
  economyCommands,
  economyReply,
  isEconomyCommand,
} from './xp-economy-ui.js';
import { readXpApiConfig, startXpApi } from './xp-api.js';

const rankingKinds = ['xp', 'total', 'streak'];

export function xpRankingButtons() {
  const labels = [
    XP_KO.xpRankingButton,
    XP_KO.attendanceTotalButton,
    XP_KO.attendanceStreakButton,
  ];
  return [
    new ActionRowBuilder()
      .addComponents(
        rankingKinds.map((kind, index) =>
          new ButtonBuilder()
            .setCustomId(`xp:ranking:${kind}`)
            .setLabel(labels[index])
            .setStyle(ButtonStyle.Secondary),
        ),
      )
      .toJSON(),
  ];
}

export function xpRankingReply(store, guildId, userId, kind, timestamp) {
  if (!rankingKinds.includes(kind)) throw new XpError('INVALID_RANKING');
  const embed = new EmbedBuilder().setColor(0x24805a);
  if (kind === 'xp') {
    const members = store.withMemberNames(guildId, store.leaderboard(guildId));
    const profile = store.profile(guildId, userId);
    embed
      .setTitle(XP_KO.leaderboardTitle)
      .setDescription(
        members.map(XP_KO.leaderboardEntry).join('\n') ||
          XP_KO.emptyLeaderboard,
      )
      .addFields({
        name: XP_KO.ownRankLabel,
        value:
          profile.rank === null
            ? XP_KO.unranked
            : XP_KO.rankValue(profile.rank),
      });
  } else {
    const members = store.withMemberNames(
      guildId,
      store.attendanceLeaderboard(guildId, kind, timestamp),
    );
    const profile = store.attendanceProfile(guildId, userId, timestamp);
    const rank = kind === 'total' ? profile.totalRank : profile.streakRank;
    embed
      .setTitle(
        kind === 'total'
          ? XP_KO.attendanceTotalTitle
          : XP_KO.attendanceStreakTitle,
      )
      .setDescription(
        members
          .map((member) => XP_KO.attendanceEntry(member, kind))
          .join('\n') || XP_KO.emptyLeaderboard,
      )
      .addFields({
        name: XP_KO.ownRankLabel,
        value: rank === null ? XP_KO.unranked : XP_KO.rankValue(rank),
      });
  }
  return {
    embeds: [embed.toJSON()],
    components: xpRankingButtons(),
    allowedMentions: { parse: [] },
  };
}

export function readXpConfig(environment = process.env) {
  const token = environment.XP_DISCORD_TOKEN;
  if (!token || token === 'replace-me')
    throw new Error('Set XP_DISCORD_TOKEN.');
  for (const name of ['XP_APPLICATION_ID', 'XP_GUILD_ID']) {
    if (!/^\d{17,20}$/.test(environment[name] ?? ''))
      throw new Error(`Set a valid ${name}.`);
  }
  const excludedChannelIds = (environment.XP_EXCLUDED_CHANNEL_IDS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (excludedChannelIds.some((value) => !/^\d{17,20}$/.test(value))) {
    throw new Error(
      'XP_EXCLUDED_CHANNEL_IDS must contain comma-separated channel IDs.',
    );
  }
  const nicknamePaused = environment.XP_NICKNAME_PAUSED ?? 'false';
  if (!['true', 'false'].includes(nicknamePaused))
    throw new Error('XP_NICKNAME_PAUSED must be true or false.');
  return {
    token,
    applicationId: environment.XP_APPLICATION_ID,
    guildId: environment.XP_GUILD_ID,
    databasePath: environment.XP_DATABASE_PATH || 'storage/xp.sqlite',
    excludedChannelIds,
    nicknamePaused: nicknamePaused === 'true',
  };
}

export function xpCommands() {
  const rank = new SlashCommandBuilder()
    .setName(XP_KO.rankCommand)
    .setDescription(XP_KO.rankDescription);
  rank.addUserOption((option) =>
    option
      .setName(XP_KO.memberOption)
      .setDescription(XP_KO.profileMemberDescription),
  );
  const leaderboard = new SlashCommandBuilder()
    .setName(XP_KO.leaderboardCommand)
    .setDescription(XP_KO.leaderboardDescription);
  const stats = new SlashCommandBuilder()
    .setName(XP_KO.statsCommand)
    .setDescription(XP_KO.statsDescription);
  stats.addIntegerOption((option) =>
    option
      .setName(XP_KO.daysOption)
      .setDescription(XP_KO.daysDescription)
      .setMinValue(1)
      .setMaxValue(30),
  );
  stats.addUserOption((option) =>
    option
      .setName(XP_KO.memberOption)
      .setDescription(XP_KO.statsMemberDescription),
  );
  const attendance = new SlashCommandBuilder()
    .setName(XP_KO.attendanceCommand)
    .setDescription(XP_KO.attendanceDescription);
  return [
    ...[rank, leaderboard, stats, attendance].map((command) =>
      command.toJSON(),
    ),
    ...economyCommands(),
  ];
}

export function xpReply(store, interaction, timestamp) {
  const guildId = interaction.guildId;
  const userName = (user) => {
    const member =
      user.id === interaction.user.id
        ? interaction.member
        : interaction.options.getMember?.(XP_KO.memberOption);
    if (member)
      return (
        member.nickname ??
        member.nick ??
        member.displayName ??
        user.globalName ??
        user.username
      );
    return (
      store.memberNames(guildId, [user.id])[user.id] ??
      user.globalName ??
      user.username
    );
  };
  const embed = new EmbedBuilder().setColor(0x24805a);
  if (interaction.commandName === XP_KO.rankCommand) {
    const user =
      interaction.options.getUser(XP_KO.memberOption) ?? interaction.user;
    const profile = store.profile(guildId, user.id);
    embed.setTitle(XP_KO.profileTitle(userName(user))).addFields(
      { name: XP_KO.xpLabel, value: String(profile.xp), inline: true },
      { name: XP_KO.levelLabel, value: String(profile.level), inline: true },
      {
        name: XP_KO.rankLabel,
        value:
          profile.rank === null
            ? XP_KO.unranked
            : XP_KO.rankValue(profile.rank),
        inline: true,
      },
      {
        name: XP_KO.nextLevelLabel,
        value: XP_KO.remainingXp(profile.remainingXp),
        inline: true,
      },
      {
        name: XP_KO.messagesLabel,
        value: String(profile.messages),
        inline: true,
      },
      {
        name: XP_KO.voiceLabel,
        value: XP_KO.voiceTime(profile.voiceMs),
        inline: true,
      },
    );
  } else if (interaction.commandName === XP_KO.leaderboardCommand) {
    return xpRankingReply(store, guildId, interaction.user.id, 'xp', timestamp);
  } else if (interaction.commandName === XP_KO.statsCommand) {
    const days = interaction.options.getInteger(XP_KO.daysOption) ?? 7;
    const user = interaction.options.getUser(XP_KO.memberOption);
    const stats = store.stats(guildId, user?.id, days, timestamp);
    embed
      .setTitle(
        XP_KO.statsTitle(user ? userName(user) : XP_KO.serverName, days),
      )
      .addFields(
        {
          name: XP_KO.messagesLabel,
          value: String(stats.messages),
          inline: true,
        },
        {
          name: XP_KO.voiceLabel,
          value: XP_KO.voiceTime(stats.voiceMs),
          inline: true,
        },
        {
          name: XP_KO.earnedXpLabel,
          value: String(Math.floor(stats.earnedXp)),
          inline: true,
        },
        {
          name: XP_KO.participantsLabel,
          value: String(stats.participants),
          inline: true,
        },
      );
  } else if (interaction.commandName === XP_KO.attendanceCommand) {
    const result = store.checkIn(guildId, interaction.user.id, timestamp);
    embed.setTitle(XP_KO.attendanceTitle).addFields(
      {
        name: XP_KO.attendanceTotalLabel,
        value: XP_KO.attendanceCount(result.total, result.totalRank),
        inline: true,
      },
      {
        name: XP_KO.attendanceStreakLabel,
        value: XP_KO.attendanceCount(result.streak, result.streakRank),
        inline: true,
      },
    );
    return {
      content: result.awarded
        ? XP_KO.attendanceAward(result.rewardXp)
        : XP_KO.attendanceAlready,
      embeds: [embed.toJSON()],
      components: xpRankingButtons(),
      allowedMentions: { parse: [] },
    };
  } else {
    throw new Error('Unknown XP command.');
  }
  return { embeds: [embed.toJSON()], allowedMentions: { parse: [] } };
}

export async function handleXpInteraction(
  interaction,
  store,
  tracker,
  isStopping = () => false,
  economy = null,
) {
  const isCommand = interaction.isChatInputCommand();
  const isRankingButton =
    interaction.isButton?.() &&
    /^xp:ranking:(xp|total|streak)$/.test(interaction.customId);
  const isEconomyComponent =
    interaction.customId?.startsWith('xe:') &&
    (interaction.isButton?.() || interaction.isStringSelectMenu?.());
  if (isStopping() || (!isCommand && !isRankingButton && !isEconomyComponent))
    return;
  try {
    await interaction.deferReply();
    if (isStopping()) return;
    if (interaction.guildId !== tracker.guildId || !tracker.active) {
      await interaction.editReply(XP_KO.trackingUnavailable);
      return;
    }
    const timestamp = Date.now();
    if (
      economy &&
      (isEconomyComponent || isEconomyCommand(interaction.commandName))
    ) {
      await interaction.editReply(await economyReply(economy, interaction));
      return;
    }
    if (economy) await economy.trusted(interaction.user.id);
    if (isCommand || interaction.customId === 'xp:ranking:xp') {
      tracker.checkpoint(timestamp);
    }
    await interaction.editReply(
      isRankingButton
        ? xpRankingReply(
            store,
            interaction.guildId,
            interaction.user.id,
            interaction.customId.slice('xp:ranking:'.length),
            timestamp,
          )
        : xpReply(store, interaction, timestamp),
    );
  } catch (error) {
    console.error(
      'XP interaction failed.',
      error instanceof XpError ? error.code : 'INTERNAL_ERROR',
    );
    if (!isStopping()) {
      const response = {
        content:
          error instanceof XpError
            ? (XP_KO.errors[error.code] ?? XP_KO.commandFailure)
            : XP_KO.commandFailure,
      };
      await (
        interaction.deferred
          ? interaction.editReply(response)
          : interaction.reply(response)
      ).catch(() => console.error('XP error response failed.'));
    }
  }
}

export async function run() {
  const config = readXpConfig();
  const apiConfig = readXpApiConfig(process.env, config);
  if (process.argv.includes('--check-config')) {
    console.log('XP configuration is valid. No Discord connection was opened.');
    return;
  }
  if (process.argv.includes('--register')) {
    const rest = new REST({ version: '10' }).setToken(config.token);
    await rest.put(
      Routes.applicationGuildCommands(config.applicationId, config.guildId),
      { body: xpCommands() },
    );
    console.log('XP guild commands registered.');
    return;
  }
  const client = new Client({
    rest: { timeout: 4000, retries: 0, rejectOnRateLimit: () => true },
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMembers,
    ],
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 0,
      ReactionManager: 0,
      PresenceManager: 0,
      GuildMemberManager: {
        maxSize: 100,
        keepOverLimit: (member) =>
          member.id === member.client.user?.id ||
          Boolean(member.voice.channelId),
      },
    }),
    allowedMentions: { parse: [], repliedUser: false },
  });
  const store = new XpStore(config.databasePath);
  const tracker = new XpTracker(
    store,
    config.guildId,
    config.excludedChannelIds,
  );
  let stopping = false;
  let initializing = false;
  let generation = 0;
  let timer;
  let workerTimer;
  let api;
  const discord = createXpDiscord(client, config.guildId, store);
  const isAvailable = () => tracker.active && !stopping && client.isReady();
  const economy = new XpEconomy(store, {
    guildId: config.guildId,
    discord,
    isAvailable,
    nicknamePaused: config.nicknamePaused,
  });
  if (config.nicknamePaused)
    console.warn('XP nickname processing is paused by XP_NICKNAME_PAUSED.');
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    discord.invalidateReadCache();
    clearInterval(timer);
    clearInterval(workerTimer);
    try {
      tracker.checkpoint(Date.now());
      tracker.suspend();
    } finally {
      try {
        try {
          await api?.close();
        } finally {
          await economy.close();
        }
      } finally {
        store.close();
        await client.destroy();
      }
    }
  };
  const fail = () => {
    console.error('XP bot stopped after a persistence or session error.');
    process.exitCode = 1;
    void stop().catch(() => console.error('XP shutdown failed.'));
  };
  const protect =
    (action) =>
    (...args) => {
      if (stopping) return;
      try {
        action(...args);
      } catch {
        fail();
      }
    };
  const suspend = protect(() => {
    generation += 1;
    discord.invalidateReadCache();
    tracker.suspend();
    console.log('XP tracking suspended; live voice intervals discarded.');
  });
  const bootstrap = async () => {
    if (stopping || initializing || tracker.active || !client.isReady()) return;
    initializing = true;
    discord.invalidateReadCache();
    const currentGeneration = generation;
    try {
      if (client.application.id !== config.applicationId) {
        console.error('XP application ID does not match the bot token.');
        fail();
        return;
      }
      const guild = client.guilds.cache.get(config.guildId);
      if (!guild?.available) throw new Error('Guild is unavailable.');
      const observedAt = Date.now();
      const members = await guild.members.fetch({
        withPresences: false,
        time: 30000,
      });
      if (
        stopping ||
        currentGeneration !== generation ||
        !client.isReady() ||
        !guild.available
      )
        return;
      try {
        store.rememberMemberNames(
          config.guildId,
          [...members.values()].map(normalizeDiscordMember),
          observedAt,
        );
        tracker.start(guild, members.values(), Date.now());
      } catch {
        fail();
        return;
      }
      console.log('XP tracking active.');
      void economy.tick().catch(fail);
    } catch {
      console.error(
        'Guild synchronization failed. Check guild access and Server Members Intent.',
      );
    } finally {
      initializing = false;
    }
  };
  client.once(Events.ClientReady, () => {
    void bootstrap();
  });
  client.on(Events.ShardDisconnect, suspend);
  client.on(Events.ShardReconnecting, suspend);
  client.on(Events.ShardResume, () => {
    void bootstrap();
  });
  client.on(Events.GuildUnavailable, (guild) => {
    if (guild.id === config.guildId) suspend();
  });
  client.on(Events.GuildAvailable, (guild) => {
    if (guild.id === config.guildId) void bootstrap();
  });
  client.on(Events.GuildDelete, (guild) => {
    if (guild.id === config.guildId) suspend();
  });
  client.on(Events.Invalidated, fail);
  client.on(Events.Error, () => console.error('Discord client error.'));
  client.on(Events.ShardError, () =>
    console.error('Discord gateway connection error.'),
  );
  client.on(
    Events.MessageCreate,
    protect((message) => tracker.message(message, message.createdTimestamp)),
  );
  client.on(
    Events.VoiceStateUpdate,
    protect((oldState, newState) =>
      tracker.voice(oldState, newState, Date.now()),
    ),
  );
  client.on(
    Events.GuildMemberRemove,
    protect((member) => {
      if (member.guild.id === config.guildId) discord.invalidateReadCache();
      tracker.leave(member, Date.now());
    }),
  );
  client.on(
    Events.GuildMemberAdd,
    protect((member) => {
      if (member.guild.id === config.guildId) discord.invalidateReadCache();
      if (member.guild.id === config.guildId)
        store.rememberMemberNames(config.guildId, [
          normalizeDiscordMember(member),
        ]);
      if (member.guild.id === config.guildId && !member.user.bot)
        store.activate(
          config.guildId,
          member.id,
          Date.now(),
          member.joinedTimestamp,
        );
    }),
  );
  client.on(
    Events.GuildMemberUpdate,
    protect((previous, member) => {
      if (member.guild.id === config.guildId) discord.invalidateReadCache();
      if (member.guild.id === config.guildId)
        store.rememberMemberNames(config.guildId, [
          normalizeDiscordMember(member),
        ]);
      if (
        tracker.active &&
        member.guild.id === config.guildId &&
        !member.user.bot
      )
        economy.memberUpdated(
          normalizeDiscordMember(previous),
          normalizeDiscordMember(member),
        );
    }),
  );
  const invalidateRoleCache = protect((role) => {
    if (role.guild.id === config.guildId) discord.invalidateReadCache();
  });
  client.on(Events.GuildRoleCreate, invalidateRoleCache);
  client.on(Events.GuildRoleDelete, invalidateRoleCache);
  client.on(Events.GuildRoleUpdate, (previous, role) =>
    invalidateRoleCache(role),
  );
  client.on(Events.InteractionCreate, (interaction) =>
    handleXpInteraction(interaction, store, tracker, () => stopping, economy),
  );
  process.once('SIGTERM', () => {
    void stop().catch(fail);
  });
  process.once('SIGINT', () => {
    void stop().catch(fail);
  });
  timer = setInterval(
    protect(() => {
      if (!client.isReady()) {
        if (tracker.active) suspend();
        return;
      }
      if (tracker.active) tracker.checkpoint(Date.now());
      else void bootstrap();
    }),
    60000,
  );
  workerTimer = setInterval(() => {
    if (isAvailable()) void economy.tick().catch(fail);
  }, 1000);
  try {
    if (apiConfig)
      api = await startXpApi({
        store,
        economy,
        discord,
        config: apiConfig,
        isAvailable,
      });
    await client.login(config.token);
  } catch {
    await stop();
    throw new Error('XP API or Discord startup failed.');
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  run().catch(() => {
    console.error(
      'XP startup failed. Check bot/API configuration, listener availability, token and Discord access.',
    );
    process.exitCode = 1;
  });
}
