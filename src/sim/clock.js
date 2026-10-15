// Sim time. 1 tick = 100 ms of sim time at 1x speed; 50 ticks = 1 month; 12 months = 1 year.
// The year starts in early spring: months 0-2 spring, 3-5 summer, 6-8 autumn, 9-11 winter.

export const TICK_SECONDS = 0.1;
export const TICKS_PER_MONTH = 50;
export const MONTHS_PER_YEAR = 12;
export const TICKS_PER_YEAR = TICKS_PER_MONTH * MONTHS_PER_YEAR;
export const SEASON_NAMES = ['spring', 'summer', 'autumn', 'winter'];

export function createTime() {
  return {tick: 0, month: 0, year: 0, acc: 0, jobs: []};
}

// Advance one tick. Returns a bit set of rollovers that happened on this tick.
export const ROLL_MONTH = 1;
export const ROLL_QUARTER = 2;
export const ROLL_YEAR = 4;

export function advanceTick(time) {
  time.tick++;
  if (time.tick % TICKS_PER_MONTH !== 0) return 0;
  let flags = ROLL_MONTH;
  time.month++;
  if (time.month % 3 === 0) flags |= ROLL_QUARTER;
  if (time.month >= MONTHS_PER_YEAR) {
    time.month = 0;
    time.year++;
    flags |= ROLL_YEAR;
  }
  return flags;
}

// Absolute month count since the start; handy for cooldowns and expiry.
export const monthIndex = (time) => time.year * MONTHS_PER_YEAR + time.month;

// Sim seconds since the start, including the part of a tick not yet stepped.
export const simSeconds = (time) => time.tick * TICK_SECONDS + (time.acc ?? 0);

export const season = (month) => Math.floor(month / 3) % 4;

// Visual time descriptors for the renderer and UI.
export function timeView(time) {
  const monthT = (time.tick % TICKS_PER_MONTH + (time.acc ?? 0) / TICK_SECONDS) / TICKS_PER_MONTH;
  const yearT = (time.month + monthT) / MONTHS_PER_YEAR;
  const s = season(time.month);
  const seasonT = ((time.month % 3) + monthT) / 3;
  return {year: time.year, month: time.month, season: s, seasonName: SEASON_NAMES[s], seasonT, yearT, monthT};
}

// Baseline weather, rolled once a month: showers in spring and autumn, snow in
// winter, a slowly turning wind. Events (floods, droughts) may override it by setting
// weather.event = {rain?, snow?, untilMonth}.
const RAIN_CHANCE = [0.45, 0.2, 0.5, 0.3];

export function rollWeather(weather, month, rand, absMonth) {
  if (weather.event && weather.event.untilMonth >= absMonth) {
    weather.rain = weather.event.rain ?? weather.rain;
    weather.snow = weather.event.snow ?? weather.snow;
    return weather;
  }
  weather.event = null;
  const s = season(month);
  const wet = rand() < RAIN_CHANCE[s];
  const snowy = s === 3 && rand() < 0.55;
  weather.snow = snowy ? 0.35 + rand() * 0.6 : 0;
  weather.rain = wet && !snowy ? 0.25 + rand() * 0.6 : 0;
  const angle = Math.atan2(weather.wind[1], weather.wind[0]) + (rand() - 0.5) * 0.8;
  const strength = 0.3 + rand() * 0.7;
  weather.wind = [Math.cos(angle) * strength, Math.sin(angle) * strength];
  return weather;
}
