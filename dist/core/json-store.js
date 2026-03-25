import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';
import { loadVersionedJsonFile, saveVersionedJsonFile } from './migration.js';
export class JsonStore {
    dirPath;
    documentType;
    getId;
    sort;
    constructor(options) {
        this.dirPath = options.dirPath;
        this.documentType = options.documentType;
        this.getId = options.getId;
        this.sort = options.sort;
    }
    list() {
        if (!fs.existsSync(this.dirPath)) {
            return [];
        }
        const items = [];
        for (const file of fs.readdirSync(this.dirPath).filter((entry) => entry.endsWith('.json')).sort()) {
            try {
                items.push(this.load(file.replace(/\.json$/i, '')));
            }
            catch (error) {
                logger.debug(`Skipping malformed ${this.documentType} file:`, file, error);
            }
        }
        if (this.sort) {
            items.sort(this.sort);
        }
        return items;
    }
    load(id) {
        const filepath = this.pathFor(id);
        if (!fs.existsSync(filepath)) {
            throw new Error(`${this.documentType} '${id}' not found`);
        }
        return loadVersionedJsonFile(this.documentType, filepath).document;
    }
    save(item) {
        this.ensureDir();
        saveVersionedJsonFile(this.documentType, this.pathFor(this.getId(item)), item);
    }
    delete(id) {
        const filepath = this.pathFor(id);
        if (fs.existsSync(filepath)) {
            fs.unlinkSync(filepath);
        }
    }
    exists(id) {
        return fs.existsSync(this.pathFor(id));
    }
    ensureDir() {
        if (!fs.existsSync(this.dirPath)) {
            fs.mkdirSync(this.dirPath, { recursive: true });
        }
    }
    pathFor(id) {
        return path.join(this.dirPath, `${id}.json`);
    }
}
//# sourceMappingURL=json-store.js.map