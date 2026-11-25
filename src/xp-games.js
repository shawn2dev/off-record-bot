import { randomInt } from 'node:crypto';
import { XpError } from './xp-errors.js';

export const XP_GAMES = Object.freeze(['slots', 'wheel', 'oddEven', 'dice']);
const presets = {
  slots: [
    ['lose', 75, 0],
    ['pair', 20, 30],
    ['triple', 5, 80],
  ],
  wheel: [
    ['blank', 50, 0],
    ['one', 30, 10],
    ['two', 15, 20],
    ['eight', 5, 80],
  ],
  oddEven: [
    ['odd', 1, 20],
    ['even', 1, 20],
  ],
  dice: Array.from({ length: 6 }, (_, index) => [String(index + 1), 1, 60]),
};

export function basicOutcomes(game, targetRtp = 94) {
  if (!XP_GAMES.includes(game)) throw new XpError('INVALID_SETTINGS');
  return presets[game].map(([id, weight, coefficient]) => {
    const multiplierMilli = Math.round(targetRtp * coefficient);
    if (Math.abs(multiplierMilli - targetRtp * coefficient) > 1e-8)
      throw new XpError('UNREPRESENTABLE_RTP');
    return { id, weight, multiplierMilli };
  });
}

export function defaultGameSettings(game) {
  return {
    enabled: true,
    mode: 'basic',
    targetRtp: 94,
    minBetXp: 1,
    maxBetXp: 1000,
    cooldownSeconds: 10,
    maxPayoutXp: 10000,
    allowedRoleIds: [],
    allowedChannelIds: [],
    outcomes: basicOutcomes(game),
  };
}

export function gameRtp(game, config, choice) {
  const total = config.outcomes.reduce((sum, item) => sum + item.weight, 0);
  const weighted = config.outcomes.reduce(
    (sum, item) =>
      sum +
      (['oddEven', 'dice'].includes(game) && item.id !== choice
        ? 0
        : item.weight * item.multiplierMilli),
    0,
  );
  return weighted / total / 10;
}

export function validateGameSettings(game, value) {
  const baseline = defaultGameSettings(game);
  if (
    !value ||
    Object.keys(value).some((key) => !Object.hasOwn(baseline, key)) ||
    typeof value.enabled !== 'boolean' ||
    !['basic', 'advanced'].includes(value.mode)
  )
    throw new XpError('INVALID_SETTINGS');
  for (const [field, min, max] of [
    ['minBetXp', 1, 1000000],
    ['maxBetXp', 1, 1000000],
    ['cooldownSeconds', 0, 86400],
    ['maxPayoutXp', 1, 1000000000],
  ]) {
    if (
      !Number.isSafeInteger(value[field]) ||
      value[field] < min ||
      value[field] > max
    )
      throw new XpError('INVALID_SETTINGS');
  }
  if (
    value.minBetXp > value.maxBetXp ||
    !Number.isFinite(value.targetRtp) ||
    value.targetRtp < 0 ||
    value.targetRtp > 100 ||
    (value.mode === 'basic' &&
      Math.abs(value.targetRtp * 100 - Math.round(value.targetRtp * 100)) >
        1e-8)
  )
    throw new XpError('INVALID_SETTINGS');
  for (const field of ['allowedRoleIds', 'allowedChannelIds']) {
    if (
      !Array.isArray(value[field]) ||
      value[field].length > 100 ||
      new Set(value[field]).size !== value[field].length ||
      value[field].some((id) => !/^\d{17,20}$/.test(id))
    )
      throw new XpError('INVALID_SETTINGS');
  }
  if (value.mode === 'basic') {
    value.outcomes = basicOutcomes(game, value.targetRtp);
  } else {
    if (
      !Array.isArray(value.outcomes) ||
      value.outcomes.length < 2 ||
      value.outcomes.length > 25 ||
      new Set(value.outcomes.map((item) => item?.id)).size !==
        value.outcomes.length ||
      value.outcomes.some(
        (item) =>
          !item ||
          Object.keys(item).sort().join(',') !== 'id,multiplierMilli,weight' ||
          typeof item.id !== 'string' ||
          !/^[a-zA-Z0-9_-]{1,32}$/.test(item.id) ||
          !Number.isSafeInteger(item.weight) ||
          item.weight < 1 ||
          item.weight > 1000000 ||
          !Number.isSafeInteger(item.multiplierMilli) ||
          item.multiplierMilli < 0 ||
          item.multiplierMilli > 1000000,
      ) ||
      value.outcomes.reduce((sum, item) => sum + item.weight, 0) > 1000000
    )
      throw new XpError('INVALID_SETTINGS');
    if (['oddEven', 'dice'].includes(game)) {
      const expected = presets[game]
        .map(([id]) => id)
        .sort()
        .join(',');
      if (
        value.outcomes
          .map((item) => item.id)
          .sort()
          .join(',') !== expected
      )
        throw new XpError('INVALID_SETTINGS');
    }
    const choices = ['oddEven', 'dice'].includes(game)
      ? value.outcomes.map((item) => item.id)
      : [undefined];
    const rtps = choices.map((choice) => gameRtp(game, value, choice));
    if (rtps.some((rtp) => rtp > 100)) throw new XpError('INVALID_SETTINGS');
    value.targetRtp = rtps.reduce((sum, rtp) => sum + rtp, 0) / rtps.length;
  }
  return value;
}

export function drawGame(game, config, amount, choice, rng = randomInt) {
  if (
    !Number.isSafeInteger(amount) ||
    amount < config.minBetXp ||
    amount > config.maxBetXp
  )
    throw new XpError('INVALID_BET');
  if (
    ['oddEven', 'dice'].includes(game) &&
    !config.outcomes.some((item) => item.id === choice)
  )
    throw new XpError('INVALID_CHOICE');
  const maxMultiplier = Math.max(
    ...config.outcomes.map((item) => item.multiplierMilli),
  );
  if (amount * maxMultiplier > config.maxPayoutXp * 1000)
    throw new XpError('PAYOUT_LIMIT');
  const total = config.outcomes.reduce((sum, item) => sum + item.weight, 0);
  let ticket = rng(total);
  if (!Number.isSafeInteger(ticket) || ticket < 0 || ticket >= total)
    throw new XpError('INVALID_RANDOM');
  const outcome = config.outcomes.find((item) => {
    ticket -= item.weight;
    return ticket < 0;
  });
  const won = !['oddEven', 'dice'].includes(game) || outcome.id === choice;
  const payoutMilli = won ? amount * outcome.multiplierMilli : 0;
  return {
    outcome: outcome.id,
    payoutMilli,
    multiplierMilli: won ? outcome.multiplierMilli : 0,
  };
}
