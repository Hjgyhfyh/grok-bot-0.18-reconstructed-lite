/**
 * Скиллы отчётов: список и чтение текста из папки `skills/`.
 *
 * Файлы скиллов — обычный markdown без YAML-разметки. Заголовок вида
 * `# Скилл: ФДБ — Милосердие (свод отчётов отделов)` даёт название, раздел
 * `## Описание` — короткое пояснение для списка.
 *
 * Путь к папке приходит снаружи, а не зашит в коде: в упакованном `.asar`
 * константа с путём не найдётся.
 *
 * Порт: Graphite Lite `ai/skills.rs:15-24, 173-184, 211-227`.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export interface SkillSummary {
  /** Имя файла без расширения — это и есть аргумент `skill_read`. */
  readonly slug: string;
  readonly title: string;
  readonly summary: string;
  readonly fileName: string;
}

const SUMMARY_LIMIT = 300;

function firstHeading(markdown: string): string | null {
  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith("# ")) return line.slice(2).trim();
  }
  return null;
}

function section(markdown: string, name: string): string | null {
  const marker = new RegExp(`^##\\s+${name}\\s*$`, "im");
  const match = marker.exec(markdown);
  if (match === null) return null;
  const rest = markdown.slice(match.index + match[0].length);
  const next = /^##\s+/m.exec(rest);
  return (next === null ? rest : rest.slice(0, next.index)).trim();
}

function summarize(markdown: string, slug: string): string {
  const description = section(markdown, "Описание") ?? section(markdown, "Description");
  const flat = (description ?? "").replace(/\s+/g, " ").trim();
  if (flat.length === 0) return `Скилл «${slug}»: текст без раздела «Описание».`;
  return flat.length > SUMMARY_LIMIT ? `${flat.slice(0, SUMMARY_LIMIT)}…` : flat;
}

export function parseSkill(fileName: string, markdown: string): SkillSummary {
  const slug = fileName.replace(/\.md$/i, "");
  const heading = firstHeading(markdown) ?? slug;
  return {
    slug,
    title: heading.replace(/^Скилл:\s*/i, "").trim() || slug,
    summary: summarize(markdown, slug),
    fileName,
  };
}

async function markdownFiles(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw error;
  }
  return entries.filter((name) => name.toLowerCase().endsWith(".md")).sort();
}

export async function listSkills(dir: string): Promise<SkillSummary[]> {
  const files = await markdownFiles(dir);
  const summaries: SkillSummary[] = [];
  for (const fileName of files) {
    const markdown = await readFile(join(dir, fileName), "utf8");
    summaries.push(parseSkill(fileName, markdown));
  }
  return summaries;
}

export function formatSkillList(skills: readonly SkillSummary[]): string {
  if (skills.length === 0) return "Скиллов отчётов нет: папка skills пуста.";
  return [
    `Скиллы отчётов (${skills.length}):`,
    ...skills.map((skill) => `- ${skill.slug} — ${skill.title}: ${skill.summary}`),
    "",
    "Полный текст скилла: skill_read(name) — например skill_read(\"fdb-miloserdie\").",
  ].join("\n");
}

/** Ищет скилл по slug, по названию или по вхождению названия в запрос. */
export function findSkill(
  skills: readonly SkillSummary[],
  needle: string,
): SkillSummary | null {
  const trimmed = needle.trim();
  if (trimmed.length === 0) return null;
  const lower = trimmed.toLowerCase();
  const dashed = lower.replaceAll(" ", "-");
  return (
    skills.find((skill) => skill.slug.toLowerCase() === lower)
    ?? skills.find((skill) => skill.title.toLowerCase() === lower)
    ?? skills.find((skill) => skill.title.toLowerCase().includes(lower))
    ?? skills.find((skill) => skill.slug.toLowerCase().includes(dashed))
    ?? null
  );
}

export async function readSkill(dir: string, name: string): Promise<string> {
  const skills = await listSkills(dir);
  const skill = findSkill(skills, name);
  if (skill === null) {
    const known = skills.map((item) => item.slug).join(", ");
    throw new Error(
      `скилл «${name.trim()}» не найден — посмотри список через skill_list. Есть: ${known}`,
    );
  }
  return readFile(join(dir, skill.fileName), "utf8");
}
