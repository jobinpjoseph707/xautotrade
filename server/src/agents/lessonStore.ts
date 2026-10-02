import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { Lesson } from './lessons.js';
import type { Proposal } from './propose.js';

export interface LessonEntry {
  lesson: Lesson;
  proposal: Proposal;
  createdAt: string;
}

/** Append-only, ordered history of lessons and the config changes they produced. */
export class LessonStore {
  protected entries: LessonEntry[] = [];

  append(entry: LessonEntry): void {
    if (this.entries.some((e) => e.lesson.lessonId === entry.lesson.lessonId)) {
      throw new Error(`Lesson ${entry.lesson.lessonId} already exists and is immutable.`);
    }
    this.entries.push(Object.freeze(structuredClone(entry)));
    this.persist();
  }

  all(): LessonEntry[] {
    return [...this.entries];
  }

  /** Lessons for the week starting on this ISO date (YYYY-MM-DD prefix match). */
  byWeek(weekStart: string): LessonEntry[] {
    return this.entries.filter((e) => e.lesson.weekStart.startsWith(weekStart.slice(0, 10)));
  }

  /** Most recent n lessons, oldest first. */
  last(n: number): LessonEntry[] {
    return this.entries.slice(-n);
  }

  protected persist(): void {}
}

export class JsonFileLessonStore extends LessonStore {
  constructor(private readonly path: string) {
    super();
    if (existsSync(path)) {
      this.entries = (JSON.parse(readFileSync(path, 'utf8')) as LessonEntry[]).map((e) => Object.freeze(e));
    }
  }

  protected override persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.entries, null, 2));
    renameSync(tmp, this.path);
  }
}
