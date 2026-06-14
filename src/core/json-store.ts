import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';
import type { VersionedDocumentType } from './migration.js';
import { loadVersionedJsonFile, saveVersionedJsonFile } from './migration.js';

export interface JsonStoreOptions<T> {
  dirPath: string;
  documentType: VersionedDocumentType;
  getId: (item: T) => string;
  sort?: (left: T, right: T) => number;
}

export class JsonStore<T> {
  private readonly dirPath: string;
  private readonly documentType: VersionedDocumentType;
  private readonly getId: (item: T) => string;
  private readonly sort?: (left: T, right: T) => number;

  constructor(options: JsonStoreOptions<T>) {
    this.dirPath = options.dirPath;
    this.documentType = options.documentType;
    this.getId = options.getId;
    this.sort = options.sort;
  }

  list(): T[] {
    if (!fs.existsSync(this.dirPath)) {
      return [];
    }

    const items: T[] = [];
    for (const file of fs.readdirSync(this.dirPath).filter((entry) => entry.endsWith('.json')).sort()) {
      try {
        items.push(this.load(file.replace(/\.json$/i, '')));
      } catch (error) {
        logger.debug(`Skipping malformed ${this.documentType} file:`, file, error);
      }
    }

    if (this.sort) {
      items.sort(this.sort);
    }
    return items;
  }

  load(id: string): T {
    const filepath = this.pathFor(id);
    if (!fs.existsSync(filepath)) {
      throw new Error(`${this.documentType} '${id}' not found`);
    }
    return loadVersionedJsonFile<T>(this.documentType, filepath).document;
  }

  save(item: T): void {
    this.ensureDir();
    saveVersionedJsonFile(this.documentType, this.pathFor(this.getId(item)), item);
  }

  delete(id: string): void {
    const filepath = this.pathFor(id);
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath);
    }
  }

  exists(id: string): boolean {
    return fs.existsSync(this.pathFor(id));
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.dirPath)) {
      fs.mkdirSync(this.dirPath, { recursive: true });
    }
  }

  private pathFor(id: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new Error(`Invalid ${this.documentType} id '${id}'`);
    }

    const root = path.resolve(this.dirPath);
    const filepath = path.resolve(root, `${id}.json`);
    const relative = path.relative(root, filepath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Invalid ${this.documentType} id '${id}'`);
    }
    return filepath;
  }
}
