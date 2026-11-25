import { randomInt, randomUUID, createHash } from 'node:crypto';
import { XpError } from './xp-errors.js';
import { canManage } from './xp-settings.js';
import { drawGame, gameRtp, XP_GAMES } from './xp-games.js';
import { levelProgress } from './xp.js';

const fail = (code) => {
  throw new XpError(code);
};
const integer = (value, min = 1, max = 1000000000) =>
  Number.isSafeInteger(value) && value >= min && value <= max;
const userIdValid = (value) =>
  typeof value === 'string' && /^\d{17,20}$/.test(value);
const object = (value) =>
  value && typeof value === 'object' && !Array.isArray(value);
const isAppliedName = (saved, nickname) =>
  Boolean(
    saved && saved.applied_name !== null && saved.applied_name === nickname,
  );
const isDesiredName = (saved, nickname) =>
  Boolean(
    saved &&
    (saved.desired_name !== null || saved.state === 'processing') &&
    saved.desired_name === nickname,
  );
const canonical = (value) => JSON.stringify(normalize(value));
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (object(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, normalize(value[key])]),
    );
  return value;
}
const cursor = (value) => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!integer(parsed)) fail('INVALID_CURSOR');
  return parsed;
};
const productShape = (row) => ({
  id: String(row.id),
  version: row.version,
  title: row.title,
  description: row.description,
  roleId: row.role_id,
  priceXp: row.price_xp,
  enabled: Boolean(row.enabled),
  sortOrder: row.sort_order,
  roleLocked: Boolean(row.role_locked),
});
const orderShape = (row) => ({
  id: row.id,
  userId: row.user_id,
  productId: String(row.product_id),
  product: JSON.parse(row.snapshot_json),
  roleId: row.role_id,
  amountXp: row.amount_milli / 1000,
  state: row.state,
  status: row.state,
  attempts: row.attempts,
  errorCode: row.error_code,
  refundXp: row.refund_milli / 1000,
  generation: row.generation,
  resetVersion: row.reset_version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class XpEconomy {
  constructor(
    store,
    {
      guildId,
      discord,
      clock = Date.now,
      rng = randomInt,
      isAvailable = () => true,
    },
  ) {
    this.store = store;
    this.db = store.database;
    this.guildId = guildId;
    this.discord = discord;
    this.clock = clock;
    this.rng = rng;
    this.isAvailable = isAvailable;
    this.closed = false;
    this.running = null;
    this.activeOrders = new Map();
  }

  assertAvailable() {
    if (this.closed || !this.isAvailable()) fail('UNAVAILABLE');
  }

  async trusted(userId) {
    if (!userIdValid(userId)) fail('INVALID_MEMBER');
    this.assertAvailable();
    const member = await this.discord.member(userId);
    this.assertAvailable();
    if (!member || member.bot || member.userId !== userId)
      fail('INVALID_MEMBER');
    this.assertGeneration(member);
    return member;
  }

  assertGeneration(member, expected = null) {
    const stored = this.store.member(this.guildId, member.userId);
    if (
      !stored?.active ||
      (stored.joined_at !== null && stored.joined_at !== member.joinedAt) ||
      (expected &&
        (stored.generation !== expected.generation ||
          stored.reset_version !== expected.reset_version))
    )
      fail('STALE_MEMBER');
    return stored;
  }

  allowed(actor, permission) {
    if (
      !canManage(
        actor.userId,
        actor.roleIds,
        this.store.settings(this.guildId, 'access').value,
        permission,
      )
    )
      fail('FORBIDDEN');
  }

  audit(actorId, action, details) {
    this.db
      .prepare(
        'INSERT INTO xp_audit (guild_id, actor_id, action, details_json, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(this.guildId, actorId, action, canonical(details), this.clock());
  }

  request(action, actor, input, work) {
    if (
      typeof input.key !== 'string' ||
      !/^[a-zA-Z0-9:_-]{1,120}$/.test(input.key)
    )
      fail('INVALID_KEY');
    const { key, ...body } = input;
    const fingerprint = createHash('sha256')
      .update(canonical(body))
      .digest('hex');
    return this.store.transaction(() => {
      this.assertAvailable();
      this.assertGeneration(actor);
      const permission = {
        'products.save': 'shop.manage',
        'xp.adjust': 'xp.adjust',
        'order.review': 'orders.manage',
        'raffle.execute': 'raffle.execute',
      }[action];
      if (permission) this.allowed(actor, permission);
      const previous = this.db
        .prepare(
          'SELECT fingerprint, response_json FROM xp_requests WHERE guild_id = ? AND user_id = ? AND action = ? AND request_key = ?',
        )
        .get(this.guildId, actor.userId, action, key);
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail('TRANSACTION_CONFLICT');
        return JSON.parse(previous.response_json);
      }
      const result = work();
      if (result?.then)
        throw new TypeError('Economy transactions must be synchronous.');
      this.db
        .prepare(
          'INSERT INTO xp_requests (guild_id, user_id, action, request_key, fingerprint, response_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          this.guildId,
          actor.userId,
          action,
          key,
          fingerprint,
          JSON.stringify(result),
          this.clock(),
        );
      return result;
    });
  }

  change(userId, deltaMilli, kind, key, expected = null) {
    return this.store.applyXp(this.guildId, userId, deltaMilli, {
      key,
      kind,
      timestamp: this.clock(),
      expectedGeneration: expected?.generation ?? null,
      expectedResetVersion: expected?.reset_version ?? null,
    });
  }

  async execute(action, userId, input = {}) {
    if (!object(input)) fail('INVALID_TRANSACTION');
    const actor = await this.trusted(userId);
    switch (action) {
      case 'shop.list':
        return this.shop(actor, input);
      case 'orders.list':
        return this.orders(actor, input);
      case 'products.save':
        return this.saveProduct(actor, input);
      case 'purchase':
        return this.purchase(actor, input);
      case 'order.review':
        return this.reviewOrder(actor, input);
      case 'xp.adjust':
        return this.adjust(actor, input);
      case 'gift.send':
        return this.gift(actor, input);
      case 'game.play':
        return this.game(actor, input);
      case 'raffle.preview':
        return this.rafflePreview(actor, input);
      case 'raffle.execute':
        return this.raffleExecute(actor, input);
      case 'nickname.sync':
        return this.nicknameSync(actor, input);
      case 'nickname.status':
        return this.nicknameStatus(actor, input);
      case 'admin.summary':
        return this.summary(actor);
      case 'settings.update':
        return this.updateSettings(actor, input);
      default:
        fail('INVALID_ACTION');
    }
  }

  async updateSettings(actor, input) {
    this.allowed(actor, `${input.section}.manage`);
    const roles = await this.discord.roles();
    const currentActor = await this.trusted(actor.userId);
    return this.store.updateSettings(
      this.guildId,
      input.section,
      input.patch,
      input.version,
      { ...currentActor, roles },
      this.clock(),
    );
  }

  shop(actor, input) {
    if (input.manage) this.allowed(actor, 'shop.manage');
    let afterSort = -1000001;
    let afterId = 0;
    if (input.after) {
      if (
        typeof input.after !== 'string' ||
        !/^-?\d{1,7}\.\d{1,16}$/.test(input.after)
      )
        fail('INVALID_CURSOR');
      [afterSort, afterId] = input.after.split('.').map(Number);
      if (!integer(afterSort, -1000000, 1000000) || !integer(afterId))
        fail('INVALID_CURSOR');
    }
    const productId =
      input.productId === undefined ? null : cursor(input.productId);
    const rows = this.db
      .prepare(
        `SELECT * FROM xp_products WHERE guild_id = ?
      AND (? = 1 OR enabled = 1) AND (? IS NULL OR id = ?)
      AND (sort_order > ? OR (sort_order = ? AND id > ?))
      ORDER BY sort_order, id LIMIT 50`,
      )
      .all(
        this.guildId,
        Number(Boolean(input.manage)),
        productId,
        productId,
        afterSort,
        afterSort,
        afterId,
      );
    const items = rows.map((row) => {
      const purchased = this.db
        .prepare(
          'SELECT 1 FROM xp_entitlements WHERE guild_id = ? AND user_id = ? AND role_id = ?',
        )
        .get(this.guildId, actor.userId, row.role_id);
      const pending = this.db
        .prepare(
          "SELECT 1 FROM xp_orders WHERE guild_id = ? AND user_id = ? AND role_id = ? AND state IN ('pending','processing','review') LIMIT 1",
        )
        .get(this.guildId, actor.userId, row.role_id);
      return {
        ...productShape(row),
        purchased: Boolean(purchased),
        owned: actor.roleIds.includes(row.role_id),
        pending: Boolean(pending),
      };
    });
    items.sort(
      (a, b) => a.sortOrder - b.sortOrder || Number(a.id) - Number(b.id),
    );
    return {
      items,
      nextCursor:
        rows.length === 50
          ? `${rows.at(-1).sort_order}.${rows.at(-1).id}`
          : null,
      profile: this.store.profile(this.guildId, actor.userId),
      enabled: this.store.settings(this.guildId, 'shop').value.enabled,
    };
  }

  orders(actor, input) {
    if (input.manage) this.allowed(actor, 'orders.manage');
    const before = cursor(input.before) ?? Number.MAX_SAFE_INTEGER;
    const limit = input.limit ?? 50;
    if (!integer(limit, 1, 50)) fail('INVALID_CURSOR');
    const rows = this.db
      .prepare(
        `SELECT * FROM xp_orders WHERE guild_id = ? AND (? = 1 OR user_id = ?) AND id < ? ORDER BY id DESC LIMIT ?`,
      )
      .all(
        this.guildId,
        Number(Boolean(input.manage)),
        actor.userId,
        before,
        limit,
      );
    return {
      items: rows.map(orderShape),
      nextCursor: rows.length === limit ? rows.at(-1).id : null,
    };
  }

  assertSafeRole(roleId, roles) {
    const role = roles.find((item) => item.id === roleId);
    const delegated = this.store.settings(this.guildId, 'access').value
      .adminRoles;
    if (
      !role ||
      roleId === this.guildId ||
      role.managed ||
      role.dangerous ||
      !role.manageable ||
      Object.hasOwn(delegated, roleId)
    )
      fail('UNSAFE_ROLE');
    return role;
  }

  async saveProduct(actor, input) {
    this.allowed(actor, 'shop.manage');
    const product = input.product;
    if (
      !object(product) ||
      Object.keys(product).some(
        (key) =>
          ![
            'title',
            'description',
            'roleId',
            'priceXp',
            'enabled',
            'sortOrder',
          ].includes(key),
      ) ||
      typeof product.title !== 'string' ||
      !product.title.trim() ||
      product.title.length > 100 ||
      typeof product.description !== 'string' ||
      product.description.length > 4096 ||
      !userIdValid(product.roleId) ||
      !integer(product.priceXp, 1, 1000000000) ||
      typeof product.enabled !== 'boolean' ||
      !integer(product.sortOrder, -1000000, 1000000) ||
      !integer(input.version, 0)
    )
      fail('INVALID_PRODUCT');
    const id = input.id === undefined ? null : cursor(input.id);
    const roles = await this.discord.roles();
    actor = await this.trusted(actor.userId);
    const save = () => {
      this.allowed(actor, 'shop.manage');
      const previous = id
        ? this.db
            .prepare('SELECT * FROM xp_products WHERE guild_id = ? AND id = ?')
            .get(this.guildId, id)
        : null;
      if ((id && !previous) || (previous?.version ?? 0) !== input.version)
        fail('PRODUCT_CONFLICT');
      if (product.enabled || !previous || previous.role_id !== product.roleId)
        this.assertSafeRole(product.roleId, roles);
      if (previous?.role_locked && previous.role_id !== product.roleId)
        fail('ROLE_LOCKED');
      if (
        product.enabled &&
        this.db
          .prepare(
            'SELECT 1 FROM xp_products WHERE guild_id = ? AND role_id = ? AND enabled = 1 AND id != ?',
          )
          .get(this.guildId, product.roleId, id ?? 0)
      )
        fail('DUPLICATE_ROLE');
      const version = (previous?.version ?? 0) + 1;
      let productId = id;
      if (id) {
        this.db
          .prepare(
            'UPDATE xp_products SET version = ?, title = ?, description = ?, role_id = ?, price_xp = ?, enabled = ?, sort_order = ?, updated_at = ? WHERE id = ? AND guild_id = ?',
          )
          .run(
            version,
            product.title,
            product.description,
            product.roleId,
            product.priceXp,
            Number(product.enabled),
            product.sortOrder,
            this.clock(),
            id,
            this.guildId,
          );
      } else {
        productId = Number(
          this.db
            .prepare(
              'INSERT INTO xp_products (guild_id, version, title, description, role_id, price_xp, enabled, sort_order, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            )
            .run(
              this.guildId,
              version,
              product.title,
              product.description,
              product.roleId,
              product.priceXp,
              Number(product.enabled),
              product.sortOrder,
              this.clock(),
            ).lastInsertRowid,
        );
      }
      const saved = productShape(
        this.db
          .prepare('SELECT * FROM xp_products WHERE id = ?')
          .get(productId),
      );
      this.audit(actor.userId, 'product.save', {
        before: previous ? productShape(previous) : null,
        after: saved,
      });
      return { product: saved };
    };
    return input.key
      ? this.request('products.save', actor, input, save)
      : this.store.transaction(() => {
          this.assertGeneration(actor);
          return save();
        });
  }

  async purchase(actor, input) {
    const productId = cursor(input.productId);
    if (!productId || !integer(input.version)) fail('INVALID_PRODUCT');
    const roles = await this.discord.roles();
    actor = await this.trusted(actor.userId);
    const result = this.request('purchase', actor, input, () => {
      if (!this.store.settings(this.guildId, 'shop').value.enabled)
        fail('DISABLED');
      const row = this.db
        .prepare('SELECT * FROM xp_products WHERE guild_id = ? AND id = ?')
        .get(this.guildId, productId);
      if (!row?.enabled) fail('PRODUCT_UNAVAILABLE');
      if (row.version !== input.version) fail('PRODUCT_CONFLICT');
      this.assertSafeRole(row.role_id, roles);
      if (actor.roleIds.includes(row.role_id)) fail('ROLE_OWNED');
      if (
        this.db
          .prepare(
            'SELECT 1 FROM xp_entitlements WHERE guild_id = ? AND user_id = ? AND role_id = ?',
          )
          .get(this.guildId, actor.userId, row.role_id)
      )
        fail('ALREADY_PURCHASED');
      if (
        this.db
          .prepare(
            "SELECT 1 FROM xp_orders WHERE guild_id = ? AND user_id = ? AND role_id = ? AND state IN ('pending','processing','review')",
          )
          .get(this.guildId, actor.userId, row.role_id)
      )
        fail('ORDER_PENDING');
      const member = this.assertGeneration(actor);
      const now = this.clock();
      const orderId = Number(
        this.db
          .prepare(
            `INSERT INTO xp_orders
        (guild_id, user_id, product_id, product_version, snapshot_json, role_id, amount_milli, generation, reset_version, state, available_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
          )
          .run(
            this.guildId,
            actor.userId,
            row.id,
            row.version,
            JSON.stringify(productShape(row)),
            row.role_id,
            row.price_xp * 1000,
            member.generation,
            member.reset_version,
            now,
            now,
            now,
          ).lastInsertRowid,
      );
      this.change(
        actor.userId,
        -row.price_xp * 1000,
        'purchase',
        `order:${orderId}:purchase`,
        member,
      );
      this.db
        .prepare('UPDATE xp_products SET role_locked = 1 WHERE id = ?')
        .run(row.id);
      this.audit(actor.userId, 'purchase', {
        orderId,
        productId: row.id,
        amountXp: row.price_xp,
      });
      return {
        order: orderShape(this.order(orderId)),
        profile: this.store.profile(this.guildId, actor.userId),
      };
    });
    await this.processOrder(result.order.id);
    return {
      order: orderShape(this.order(result.order.id)),
      profile: this.store.profile(this.guildId, actor.userId),
    };
  }

  order(id) {
    return this.db
      .prepare('SELECT * FROM xp_orders WHERE guild_id = ? AND id = ?')
      .get(this.guildId, id);
  }

  async adjust(actor, input) {
    this.allowed(actor, 'xp.adjust');
    if (
      !integer(input.amount) ||
      !['add', 'remove'].includes(input.operation) ||
      typeof input.reason !== 'string' ||
      !input.reason.trim() ||
      input.reason.length > 500
    )
      fail('INVALID_TRANSACTION');
    const target = await this.trusted(input.userId);
    actor = await this.trusted(actor.userId);
    return this.request('xp.adjust', actor, input, () => {
      this.allowed(actor, 'xp.adjust');
      const member = this.assertGeneration(target);
      const ledger = this.change(
        target.userId,
        input.amount * 1000 * (input.operation === 'add' ? 1 : -1),
        'adjust',
        `adjust:${actor.userId}:${input.key}`,
        member,
      );
      this.audit(actor.userId, 'xp.adjust', {
        userId: target.userId,
        amount: input.amount,
        operation: input.operation,
        reason: input.reason,
        ledgerId: ledger.id,
      });
      return {
        userId: target.userId,
        amountXp: input.amount,
        operation: input.operation,
        reason: input.reason,
        profile: this.store.profile(this.guildId, target.userId),
      };
    });
  }

  async gift(actor, input) {
    if (!integer(input.amount) || actor.userId === input.userId)
      fail('INVALID_TRANSACTION');
    const target = await this.trusted(input.userId);
    actor = await this.trusted(actor.userId);
    return this.request('gift.send', actor, input, () => {
      const settings = this.store.settings(this.guildId, 'gift');
      if (!settings.value.enabled) fail('DISABLED');
      const sender = this.assertGeneration(actor);
      const recipient = this.assertGeneration(target);
      const basisPoints = Math.round(settings.value.feePercent * 100);
      const feeXp = Number(
        (BigInt(input.amount) * BigInt(basisPoints)) / 10000n,
      );
      const receivedXp = input.amount - feeXp;
      this.change(
        actor.userId,
        -input.amount * 1000,
        'gift_send',
        `gift:${actor.userId}:${input.key}:send`,
        sender,
      );
      this.change(
        target.userId,
        receivedXp * 1000,
        'gift_receive',
        `gift:${actor.userId}:${input.key}:receive`,
        recipient,
      );
      this.audit(actor.userId, 'gift', {
        userId: target.userId,
        amountXp: input.amount,
        feeXp,
        receivedXp,
        settingsVersion: settings.version,
      });
      return {
        userId: target.userId,
        amountXp: input.amount,
        feeXp,
        receivedXp,
        profile: this.store.profile(this.guildId, actor.userId),
      };
    });
  }

  game(actor, input) {
    if (!XP_GAMES.includes(input.game) || !integer(input.amount))
      fail('INVALID_BET');
    return this.request('game.play', actor, input, () => {
      const settings = this.store.settings(this.guildId, 'games');
      const config = settings.value[input.game];
      if (!config.enabled) fail('DISABLED');
      if (
        config.allowedRoleIds.length &&
        !config.allowedRoleIds.some((id) => actor.roleIds.includes(id))
      )
        fail('GAME_RESTRICTED');
      if (
        config.allowedChannelIds.length &&
        !config.allowedChannelIds.includes(input.channelId)
      )
        fail('GAME_RESTRICTED');
      const previous = this.db
        .prepare(
          'SELECT created_at FROM xp_game_rounds WHERE guild_id = ? AND user_id = ? AND game = ? ORDER BY created_at DESC LIMIT 1',
        )
        .get(this.guildId, actor.userId, input.game);
      if (
        previous &&
        this.clock() - previous.created_at < config.cooldownSeconds * 1000
      )
        fail('COOLDOWN');
      const result = drawGame(
        input.game,
        config,
        input.amount,
        input.choice,
        this.rng,
      );
      const member = this.assertGeneration(actor);
      const id = Number(
        this.db
          .prepare(
            'INSERT INTO xp_game_rounds (guild_id, user_id, game, amount_xp, payout_milli, outcome, choice, settings_version, snapshot_json, generation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(
            this.guildId,
            actor.userId,
            input.game,
            input.amount,
            result.payoutMilli,
            result.outcome,
            input.choice ?? null,
            settings.version,
            JSON.stringify(config),
            member.generation,
            this.clock(),
          ).lastInsertRowid,
      );
      this.change(
        actor.userId,
        -input.amount * 1000,
        'game_bet',
        `game:${id}:bet`,
        member,
      );
      this.change(
        actor.userId,
        result.payoutMilli,
        'game_payout',
        `game:${id}:payout`,
        member,
      );
      return {
        id,
        game: input.game,
        amountXp: input.amount,
        choice: input.choice ?? null,
        ...result,
        payoutXp: result.payoutMilli / 1000,
        netXp: result.payoutMilli / 1000 - input.amount,
        rtp: gameRtp(input.game, config, input.choice),
        settingsVersion: settings.version,
        profile: this.store.profile(this.guildId, actor.userId),
      };
    });
  }

  async rafflePreview(actor, input) {
    this.allowed(actor, 'raffle.execute');
    const settings = this.store.settings(this.guildId, 'raffle');
    if (
      !integer(input.winners, 1, settings.value.maxWinners) ||
      !integer(input.amount, 1, settings.value.maxAmountXp) ||
      input.winners * input.amount > settings.value.maxTotalXp ||
      (input.roleId && !userIdValid(input.roleId))
    )
      fail('INVALID_RAFFLE');
    const members = await this.discord.members(input.roleId);
    actor = await this.trusted(actor.userId);
    this.assertAvailable();
    return this.store.transaction(() => {
      this.allowed(actor, 'raffle.execute');
      this.assertGeneration(actor);
      if (
        settings.version !== this.store.settings(this.guildId, 'raffle').version
      )
        fail('SETTINGS_CONFLICT');
      const candidates = [
        ...new Map(
          members
            .filter(
              (member) =>
                !member.bot &&
                (!input.roleId || member.roleIds.includes(input.roleId)),
            )
            .map((member) => [member.userId, member]),
        ).values(),
      ].flatMap((member) => {
        try {
          const stored = this.assertGeneration(member);
          return [
            {
              userId: member.userId,
              generation: stored.generation,
              resetVersion: stored.reset_version,
              joinedAt: member.joinedAt,
            },
          ];
        } catch (error) {
          if (error instanceof XpError && error.code === 'STALE_MEMBER')
            return [];
          throw error;
        }
      });
      if (candidates.length < input.winners) fail('NOT_ENOUGH_CANDIDATES');
      const previewId = randomUUID();
      const expiresAt = this.clock() + settings.value.previewTtlSeconds * 1000;
      this.db
        .prepare(
          "INSERT INTO xp_raffles (id, guild_id, actor_id, role_id, winners, amount_xp, candidates_json, settings_version, state, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'preview', ?, ?)",
        )
        .run(
          previewId,
          this.guildId,
          actor.userId,
          input.roleId ?? null,
          input.winners,
          input.amount,
          JSON.stringify(candidates),
          settings.version,
          expiresAt,
          this.clock(),
        );
      return {
        previewId,
        candidateCount: candidates.length,
        winners: input.winners,
        amountXp: input.amount,
        totalXp: input.amount * input.winners,
        roleId: input.roleId ?? null,
        expiresAt,
      };
    });
  }

  async raffleExecute(actor, input) {
    this.allowed(actor, 'raffle.execute');
    if (typeof input.previewId !== 'string') fail('INVALID_RAFFLE');
    const preview = this.db
      .prepare(
        'SELECT * FROM xp_raffles WHERE id = ? AND guild_id = ? AND actor_id = ?',
      )
      .get(input.previewId, this.guildId, actor.userId);
    if (!preview) fail('INVALID_RAFFLE');
    const snapshot = JSON.parse(preview.candidates_json);
    const currentMembers = await this.discord.members(
      preview.role_id ?? undefined,
    );
    actor = await this.trusted(actor.userId);
    this.assertAvailable();
    const current = new Map(
      currentMembers
        .filter(
          (member) =>
            !member.bot &&
            (!preview.role_id || member.roleIds.includes(preview.role_id)),
        )
        .map((member) => [member.userId, member]),
    );
    return this.request('raffle.execute', actor, input, () => {
      this.allowed(actor, 'raffle.execute');
      const fresh = this.db
        .prepare('SELECT * FROM xp_raffles WHERE id = ?')
        .get(input.previewId);
      if (fresh.state !== 'preview') fail('RAFFLE_CONFLICT');
      if (fresh.expires_at <= this.clock()) fail('PREVIEW_EXPIRED');
      if (
        fresh.settings_version !==
        this.store.settings(this.guildId, 'raffle').version
      )
        fail('SETTINGS_CONFLICT');
      const candidates = snapshot.filter((candidate) => {
        const member = current.get(candidate.userId);
        if (!member || member.joinedAt !== candidate.joinedAt) return false;
        const stored = this.store.member(this.guildId, candidate.userId);
        return (
          stored?.active &&
          stored.generation === candidate.generation &&
          stored.reset_version === candidate.resetVersion
        );
      });
      if (candidates.length < fresh.winners) fail('NOT_ENOUGH_CANDIDATES');
      const winners = [];
      for (let index = 0; index < fresh.winners; index += 1) {
        const offset = this.rng(candidates.length);
        if (!integer(offset, 0, candidates.length - 1)) fail('INVALID_RANDOM');
        winners.push(candidates.splice(offset, 1)[0]);
      }
      const results = winners.map((winner) => {
        const ledger = this.change(
          winner.userId,
          fresh.amount_xp * 1000,
          'raffle',
          `raffle:${fresh.id}:${winner.userId}`,
          { generation: winner.generation, reset_version: winner.resetVersion },
        );
        return {
          userId: winner.userId,
          amountXp: fresh.amount_xp,
          ledgerId: ledger.id,
        };
      });
      this.db
        .prepare(
          "UPDATE xp_raffles SET state = 'completed', winners_json = ?, results_json = ? WHERE id = ?",
        )
        .run(JSON.stringify(winners), JSON.stringify(results), fresh.id);
      this.audit(actor.userId, 'raffle.execute', {
        previewId: fresh.id,
        candidates: snapshot.length,
        results,
      });
      return {
        previewId: fresh.id,
        state: 'completed',
        winners: results,
        amountXp: fresh.amount_xp,
        totalXp: fresh.amount_xp * results.length,
      };
    });
  }

  nicknameSync(actor, input) {
    this.allowed(actor, 'nickname.manage');
    if (
      input.after !== undefined &&
      (typeof input.after !== 'string' ||
        (input.after !== '' && !userIdValid(input.after)))
    )
      fail('INVALID_CURSOR');
    return this.store.transaction(() => {
      const rows = this.db
        .prepare(
          'SELECT user_id FROM xp_members WHERE guild_id = ? AND active = 1 AND user_id > ? ORDER BY user_id LIMIT 50',
        )
        .all(this.guildId, input.after ?? '');
      for (const row of rows)
        this.store.enqueueNickname(this.guildId, row.user_id, this.clock());
      const nextCursor = rows.length === 50 ? rows.at(-1).user_id : null;
      this.db
        .prepare(
          `INSERT INTO xp_nickname_sweeps (guild_id, after_user_id, active)
        VALUES (?, ?, ?) ON CONFLICT (guild_id) DO UPDATE SET
        after_user_id = excluded.after_user_id, active = excluded.active`,
        )
        .run(
          this.guildId,
          nextCursor ?? rows.at(-1)?.user_id ?? input.after ?? '',
          Number(Boolean(nextCursor)),
        );
      return {
        queued: rows.length,
        nextCursor,
        scheduled: Boolean(nextCursor),
      };
    });
  }

  nicknameStatus(actor, input) {
    this.allowed(actor, 'nickname.manage');
    const before = cursor(input.before) ?? Number.MAX_SAFE_INTEGER;
    const items = this.db
      .prepare(
        `SELECT id, user_id AS userId, generation, reset_version AS resetVersion,
      state, attempts, error_code AS errorCode, created_at AS createdAt FROM xp_jobs
      WHERE guild_id = ? AND id < ? ORDER BY id DESC LIMIT 50`,
      )
      .all(this.guildId, before);
    const sweep = this.db
      .prepare(
        'SELECT active, after_user_id AS after FROM xp_nickname_sweeps WHERE guild_id = ?',
      )
      .get(this.guildId);
    const counts = this.db
      .prepare(
        'SELECT state, COUNT(*) AS count FROM xp_jobs WHERE guild_id = ? GROUP BY state',
      )
      .all(this.guildId);
    return {
      items,
      sweep: { active: Boolean(sweep?.active), after: sweep?.after ?? null },
      counts: Object.fromEntries(counts.map((row) => [row.state, row.count])),
      nextCursor: items.length === 50 ? items.at(-1).id : null,
    };
  }

  summary(actor) {
    this.allowed(actor, 'admin.view');
    const members = this.db
      .prepare(
        'SELECT COUNT(*) AS members, COALESCE(SUM(xp_milli),0) AS balanceMilli FROM xp_members WHERE guild_id = ? AND active = 1',
      )
      .get(this.guildId);
    const orders = this.db
      .prepare(
        'SELECT state, COUNT(*) AS count FROM xp_orders WHERE guild_id = ? GROUP BY state',
      )
      .all(this.guildId);
    const jobs = this.db
      .prepare(
        'SELECT state, COUNT(*) AS count FROM xp_jobs WHERE guild_id = ? GROUP BY state',
      )
      .all(this.guildId);
    return {
      ...members,
      orders: Object.fromEntries(orders.map((row) => [row.state, row.count])),
      nickname: Object.fromEntries(jobs.map((row) => [row.state, row.count])),
    };
  }

  completeOrder(order) {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO xp_entitlements (guild_id, user_id, role_id, product_id, order_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.guildId,
        order.user_id,
        order.role_id,
        order.product_id,
        order.id,
        this.clock(),
      );
    this.db
      .prepare(
        "UPDATE xp_orders SET state = 'completed', claim_token = NULL, claimed_until = NULL, error_code = NULL, updated_at = ? WHERE id = ?",
      )
      .run(this.clock(), order.id);
  }

  refundOrder(order, actorId, code) {
    const ledger = this.store.refundXp(
      this.guildId,
      order.user_id,
      order.amount_milli,
      `order:${order.id}:refund`,
      order.reset_version,
      this.clock(),
    );
    const state =
      ledger.kind === 'refund_forfeited' ? 'refund_forfeited' : 'refunded';
    this.db
      .prepare(
        'UPDATE xp_orders SET state = ?, refund_milli = ?, error_code = ?, claim_token = NULL, claimed_until = NULL, updated_at = ? WHERE id = ?',
      )
      .run(state, ledger.delta_milli, code, this.clock(), order.id);
    this.audit(actorId, 'order.refund', {
      orderId: order.id,
      state,
      amountXp: ledger.delta_milli / 1000,
      reason: code,
    });
  }

  async reviewOrder(actor, input) {
    this.allowed(actor, 'orders.manage');
    const id = cursor(input.id);
    if (!id || !['retry', 'complete', 'refund'].includes(input.action))
      fail('INVALID_ORDER');
    const order = this.order(id);
    if (!order) fail('INVALID_ORDER');
    const member = await this.discord.member(order.user_id);
    const roles = input.action === 'retry' ? await this.discord.roles() : null;
    actor = await this.trusted(actor.userId);
    const result = this.request('order.review', actor, input, () => {
      this.allowed(actor, 'orders.manage');
      const fresh = this.order(id);
      if (!['review', 'pending'].includes(fresh.state)) fail('ORDER_CONFLICT');
      const hasRole = member?.roleIds.includes(fresh.role_id);
      if (input.action === 'complete') {
        if (!hasRole) fail('ROLE_NOT_GRANTED');
        this.assertGeneration(member, fresh);
        this.completeOrder(fresh);
      } else if (input.action === 'refund') {
        if (hasRole) fail('ROLE_ALREADY_GRANTED');
        this.refundOrder(fresh, actor.userId, 'MANUAL_REFUND');
      } else {
        if (!member || member.bot) fail('STALE_MEMBER');
        this.assertGeneration(member, fresh);
        this.assertSafeRole(fresh.role_id, roles);
        if (hasRole) this.completeOrder(fresh);
        else
          this.db
            .prepare(
              "UPDATE xp_orders SET state = 'pending', attempts = 0, available_at = ?, claim_token = NULL, claimed_until = NULL, error_code = NULL, updated_at = ? WHERE id = ?",
            )
            .run(this.clock(), this.clock(), fresh.id);
      }
      this.audit(actor.userId, 'order.review', {
        orderId: id,
        action: input.action,
      });
      return { order: orderShape(this.order(id)) };
    });
    if (input.action === 'retry') await this.processOrder(id);
    return { ...result, order: orderShape(this.order(id)) };
  }

  processOrder(id) {
    if (this.activeOrders.has(id)) return this.activeOrders.get(id);
    if (this.activeOrders.size || this.nicknameRunning)
      return Promise.resolve();
    const promise = this.runOrder(id).finally(() =>
      this.activeOrders.delete(id),
    );
    this.activeOrders.set(id, promise);
    return promise;
  }

  async runOrder(id) {
    this.assertAvailable();
    const order = this.store.transaction(() => {
      const row = this.order(id);
      if (
        !row ||
        !['pending', 'processing'].includes(row.state) ||
        row.available_at > this.clock() ||
        (row.state === 'processing' && row.claimed_until > this.clock())
      )
        return null;
      const stored = this.store.member(this.guildId, row.user_id);
      if (
        !stored?.active ||
        stored.generation !== row.generation ||
        stored.reset_version !== row.reset_version
      ) {
        this.db
          .prepare(
            "UPDATE xp_orders SET state = 'review', error_code = 'STALE_MEMBER', claim_token = NULL, claimed_until = NULL, updated_at = ? WHERE id = ?",
          )
          .run(this.clock(), id);
        return null;
      }
      if (row.attempts >= 3) {
        this.db
          .prepare(
            "UPDATE xp_orders SET state = 'review', error_code = 'ATTEMPTS_EXHAUSTED', claim_token = NULL, claimed_until = NULL, updated_at = ? WHERE id = ?",
          )
          .run(this.clock(), id);
        return null;
      }
      return this.db
        .prepare(
          "UPDATE xp_orders SET state = 'processing', attempts = attempts + 1, claim_token = ?, claimed_until = ?, updated_at = ? WHERE id = ? RETURNING *",
        )
        .get(randomUUID(), this.clock() + 30000, this.clock(), id);
    });
    if (!order) return;
    let status = 'review';
    let code = 'DISCORD_UNAVAILABLE';
    let retryAfterMs = 0;
    try {
      let member = await this.trusted(order.user_id);
      this.assertGeneration(member, order);
      if (member.roleIds.includes(order.role_id)) {
        status = 'completed';
      } else {
        const roles = await this.discord.roles();
        this.assertAvailable();
        try {
          this.assertSafeRole(order.role_id, roles);
        } catch (error) {
          if (error instanceof XpError && error.code === 'UNSAFE_ROLE') {
            status = 'refund';
            code = 'UNSAFE_ROLE';
          } else throw error;
        }
        if (status !== 'refund') {
          member = await this.trusted(order.user_id);
          this.assertGeneration(member, order);
          let deliveryError = null;
          try {
            await this.discord.addRole(order.user_id, order.role_id, {
              joinedAt: member.joinedAt,
            });
          } catch (error) {
            deliveryError = error;
            if (Number.isFinite(error.retryAfter))
              retryAfterMs = Math.min(
                86400000,
                Math.max(0, Math.ceil(error.retryAfter)),
              );
          }
          this.assertAvailable();
          const verified = await this.trusted(order.user_id);
          this.assertGeneration(verified, order);
          if (verified.roleIds.includes(order.role_id)) status = 'completed';
          else {
            code = 'ROLE_NOT_GRANTED';
            status = order.attempts >= 3 ? 'review' : 'pending';
            if (
              deliveryError?.code === 50013 ||
              deliveryError?.code === 10011
            ) {
              status = 'refund';
              code = 'ROLE_UNAVAILABLE';
            }
          }
        }
      }
      if (status === 'refund') {
        const verified = await this.trusted(order.user_id);
        this.assertGeneration(verified, order);
        if (verified.roleIds.includes(order.role_id)) status = 'completed';
      }
    } catch (error) {
      code = error instanceof XpError ? error.code : 'DISCORD_UNAVAILABLE';
      status = 'review';
    }
    if (this.closed) return;
    this.store.transaction(() => {
      const fresh = this.order(id);
      if (
        fresh.state !== 'processing' ||
        fresh.claim_token !== order.claim_token
      )
        return;
      const member = this.store.member(this.guildId, order.user_id);
      if (
        !member?.active ||
        member.generation !== order.generation ||
        member.reset_version !== order.reset_version
      ) {
        status = 'review';
        code = 'STALE_MEMBER';
      }
      if (status === 'completed') this.completeOrder(fresh);
      else if (status === 'refund')
        this.refundOrder(fresh, order.user_id, code);
      else
        this.db
          .prepare(
            'UPDATE xp_orders SET state = ?, error_code = ?, available_at = ?, claim_token = NULL, claimed_until = NULL, updated_at = ? WHERE id = ?',
          )
          .run(
            status,
            code,
            this.clock() + Math.max(1000 * 2 ** order.attempts, retryAfterMs),
            this.clock(),
            id,
          );
    });
  }

  memberUpdated(previous, member) {
    if (this.closed || member.bot) return;
    const stored = this.store.member(this.guildId, member.userId);
    if (!stored?.active) return;
    this.store.transaction(() => {
      const saved = this.db
        .prepare(
          'SELECT * FROM xp_nicknames WHERE guild_id = ? AND user_id = ?',
        )
        .get(this.guildId, member.userId);
      if (
        previous.nickname !== member.nickname &&
        saved &&
        !isAppliedName(saved, member.nickname) &&
        !isDesiredName(saved, member.nickname)
      ) {
        this.db
          .prepare(
            'UPDATE xp_nicknames SET original_nickname = ?, base_name = ?, applied_name = NULL, applied_prefix = NULL, desired_name = NULL, updated_at = ? WHERE guild_id = ? AND user_id = ?',
          )
          .run(
            member.nickname ?? null,
            member.nickname ?? member.displayName,
            this.clock(),
            this.guildId,
            member.userId,
          );
      }
      const rolesChanged =
        canonical([...previous.roleIds].sort()) !==
        canonical([...member.roleIds].sort());
      if (
        rolesChanged ||
        (previous.nickname !== member.nickname &&
          !isAppliedName(saved, member.nickname) &&
          !isDesiredName(saved, member.nickname))
      )
        this.store.enqueueNickname(this.guildId, member.userId, this.clock());
    });
  }

  async runNickname(job) {
    let error = null;
    let retryAfterMs = 0;
    try {
      const member = await this.trusted(job.user_id);
      const stored = this.assertGeneration(member, job);
      const settings = this.store.settings(this.guildId, 'nickname');
      const enabled =
        settings.value.enabled &&
        !settings.value.excludedRoleIds.some((id) =>
          member.roleIds.includes(id),
        );
      let saved = this.db
        .prepare(
          'SELECT * FROM xp_nicknames WHERE guild_id = ? AND user_id = ?',
        )
        .get(this.guildId, job.user_id);
      const actualName = member.nickname ?? member.displayName;
      if (!saved) {
        this.db
          .prepare(
            'INSERT INTO xp_nicknames (guild_id, user_id, original_nickname, base_name, generation, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(
            this.guildId,
            job.user_id,
            member.nickname ?? null,
            actualName,
            stored.generation,
            this.clock(),
          );
        saved = this.db
          .prepare(
            'SELECT * FROM xp_nicknames WHERE guild_id = ? AND user_id = ?',
          )
          .get(this.guildId, job.user_id);
      } else if (
        !isAppliedName(saved, member.nickname) &&
        !isDesiredName(saved, member.nickname) &&
        (member.nickname !== saved.original_nickname ||
          actualName !== saved.base_name ||
          saved.generation !== stored.generation)
      ) {
        this.db
          .prepare(
            'UPDATE xp_nicknames SET original_nickname = ?, base_name = ?, applied_name = NULL, applied_prefix = NULL, desired_name = NULL, generation = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?',
          )
          .run(
            member.nickname ?? null,
            actualName,
            stored.generation,
            this.clock(),
            this.guildId,
            job.user_id,
          );
        saved = this.db
          .prepare(
            'SELECT * FROM xp_nicknames WHERE guild_id = ? AND user_id = ?',
          )
          .get(this.guildId, job.user_id);
      }
      const prefix = settings.value.template.replace(
        '{레벨}',
        String(levelProgress(stored.xp_milli).level),
      );
      const target = enabled
        ? Array.from(`${prefix} ${saved.base_name}`).slice(0, 32).join('')
        : isAppliedName(saved, member.nickname) ||
            isDesiredName(saved, member.nickname)
          ? saved.original_nickname
          : member.nickname;
      if (target !== member.nickname) {
        if (!member.manageable) fail('NICKNAME_UNMANAGEABLE');
        this.assertGeneration(member, job);
        // Persist the intended name before sending so Gateway echoes are recognizable.
        this.db
          .prepare(
            "UPDATE xp_nicknames SET desired_name = ?, generation = ?, state = 'processing', updated_at = ? WHERE guild_id = ? AND user_id = ?",
          )
          .run(
            target,
            stored.generation,
            this.clock(),
            this.guildId,
            job.user_id,
          );
        await this.discord.setNickname(job.user_id, target, {
          joinedAt: member.joinedAt,
        });
        this.assertAvailable();
        const verified = await this.trusted(job.user_id);
        this.assertGeneration(verified, job);
        if (verified.nickname !== target) fail('NICKNAME_NOT_CHANGED');
      }
      this.db
        .prepare(
          "UPDATE xp_nicknames SET applied_name = ?, applied_prefix = ?, desired_name = NULL, state = 'completed', error_code = NULL, updated_at = ? WHERE guild_id = ? AND user_id = ?",
        )
        .run(
          enabled ? target : null,
          enabled ? prefix : null,
          this.clock(),
          this.guildId,
          job.user_id,
        );
    } catch (caught) {
      error = caught instanceof XpError ? caught.code : 'DISCORD_UNAVAILABLE';
      if (Number.isFinite(caught.retryAfter))
        retryAfterMs = Math.min(
          86400000,
          Math.max(0, Math.ceil(caught.retryAfter)),
        );
      if (!this.closed)
        this.db
          .prepare(
            "UPDATE xp_nicknames SET state = 'failed', error_code = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?",
          )
          .run(error, this.clock(), this.guildId, job.user_id);
    }
    if (!this.closed) {
      try {
        this.store.finishJob(
          job.id,
          job.claim_token,
          this.clock(),
          error,
          retryAfterMs,
        );
      } catch (caught) {
        if (!(caught instanceof XpError && caught.code === 'JOB_CONFLICT'))
          throw caught;
      }
    }
  }

  tick() {
    if (this.running) return this.running;
    if (this.closed || !this.isAvailable()) return Promise.resolve();
    this.running = this.runTick().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async runTick() {
    if (this.activeOrders.size) {
      await Promise.all(this.activeOrders.values());
      return;
    }
    const sweep = this.db
      .prepare(
        'SELECT * FROM xp_nickname_sweeps WHERE guild_id = ? AND active = 1',
      )
      .get(this.guildId);
    if (sweep)
      this.store.transaction(() => {
        const rows = this.db
          .prepare(
            'SELECT user_id FROM xp_members WHERE guild_id = ? AND active = 1 AND user_id > ? ORDER BY user_id LIMIT 50',
          )
          .all(this.guildId, sweep.after_user_id);
        for (const row of rows)
          this.store.enqueueNickname(this.guildId, row.user_id, this.clock());
        this.db
          .prepare(
            'UPDATE xp_nickname_sweeps SET after_user_id = ?, active = ? WHERE guild_id = ?',
          )
          .run(
            rows.at(-1)?.user_id ?? sweep.after_user_id,
            Number(rows.length === 50),
            this.guildId,
          );
      });
    const order = this.db
      .prepare(
        "SELECT id FROM xp_orders WHERE guild_id = ? AND ((state = 'pending' AND available_at <= ?) OR (state = 'processing' AND claimed_until <= ?)) ORDER BY id LIMIT 1",
      )
      .get(this.guildId, this.clock(), this.clock());
    if (order) await this.processOrder(order.id);
    if (!this.closed && this.isAvailable()) {
      const job = this.store.claimJob(this.guildId, this.clock());
      if (job) {
        this.nicknameRunning = true;
        try {
          await this.runNickname(job);
        } finally {
          this.nicknameRunning = false;
        }
      }
    }
  }

  async close() {
    this.closed = true;
    await Promise.allSettled(
      [this.running, ...this.activeOrders.values()].filter(Boolean),
    );
  }
}
