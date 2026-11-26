import { XpError } from './xp-errors.js';
import { XP_SETTINGS } from './xp.js';
import {
  defaultGameSettings,
  validateGameSettings,
  XP_GAMES,
} from './xp-games.js';

export const XP_OWNER_ID = '851312069915574332';
export const XP_PERMISSIONS = Object.freeze([
  'attendance.manage',
  'lifecycle.manage',
  'access.manage',
  'gift.manage',
  'nickname.manage',
  'games.manage',
  'raffle.manage',
  'shop.manage',
  'xp.adjust',
  'raffle.execute',
  'orders.manage',
  'admin.view',
  'audit.view',
]);

const defaults = {
  attendance: { rewardXp: XP_SETTINGS.attendanceXp },
  lifecycle: { resetOnLeave: true },
  access: { adminRoles: {} },
  gift: { enabled: true, feePercent: 15 },
  nickname: { enabled: false, template: '[lv.{레벨}]', excludedRoleIds: [] },
  raffle: {
    maxWinners: 50,
    maxAmountXp: 10000,
    maxTotalXp: 100000,
    previewTtlSeconds: 300,
  },
  shop: { enabled: true },
  games: Object.fromEntries(
    XP_GAMES.map((game) => [game, defaultGameSettings(game)]),
  ),
};

function isObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function defaultXpSettings(section) {
  if (typeof section !== 'string' || !Object.hasOwn(defaults, section))
    throw new XpError('INVALID_SETTINGS');
  return structuredClone(defaults[section]);
}

export function validateXpSettings(section, patch, current) {
  const baseline = defaultXpSettings(section);
  if (
    !isObject(patch) ||
    Object.keys(patch).length === 0 ||
    Object.keys(patch).some((key) => !Object.hasOwn(baseline, key))
  ) {
    throw new XpError('INVALID_SETTINGS');
  }
  const value = { ...current, ...patch };
  if (
    section === 'attendance' &&
    (!Number.isSafeInteger(value.rewardXp) ||
      value.rewardXp < 0 ||
      !Number.isSafeInteger(value.rewardXp * 1000))
  ) {
    throw new XpError('INVALID_SETTINGS');
  }
  if (section === 'lifecycle' && typeof value.resetOnLeave !== 'boolean') {
    throw new XpError('INVALID_SETTINGS');
  }
  if (
    section === 'gift' &&
    (typeof value.enabled !== 'boolean' ||
      !Number.isFinite(value.feePercent) ||
      value.feePercent < 0 ||
      value.feePercent > 100 ||
      Math.abs(value.feePercent * 100 - Math.round(value.feePercent * 100)) >
        1e-8)
  )
    throw new XpError('INVALID_SETTINGS');
  if (section === 'shop' && typeof value.enabled !== 'boolean')
    throw new XpError('INVALID_SETTINGS');
  if (
    section === 'nickname' &&
    (typeof value.enabled !== 'boolean' ||
      typeof value.template !== 'string' ||
      value.template.split('{레벨}').length !== 2 ||
      Array.from(value.template.replace('{레벨}', '99999999')).length > 24 ||
      /[\r\n]/.test(value.template) ||
      !Array.isArray(value.excludedRoleIds) ||
      value.excludedRoleIds.length > 100 ||
      new Set(value.excludedRoleIds).size !== value.excludedRoleIds.length ||
      value.excludedRoleIds.some((id) => !/^\d{17,20}$/.test(id)))
  )
    throw new XpError('INVALID_SETTINGS');
  if (section === 'raffle') {
    for (const [field, max] of [
      ['maxWinners', 50],
      ['maxAmountXp', 1000000],
      ['maxTotalXp', 50000000],
      ['previewTtlSeconds', 900],
    ]) {
      if (
        !Number.isSafeInteger(value[field]) ||
        value[field] < 1 ||
        value[field] > max
      )
        throw new XpError('INVALID_SETTINGS');
    }
  }
  if (section === 'games') {
    for (const game of XP_GAMES) {
      if (!isObject(value[game])) throw new XpError('INVALID_SETTINGS');
      value[game] = validateGameSettings(
        game,
        { ...current[game], ...value[game] },
        current[game],
      );
    }
  }
  if (section === 'access') {
    if (
      !isObject(value.adminRoles) ||
      Object.keys(value.adminRoles).length > 100 ||
      Object.entries(value.adminRoles).some(
        ([roleId, permissions]) =>
          !/^\d{17,20}$/.test(roleId) ||
          !Array.isArray(permissions) ||
          permissions.length > XP_PERMISSIONS.length ||
          new Set(permissions).size !== permissions.length ||
          permissions.some(
            (permission) =>
              !XP_PERMISSIONS.includes(permission) ||
              permission === 'access.manage',
          ),
      )
    ) {
      throw new XpError('INVALID_SETTINGS');
    }
  }
  return structuredClone(value);
}

export function canManageXpSettings(userId, roleIds, access, section) {
  defaultXpSettings(section);
  return canManage(userId, roleIds, access, `${section}.manage`);
}

export function canManage(userId, roleIds, access, permission) {
  if (!XP_PERMISSIONS.includes(permission)) return false;
  if (userId === XP_OWNER_ID) return true;
  if (permission === 'access.manage') return false;
  if (
    !Array.isArray(roleIds) ||
    roleIds.some(
      (roleId) => typeof roleId !== 'string' || !/^\d{17,20}$/.test(roleId),
    )
  )
    throw new XpError('INVALID_SETTINGS');
  return roleIds.some((roleId) =>
    access?.adminRoles?.[roleId]?.includes(permission),
  );
}
