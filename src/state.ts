import fs from 'fs';
import path from 'path';
import { SyncState } from './types';

export function loadState(statePath: string): SyncState {
    try {
        return JSON.parse(fs.readFileSync(statePath, 'utf-8')) as SyncState;
    } catch {
        return { lastSync: '', files: {} };
    }
}

export function saveState(state: SyncState, statePath: string): void {
    const dir = path.dirname(statePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmp, statePath);
}
