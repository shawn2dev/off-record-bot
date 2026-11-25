export const XP_SETTINGS = Object.freeze({
  messageXp: 4,
  messageCooldownMs: 1000,
  voiceXp: 20,
  voiceIntervalMs: 300000,
  attendanceXp: 500,
  mutedMultiplier: 0.5,
  minimumVoiceMembers: 2,
});

export function xpForLevel(level) {
  if (!Number.isSafeInteger(level) || level < 0) {
    throw new RangeError('Level must be a nonnegative safe integer.');
  }
  return Math.max(0, Math.floor(((10 * level) ** 2 - 5) / 3 + 1));
}

export function levelProgress(xpMilli) {
  if (!Number.isSafeInteger(xpMilli) || xpMilli < 0) {
    throw new RangeError('XP must be a nonnegative safe integer in milli-XP.');
  }
  const xp = Math.floor(xpMilli / 1000);
  const level = Math.floor(Math.sqrt((3 * xp + 4) / 100));
  return {
    xp,
    level,
    nextLevelXp: xpForLevel(level + 1),
    remainingXp: xpForLevel(level + 1) - xp,
  };
}

export function voiceMultiplier(state, humanMembers, excluded = false) {
  if (
    !state.channelId ||
    excluded ||
    humanMembers < XP_SETTINGS.minimumVoiceMembers
  ) {
    return 0;
  }
  return state.selfMute || state.selfDeaf ? XP_SETTINGS.mutedMultiplier : 1;
}

export function advanceVoice(session, timestamp) {
  let duration = Math.max(0, timestamp - session.updatedAt);
  let elapsedMs = session.elapsedMs;
  let weightedMs = session.weightedMs;
  let xpMilli = 0;
  const firstDuration = Math.min(
    duration,
    XP_SETTINGS.voiceIntervalMs - elapsedMs,
  );
  elapsedMs += firstDuration;
  weightedMs += firstDuration * session.multiplier;
  duration -= firstDuration;
  if (elapsedMs === XP_SETTINGS.voiceIntervalMs) {
    xpMilli += Math.round(
      (weightedMs / XP_SETTINGS.voiceIntervalMs) * XP_SETTINGS.voiceXp * 1000,
    );
    elapsedMs = 0;
    weightedMs = 0;
  }
  const completeIntervals = Math.floor(duration / XP_SETTINGS.voiceIntervalMs);
  xpMilli +=
    completeIntervals * XP_SETTINGS.voiceXp * 1000 * session.multiplier;
  const remainder = duration % XP_SETTINGS.voiceIntervalMs;
  elapsedMs += remainder;
  weightedMs += remainder * session.multiplier;
  return {
    xpMilli,
    durationMs: Math.max(0, timestamp - session.updatedAt),
    session: {
      ...session,
      updatedAt: Math.max(timestamp, session.updatedAt),
      elapsedMs,
      weightedMs,
    },
  };
}

export function dayKey(timestamp) {
  return new Date(timestamp + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function splitVoiceDays(start, end) {
  const segments = [];
  const dayMs = 86400000;
  const offsetMs = 9 * 60 * 60 * 1000;
  while (start < end) {
    const boundary =
      (Math.floor((start + offsetMs) / dayMs) + 1) * dayMs - offsetMs;
    const next = Math.min(boundary, end);
    segments.push({ day: dayKey(start), durationMs: next - start });
    start = next;
  }
  return segments;
}
