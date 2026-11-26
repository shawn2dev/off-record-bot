import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
} from 'discord.js';
import { XP_KO } from './xp-locale-ko.js';
import { XpError } from './xp-errors.js';
import { levelProgress } from './xp.js';
import { XP_GAMES } from './xp-games.js';

const mentions = { parse: [], repliedUser: false };
const amountOption = (option) =>
  option
    .setName(XP_KO.amountOption)
    .setDescription(XP_KO.amountDescription)
    .setMinValue(1)
    .setMaxValue(1000000000)
    .setRequired(true);
const targetOption = (option) =>
  option
    .setName(XP_KO.memberOption)
    .setDescription(XP_KO.profileMemberDescription)
    .setRequired(true);
const button = (id, label, style = ButtonStyle.Secondary, disabled = false) =>
  new ButtonBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(style)
    .setDisabled(disabled);
const row = (...buttons) =>
  new ActionRowBuilder().addComponents(buttons).toJSON();
const payload = (content, components = [], embeds = []) => ({
  content,
  components,
  embeds,
  allowedMentions: mentions,
});
const cut = (text, max) => {
  const value = text.slice(0, max);
  // Discord builders count UTF-16 units; do not split a surrogate pair.
  return /[\uD800-\uDBFF]$/.test(value) ? value.slice(0, -1) : value;
};
const componentId = (kind, userId, expires, extra = '-') =>
  `xe:${kind}:${userId}:${expires}:${extra}`;

export function economyCommands() {
  const command = (name, description) =>
    new SlashCommandBuilder().setName(name).setDescription(description);
  const shop = command(XP_KO.shopCommand, XP_KO.shopDescription);
  const orders = command(XP_KO.ordersCommand, XP_KO.ordersDescription);
  const nickname = command(XP_KO.nicknameCommand, XP_KO.nicknameDescription);
  const gift = command(XP_KO.giftCommand, XP_KO.giftDescription)
    .addUserOption(targetOption)
    .addIntegerOption(amountOption);
  const adjusts = [XP_KO.addCommand, XP_KO.removeCommand].map((name) =>
    command(name, XP_KO.adjustDescription)
      .addUserOption(targetOption)
      .addIntegerOption(amountOption)
      .addStringOption((option) =>
        option
          .setName(XP_KO.reasonOption)
          .setDescription(XP_KO.reasonDescription)
          .setMaxLength(500)
          .setRequired(true),
      ),
  );
  const raffle = command(XP_KO.raffleCommand, XP_KO.raffleDescription)
    .addIntegerOption((option) =>
      option
        .setName(XP_KO.winnersOption)
        .setDescription(XP_KO.winnersDescription)
        .setMinValue(1)
        .setMaxValue(50)
        .setRequired(true),
    )
    .addIntegerOption(amountOption)
    .addRoleOption((option) =>
      option.setName(XP_KO.roleOption).setDescription(XP_KO.roleDescription),
    );
  const review = command(XP_KO.reviewCommand, XP_KO.reviewDescription)
    .addIntegerOption((option) =>
      option
        .setName(XP_KO.orderOption)
        .setDescription(XP_KO.orderDescription)
        .setMinValue(1)
        .setRequired(true),
    )
    .addStringOption((option) =>
      option
        .setName(XP_KO.actionOption)
        .setDescription(XP_KO.actionDescription)
        .setRequired(true)
        .addChoices(
          ...Object.entries(XP_KO.reviewActions).map(([value, name]) => ({
            value,
            name,
          })),
        ),
    );
  const games = XP_GAMES.map((game) => {
    const result = command(
      XP_KO.games[game].command,
      XP_KO.games[game].description,
    ).addIntegerOption(amountOption);
    if (game === 'oddEven' || game === 'dice')
      result.addStringOption((option) =>
        option
          .setName(XP_KO.choiceOption)
          .setDescription(XP_KO.choiceDescription)
          .setRequired(true)
          .addChoices(
            ...(game === 'dice'
              ? Array.from({ length: 6 }, (_, index) => ({
                  name: String(index + 1),
                  value: String(index + 1),
                }))
              : Object.entries(XP_KO.gameChoices).map(([value, name]) => ({
                  value,
                  name,
                }))),
          ),
      );
    return result;
  });
  return [
    shop,
    orders,
    nickname,
    gift,
    ...adjusts,
    raffle,
    review,
    ...games,
  ].map((value) => value.toJSON());
}

export function isEconomyCommand(name) {
  return [
    XP_KO.shopCommand,
    XP_KO.ordersCommand,
    XP_KO.nicknameCommand,
    XP_KO.giftCommand,
    XP_KO.addCommand,
    XP_KO.removeCommand,
    XP_KO.raffleCommand,
    XP_KO.reviewCommand,
    ...XP_GAMES.map((game) => XP_KO.games[game].command),
  ].includes(name);
}

export async function shopReply(
  economy,
  userId,
  {
    after,
    productId,
    confirm = false,
    expectedVersion,
    expires = Math.floor(Date.now() / 1000) + 600,
  } = {},
) {
  const page = await economy.execute('shop.list', userId, { after });
  const items = page.items.slice(0, 25);
  let selected = productId ? items.find((item) => item.id === productId) : null;
  if (productId && !selected)
    selected = (await economy.execute('shop.list', userId, { productId }))
      .items[0];
  if (productId && !selected) throw new XpError('PRODUCT_UNAVAILABLE');
  if (selected && expectedVersion && selected.version !== expectedVersion)
    throw new XpError('PRODUCT_CONFLICT');
  const embed = new EmbedBuilder()
    .setColor(0x24805a)
    .setTitle(selected?.title ?? XP_KO.shopTitle)
    .setDescription(
      selected?.description ||
        (items.length ? XP_KO.shopIntro : XP_KO.shopEmpty),
    );
  const components = [];
  if (items.length)
    components.push(
      new ActionRowBuilder()
        .addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(componentId('select', userId, expires, after ?? '-'))
            .setPlaceholder(XP_KO.shopPlaceholder)
            .addOptions(
              items.map((item) => ({
                label: item.title,
                value: item.id,
                description: cut(
                  `${item.purchased ? XP_KO.shopBought : item.owned ? XP_KO.shopOwned : item.pending ? XP_KO.shopPending : XP_KO.shopUnowned} · ${XP_KO.xpValue(item.priceXp)} · ${item.description.replace(/\s+/g, ' ')}`,
                  100,
                ),
                default: item.id === productId,
              })),
            ),
        )
        .toJSON(),
    );
  if (selected) {
    const afterXp = Math.max(0, page.profile.xp - selected.priceXp);
    const state = selected.purchased
      ? selected.owned
        ? XP_KO.shopBought
        : XP_KO.shopRoleMissing
      : selected.owned
        ? XP_KO.shopOwned
        : selected.pending
          ? XP_KO.shopPending
          : XP_KO.shopUnowned;
    embed.addFields(
      {
        name: XP_KO.priceLabel,
        value: XP_KO.xpValue(selected.priceXp),
        inline: true,
      },
      { name: XP_KO.roleLabel, value: `<@&${selected.roleId}>`, inline: true },
      {
        name: XP_KO.balanceLabel,
        value: XP_KO.xpValue(page.profile.xp),
        inline: true,
      },
      {
        name: XP_KO.afterBalanceLabel,
        value: XP_KO.xpValue(afterXp),
        inline: true,
      },
      {
        name: XP_KO.afterLevelLabel,
        value: String(levelProgress(afterXp * 1000).level),
        inline: true,
      },
      { name: XP_KO.statusLabel, value: state, inline: true },
    );
    components.push(
      row(
        button(
          componentId(
            confirm ? 'confirm' : 'buy',
            userId,
            expires,
            `${selected.id}.${selected.version}`,
          ),
          confirm ? XP_KO.confirmButton : XP_KO.buyButton,
          ButtonStyle.Success,
          !page.enabled ||
            selected.purchased ||
            selected.owned ||
            selected.pending ||
            page.profile.xp < selected.priceXp,
        ),
      ),
    );
  } else
    embed.addFields({
      name: XP_KO.balanceLabel,
      value: XP_KO.xpValue(page.profile.xp),
    });
  const navigation = [];
  if (items.length === 25)
    navigation.push(
      button(
        componentId(
          'page',
          userId,
          expires,
          `${items.at(-1).sortOrder}.${items.at(-1).id}`,
        ),
        XP_KO.nextButton,
      ),
    );
  if (after)
    navigation.push(
      button(componentId('page', userId, expires), XP_KO.firstButton),
    );
  if (confirm)
    navigation.push(
      button(componentId('page', userId, expires), XP_KO.cancelButton),
    );
  if (navigation.length) components.push(row(...navigation));
  return payload(confirm ? XP_KO.confirmPurchase : '', components, [
    embed.toJSON(),
  ]);
}

function nicknameReply(result, userId, expires) {
  return payload(
    `${XP_KO.nicknameQueued(result.queued)}${result.scheduled ? `\n${XP_KO.nicknameContinuing}` : ''}`,
    result.nextCursor && !result.scheduled
      ? [
          row(
            button(
              componentId('nick', userId, expires, result.nextCursor),
              XP_KO.moreNicknameButton,
            ),
          ),
        ]
      : [],
  );
}

async function ordersReply(economy, userId, expires, before) {
  const result = await economy.execute('orders.list', userId, { before });
  const items = result.items.slice(0, 10);
  return payload(
    items.map(XP_KO.orderEntry).join('\n') || XP_KO.ordersEmpty,
    result.items.length > 10 || result.nextCursor
      ? [
          row(
            button(
              componentId('orders', userId, expires, String(items.at(-1).id)),
              XP_KO.moreOrdersButton,
            ),
          ),
        ]
      : [],
  );
}

export async function economyReply(economy, interaction) {
  const userId = interaction.user.id;
  const namedResult = async (action, input) =>
    economy.store.withMemberNames(
      economy.guildId,
      await economy.execute(action, userId, input),
    );
  const key = interaction.id;
  const expires = Math.floor(Date.now() / 1000) + 600;
  if (interaction.customId?.startsWith('xe:')) {
    const match = /^xe:([a-z]+):(\d{17,20}):(\d{1,12}):(.{1,50})$/.exec(
      interaction.customId,
    );
    if (!match || Number(match[3]) <= Math.floor(Date.now() / 1000))
      return payload(XP_KO.componentExpired);
    const [, action, ownerId, expiry, extra] = match;
    if (ownerId !== userId) return payload(XP_KO.componentOtherUser);
    if (action === 'page')
      return shopReply(economy, userId, {
        after: extra === '-' ? undefined : extra,
        expires: Number(expiry),
      });
    if (action === 'orders')
      return ordersReply(economy, userId, Number(expiry), extra);
    if (action === 'select')
      return shopReply(economy, userId, {
        after: extra === '-' ? undefined : extra,
        productId: interaction.values?.[0],
        expires: Number(expiry),
      });
    if (action === 'buy' || action === 'confirm') {
      const [productId, versionString] = extra.split('.');
      const version = Number(versionString);
      if (action === 'buy')
        return shopReply(economy, userId, {
          productId,
          expectedVersion: version,
          confirm: true,
          expires: Number(expiry),
        });
      const result = await economy.execute('purchase', userId, {
        productId,
        version,
        key: `shop:${interaction.message.id}:${productId}:${version}`,
      });
      return payload(XP_KO.orderResult(result.order), [
        row(button(componentId('page', userId, expires), XP_KO.refreshButton)),
      ]);
    }
    if (action === 'raffle')
      return payload(
        '',
        [],
        [
          new EmbedBuilder()
            .setColor(0x24805a)
            .setTitle(XP_KO.raffleTitle)
            .setDescription(
              XP_KO.raffleResult(
                await namedResult('raffle.execute', {
                  previewId: extra,
                  key: `raffle:${extra}`,
                }),
              ),
            )
            .toJSON(),
        ],
      );
    if (action === 'nick')
      return nicknameReply(
        await economy.execute('nickname.sync', userId, { after: extra }),
        userId,
        Number(expiry),
      );
    throw new XpError('INVALID_ACTION');
  }
  const name = interaction.commandName;
  const options = interaction.options;
  if (name === XP_KO.shopCommand) return shopReply(economy, userId);
  if (name === XP_KO.ordersCommand) {
    return ordersReply(economy, userId, expires);
  }
  if (name === XP_KO.nicknameCommand)
    return nicknameReply(
      await economy.execute('nickname.sync', userId),
      userId,
      expires,
    );
  if (name === XP_KO.giftCommand)
    return payload(
      XP_KO.giftResult(
        await namedResult('gift.send', {
          userId: options.getUser(XP_KO.memberOption).id,
          amount: options.getInteger(XP_KO.amountOption),
          key,
        }),
      ),
    );
  if (name === XP_KO.addCommand || name === XP_KO.removeCommand)
    return payload(
      XP_KO.adjustResult(
        await namedResult('xp.adjust', {
          userId: options.getUser(XP_KO.memberOption).id,
          amount: options.getInteger(XP_KO.amountOption),
          operation: name === XP_KO.addCommand ? 'add' : 'remove',
          reason: options.getString(XP_KO.reasonOption),
          key,
        }),
      ),
    );
  if (name === XP_KO.raffleCommand) {
    const result = await economy.execute('raffle.preview', userId, {
      roleId: options.getRole(XP_KO.roleOption)?.id,
      amount: options.getInteger(XP_KO.amountOption),
      winners: options.getInteger(XP_KO.winnersOption),
    });
    return payload(XP_KO.rafflePreview(result), [
      row(
        button(
          componentId(
            'raffle',
            userId,
            Math.floor(result.expiresAt / 1000),
            result.previewId,
          ),
          XP_KO.raffleConfirm,
          ButtonStyle.Danger,
        ),
      ),
    ]);
  }
  if (name === XP_KO.reviewCommand)
    return payload(
      XP_KO.orderResult(
        (
          await economy.execute('order.review', userId, {
            id: options.getInteger(XP_KO.orderOption),
            action: options.getString(XP_KO.actionOption),
            key,
          })
        ).order,
      ),
    );
  const game = XP_GAMES.find((value) => XP_KO.games[value].command === name);
  if (game)
    return payload(
      XP_KO.gameResult(
        await economy.execute('game.play', userId, {
          game,
          amount: options.getInteger(XP_KO.amountOption),
          choice: options.getString(XP_KO.choiceOption) ?? undefined,
          key,
          channelId: interaction.channelId,
        }),
      ),
    );
  throw new XpError('INVALID_ACTION');
}
