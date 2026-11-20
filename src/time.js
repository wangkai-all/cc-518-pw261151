/**
 * 时区处理模块。
 *
 * 所有事件在入库时即把「本地挂钟时间 + IANA 时区 / 固定偏移」解析为 UTC 瞬间（epoch ms），
 * 原始本地时间与时区标签保留用于审计与展示。
 *
 * 依赖运行时内置 Intl（Node 20+/现代浏览器均自带完整 ICU），无第三方依赖。
 */

export const MINUTE_MS = 60_000;
export const HOUR_MS = 3_600_000;

const WALL_RE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const FIXED_RE = /^(?:UTC|GMT)(?:([+-])(\d{1,2})(?::?(\d{2}))?)?$/;

/**
 * 解析 "YYYY-MM-DDTHH:mm[:ss]" 形式的本地挂钟时间，
 * 返回其「假装是 UTC」时对应的 epoch ms 与拆分字段。
 */
export function parseWallParts(wallStr) {
  const m = WALL_RE.exec(String(wallStr).trim());
  if (!m) {
    throw new Error(`非法本地时间格式: ${wallStr}（应为 YYYY-MM-DDTHH:mm:ss）`);
  }
  const [, year, month, day, hour, minute, second] = m;
  return {
    ms: Date.UTC(+year, +month - 1, +day, +hour, +minute, +(second || 0)),
    year: +year,
    month: +month,
    day: +day,
    hour: +hour,
    minute: +minute,
    second: +(second || 0),
  };
}

/** 识别 UTC/GMT+08:00 形式的固定偏移，返回偏移分钟数；非固定偏移返回 null。 */
export function parseFixedOffset(timeZone) {
  const m = FIXED_RE.exec(String(timeZone).trim());
  if (!m) return null;
  if (!m[1]) return 0;
  const sign = m[1] === '+' ? 1 : -1;
  return sign * (Number(m[2]) * 60 + Number(m[3] || 0));
}

/**
 * 取某一瞬间在指定时区的本地挂钟时间、偏移分钟与缩写名。
 */
export function formatInZone(instant, timeZone) {
  const fixed = parseFixedOffset(timeZone);
  if (fixed !== null) {
    const d = new Date(instant + fixed * MINUTE_MS);
    return {
      wall: d.toISOString().slice(0, 19),
      offsetMinutes: fixed,
      name: offsetLabel(fixed),
    };
  }
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'shortOffset',
  });
  const parts = {};
  for (const p of dtf.formatToParts(instant)) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  // 部分环境午夜会返回 hour=24
  const hour = parts.hour === '24' ? '00' : parts.hour;
  const wall = `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}:${parts.second}`;
  const tzn = parts.timeZoneName || '';
  const om = /GMT(?:([+-])(\d{1,2})(?::?(\d{2}))?)?/.exec(tzn);
  let offset = 0;
  if (om && om[1]) {
    offset = (om[1] === '+' ? 1 : -1) * (Number(om[2]) * 60 + Number(om[3] || 0));
  }
  return { wall, offsetMinutes: offset, name: tzn || timeZone };
}

export function instantToWall(instant, timeZone) {
  return formatInZone(instant, timeZone).wall;
}

/** 偏移的标准标签，如 UTC+08:00 / UTC-03:30 / UTC。 */
export function offsetLabel(offsetMinutes) {
  if (!offsetMinutes) return 'UTC';
  const abs = Math.abs(offsetMinutes);
  const h = String(Math.floor(abs / 60)).padStart(2, '0');
  const m = String(abs % 60).padStart(2, '0');
  return `UTC${offsetMinutes > 0 ? '+' : '-'}${h}:${m}`;
}

/**
 * 本地挂钟时间 -> UTC 瞬间。
 *
 * 注意：夏令时回拨瞬间，挂钟时间序列本身不单调（01:59 -> 01:00），
 * 不能在瞬间轴上直接二分。这里采用「偏移反推候选 + 回映验证」：
 * 用探针瞬间的偏移把挂钟时间反推为 UTC，再用 formatInZone 回映验证；
 * gap/ambiguous 时检查相邻偏移给出的第二个候选。
 *
 * 返回：
 *   { status: 'ok' | 'ambiguous' | 'gap', instant, offsetMinutes, alternatives, message, timeZone }
 *
 * - ok：唯一映射
 * - ambiguous：夏令时结束回拨，同一挂钟时间对应两个瞬间，默认取较早者（夏令时侧），两个候选放入 alternatives
 * - gap：夏令时开始前跳，挂钟时间不存在，顺延到跳转后的第一个有效瞬间
 */
export function resolveWallTime(wallStr, timeZone) {
  const { ms: pseudoUtc } = parseWallParts(wallStr);

  const fixed = parseFixedOffset(timeZone);
  if (fixed !== null) {
    return {
      status: 'ok',
      instant: pseudoUtc - fixed * MINUTE_MS,
      offsetMinutes: fixed,
      alternatives: [],
      timeZone,
      message: null,
    };
  }

  const wallAt = (instant) => formatInZone(instant, timeZone).wall;
  const valid = (instant) => wallAt(instant) === wallStr;

  // 枚举探针前后 24h 内出现过的全部偏移（DST 切换日最多两个），
  // 对每个偏移反推一个 UTC 候选再回映验证。不依赖固定窗口宽度，
  // 对南/北半球、任意转换时刻都成立。
  const offsets = new Set();
  for (let t = pseudoUtc - 24 * HOUR_MS; t <= pseudoUtc + 24 * HOUR_MS; t += HOUR_MS) {
    offsets.add(formatInZone(t, timeZone).offsetMinutes);
  }
  const candidates = [...offsets]
    .map((off) => pseudoUtc - off * MINUTE_MS)
    .filter(valid)
    .sort((a, b) => a - b);

  if (candidates.length === 2) {
    const [early, late] = candidates;
    return {
      status: 'ambiguous',
      instant: early, // 默认取较早瞬间（夏令时侧）
      offsetMinutes: formatInZone(early, timeZone).offsetMinutes,
      alternatives: [early, late],
      timeZone,
      message: `本地时间 ${wallStr} 在 ${timeZone} 因夏令时回拨对应两个瞬间，已默认取较早者 ${new Date(early).toISOString()}，另一候选为 ${new Date(late).toISOString()}`,
    };
  }

  if (candidates.length === 1) {
    return {
      status: 'ok',
      instant: candidates[0],
      offsetMinutes: formatInZone(candidates[0], timeZone).offsetMinutes,
      alternatives: [],
      timeZone,
      message: null,
    };
  }

  // 前跳缺口：挂钟时间不存在。取候选偏移中较小者（跳转前侧，时钟拨快前）
  // 反推得到起点，再按时间流逝逐秒推进到第一个挂钟时间 >= wallStr 的有效瞬间
  const beforeOffset = Math.min(...offsets);
  const startInstant = pseudoUtc - beforeOffset * MINUTE_MS;
  let cursor = startInstant;
  for (let i = 0; i < 3 * 3600; i += 1) {
    if (wallAt(cursor) >= wallStr) break;
    cursor += 1000;
  }
  const fb = formatInZone(cursor, timeZone);
  return {
    status: 'gap',
    instant: cursor,
    offsetMinutes: fb.offsetMinutes,
    alternatives: [],
    timeZone,
    message: `本地时间 ${wallStr} 在 ${timeZone} 因夏令时前跳而不存在，已顺延至跳转后首个有效瞬间 ${fb.wall}（${offsetLabel(fb.offsetMinutes)}）`,
  };
}

/** 展示用：瞬间 + 时区 -> "2026-11-20 09:00:00 UTC+08:00"。 */
export function formatInstant(instant, timeZone = 'UTC') {
  const { wall, offsetMinutes } = formatInZone(instant, timeZone);
  const [date, time] = wall.split('T');
  return `${date} ${time} ${offsetLabel(offsetMinutes)}`;
}
