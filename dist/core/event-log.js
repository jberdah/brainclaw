import fs from 'node:fs';
import path from 'node:path';
import { memoryDir } from './io.js';
import { nowISO } from './ids.js';
import { logger } from './logger.js';
const EVENT_LOG_FILE = 'events.jsonl';
const CURSORS_DIR = '.cursors';
// --- Writer ---
export function appendEvent(event, cwd) {
    try {
        const full = {
            ts: event.ts ?? nowISO(),
            agent: event.agent ?? 'unknown',
            agent_id: event.agent_id,
            action: event.action,
            item_type: event.item_type,
            item_id: event.item_id,
            summary: event.summary,
        };
        const line = JSON.stringify(Object.fromEntries(Object.entries(full).filter(([, v]) => v !== undefined)));
        const logPath = eventLogPath(cwd);
        fs.appendFileSync(logPath, line + '\n', 'utf-8');
    }
    catch (err) {
        logger.debug('Failed to write event log entry:', err);
    }
}
// --- Reader ---
export function readAllEvents(cwd) {
    const logPath = eventLogPath(cwd);
    if (!fs.existsSync(logPath))
        return [];
    const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
    const events = [];
    for (const line of lines) {
        try {
            events.push(JSON.parse(line));
        }
        catch {
            // skip malformed
        }
    }
    return events;
}
function cursorsDir(cwd) {
    return path.join(memoryDir(cwd), CURSORS_DIR);
}
function cursorPath(agent, cwd) {
    return path.join(cursorsDir(cwd), `${agent}.json`);
}
function loadCursor(agent, cwd) {
    const fp = cursorPath(agent, cwd);
    if (!fs.existsSync(fp))
        return { offset: 0, last_read: '' };
    try {
        return JSON.parse(fs.readFileSync(fp, 'utf-8'));
    }
    catch {
        return { offset: 0, last_read: '' };
    }
}
function saveCursor(agent, cursor, cwd) {
    const dir = cursorsDir(cwd);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(cursorPath(agent, cwd), JSON.stringify(cursor), 'utf-8');
}
/**
 * Read events unseen by this agent since their last read.
 * Updates the cursor after reading.
 */
export function readUnseenEvents(agent, cwd) {
    const logPath = eventLogPath(cwd);
    if (!fs.existsSync(logPath))
        return [];
    const cursor = loadCursor(agent, cwd);
    const stat = fs.statSync(logPath);
    if (stat.size <= cursor.offset)
        return [];
    // Read from offset
    const fd = fs.openSync(logPath, 'r');
    const buffer = Buffer.alloc(stat.size - cursor.offset);
    fs.readSync(fd, buffer, 0, buffer.length, cursor.offset);
    fs.closeSync(fd);
    const newContent = buffer.toString('utf-8');
    const lines = newContent.split('\n').filter(Boolean);
    const events = [];
    for (const line of lines) {
        try {
            const evt = JSON.parse(line);
            // Exclude events from self
            if (evt.agent !== agent) {
                events.push(evt);
            }
        }
        catch {
            // skip
        }
    }
    // Update cursor
    saveCursor(agent, { offset: stat.size, last_read: nowISO() }, cwd);
    return events;
}
/**
 * Build a compact notification summary from unseen events.
 */
export function buildNotificationSummary(events) {
    if (events.length === 0)
        return undefined;
    const summary = {};
    for (const evt of events) {
        const key = `${evt.action}:${evt.item_type}`;
        summary[key] = (summary[key] ?? 0) + 1;
    }
    return summary;
}
// --- Rotation ---
const MAX_EVENT_LOG_BYTES = 10 * 1024 * 1024; // 10MB
/**
 * Check if the event log needs rotation. Returns true if rotated.
 */
export function rotateEventLogIfNeeded(cwd) {
    const logPath = eventLogPath(cwd);
    if (!fs.existsSync(logPath))
        return false;
    const stat = fs.statSync(logPath);
    if (stat.size < MAX_EVENT_LOG_BYTES)
        return false;
    try {
        const archiveName = `events.${Date.now()}.jsonl`;
        const archivePath = path.join(memoryDir(cwd), archiveName);
        fs.renameSync(logPath, archivePath);
        // Reset all cursors
        const dir = cursorsDir(cwd);
        if (fs.existsSync(dir)) {
            for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
                fs.unlinkSync(path.join(dir, file));
            }
        }
        return true;
    }
    catch (err) {
        logger.debug('Failed to rotate event log:', err);
        return false;
    }
}
// --- Helpers ---
function eventLogPath(cwd) {
    return path.join(memoryDir(cwd), EVENT_LOG_FILE);
}
//# sourceMappingURL=event-log.js.map