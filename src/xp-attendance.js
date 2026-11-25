export const CURRENT_ATTENDANCE_RANKING_SQL = `
  WITH totals AS (
    SELECT a.user_id, a.total, a.last_day, a.last_streak
    FROM xp_attendance_summary a
    JOIN xp_members m ON m.guild_id = a.guild_id AND m.user_id = a.user_id
    WHERE a.guild_id = ? AND a.last_day <= ? AND m.active = 1
  ), current AS (
    SELECT user_id AS userId, total, last_day AS lastDay,
      CASE WHEN last_day IN (?, ?) THEN last_streak ELSE 0 END AS streak
    FROM totals
  ), ranked AS (
    SELECT *, RANK() OVER (ORDER BY total DESC) AS totalRank,
      CASE WHEN streak > 0 THEN RANK() OVER (ORDER BY streak DESC) END AS streakRank
    FROM current
  )
`;

export const ATTENDANCE_RANKING_SQL = `
  WITH history AS (
    SELECT a.user_id, a.day,
      MAX(a.day) OVER (PARTITION BY a.user_id) AS last_day,
      ROW_NUMBER() OVER (PARTITION BY a.user_id ORDER BY a.day DESC) AS position
    FROM xp_attendance a
    JOIN xp_members m ON m.guild_id = a.guild_id AND m.user_id = a.user_id
    WHERE a.guild_id = ? AND a.day <= ? AND m.active = 1
  ), totals AS (
    SELECT user_id, COUNT(*) AS total, MAX(last_day) AS last_day,
      SUM(CASE WHEN julianday(last_day) - julianday(day) = position - 1
        THEN 1 ELSE 0 END) AS last_streak
    FROM history GROUP BY user_id
  ), current AS (
    SELECT user_id AS userId, total, last_day AS lastDay,
      CASE WHEN last_day IN (?, ?) THEN last_streak ELSE 0 END AS streak
    FROM totals
  ), ranked AS (
    SELECT *, RANK() OVER (ORDER BY total DESC) AS totalRank,
      CASE WHEN streak > 0 THEN RANK() OVER (ORDER BY streak DESC) END AS streakRank
    FROM current
  )
`;
