// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#byteOffset=2647013 (pgn relative timestamp)
// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#byteOffset=2708451 (M2n capitalization)
// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#byteOffset=2708511 (J2n status mapping)
// @evidence src/app/dist/renderer/assets/index-UbX-y3il.js#byteOffset=2718133 (Run history / No runs yet branch)

import type { RoutineRun } from "./controller";

export interface RoutineRunPresentation {
  readonly id: string;
  readonly title?: string;
  readonly timestampLabel: string;
  readonly status: RoutineRun["status"];
  readonly ariaLabel: "Выполняется" | "Успешно" | "Ошибка";
  readonly iconName: "loading" | "check" | "close";
  readonly statusRole?: "status";
}

export interface RoutineRunHistoryPresentation {
  readonly empty: boolean;
  readonly rows: readonly RoutineRunPresentation[];
}

interface ZonedParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly weekday: number;
  readonly hour: number;
  readonly minute: number;
}

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа", "сентября", "октября", "ноября", "декабря"] as const;
const WEEKDAYS = ["воскресенье", "понедельник", "вторник", "среда", "четверг", "пятница", "суббота"] as const;

/** Русские окончания для числа: 1 минута, 2 минуты, 5 минут. */
function minuteWord(count: number): string {
  const mod100 = Math.abs(count) % 100, mod10 = mod100 % 10;
  return mod100 >= 11 && mod100 <= 14 ? "минут"
    : mod10 === 1 ? "минуту"
    : mod10 >= 2 && mod10 <= 4 ? "минуты"
    : "минут";
}

function zonedParts(timestamp: number, timeZone?: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat("ru-RU", {
    ...(timeZone == null ? {} : { timeZone }),
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: false
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const weekday = WEEKDAYS.indexOf(parts.weekday as typeof WEEKDAYS[number]);
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: weekday < 0 ? new Date(timestamp).getDay() : weekday,
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute)
  };
}

function dateKey(timestamp: number, timeZone?: string): number {
  const parts = zonedParts(timestamp, timeZone);
  return Date.UTC(parts.year, parts.month - 1, parts.day);
}

function clock(parts: ZonedParts): string {
  const hour = parts.hour % 12 === 0 ? 12 : parts.hour % 12;
  return `${hour}:${String(parts.minute).padStart(2, "0")} ${parts.hour < 12 ? "утра" : "вечера"}`;
}

/** Mirrors the immutable pgn + M2n relative timestamp branch. */
export function formatRoutineRunTimestamp(startedAt: number, now: number, timeZone?: string): string {
  const difference = startedAt - now;
  let result: string;
  if (difference > 0 && difference < 60 * 60 * 1000) result = `через ${Math.ceil(difference / (60 * 1000))} ${minuteWord(Math.ceil(difference / (60 * 1000)))}`;
  else if (difference <= 0 && -difference < 60 * 1000) result = "только что";
  else if (difference <= 0 && -difference < 60 * 60 * 1000) {
    const minutes = Math.floor(-difference / (60 * 1000));
    result = `${minutes} ${minuteWord(minutes)} назад`;
  }
  else {
    const current = zonedParts(now, timeZone);
    const started = zonedParts(startedAt, timeZone);
    const dayDifference = Math.round((dateKey(startedAt, timeZone) - dateKey(now, timeZone)) / (24 * 60 * 60 * 1000));
    if (dayDifference === 0) result = `сегодня в ${clock(started)}`;
    else if (dayDifference === 1) result = `завтра в ${clock(started)}`;
    else if (dayDifference === -1) result = `вчера в ${clock(started)}`;
    else if (dayDifference > 1 && dayDifference < 7) result = `${WEEKDAYS[started.weekday]} в ${clock(started)}`;
    else if (dayDifference < -1 && dayDifference > -7) result = `${WEEKDAYS[started.weekday]} на прошлой неделе в ${clock(started)}`;
    else {
      const date = `${MONTHS[started.month - 1]} ${started.day}`;
      result = started.year === current.year ? `${date} в ${clock(started)}` : `${date} ${started.year} г. в ${clock(started)}`;
    }
  }
  return result.charAt(0).toUpperCase() + result.slice(1);
}

export function presentRoutineRun(run: RoutineRun, now: number, timeZone?: string): RoutineRunPresentation {
  switch (run.status) {
    case "running": return { id: run.id, ...(run.detail ?? run.event) == null ? {} : { title: run.detail ?? run.event ?? undefined }, timestampLabel: formatRoutineRunTimestamp(run.startedAt, now, timeZone), status: run.status, ariaLabel: "Выполняется", iconName: "loading", statusRole: "status" };
    case "ok": return { id: run.id, ...(run.detail ?? run.event) == null ? {} : { title: run.detail ?? run.event ?? undefined }, timestampLabel: formatRoutineRunTimestamp(run.startedAt, now, timeZone), status: run.status, ariaLabel: "Успешно", iconName: "check" };
    case "error": return { id: run.id, ...(run.detail ?? run.event) == null ? {} : { title: run.detail ?? run.event ?? undefined }, timestampLabel: formatRoutineRunTimestamp(run.startedAt, now, timeZone), status: run.status, ariaLabel: "Ошибка", iconName: "close" };
  }
}

/** Pure branch for the immutable `runs.length > 0 ? <ul> : No runs yet` view. */
export function presentRoutineRunHistory(runs: readonly RoutineRun[], now: number, timeZone?: string): RoutineRunHistoryPresentation {
  return runs.length === 0 ? { empty: true, rows: [] } : { empty: false, rows: runs.map((run) => presentRoutineRun(run, now, timeZone)) };
}

