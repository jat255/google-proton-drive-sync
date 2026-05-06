import fs from 'fs';
import path from 'path';
import os from 'os';

export interface Config {
    gdriveFolderId: string;
    protonFolderPath: string;
    googleCredentialsPath: string;
    googleTokenPath: string;
    statePath: string;
    protonConfigPath: string;
    concurrency: number;
    ignore: string[];
}

export function loadConfig(configPath: string): Config {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const c = JSON.parse(raw) as Partial<Config>;

    if (!c.gdriveFolderId) throw new Error('config: gdriveFolderId is required');
    if (!c.protonFolderPath) throw new Error('config: protonFolderPath is required');

    return {
        gdriveFolderId: c.gdriveFolderId,
        protonFolderPath: c.protonFolderPath,
        googleCredentialsPath: expandHome(c.googleCredentialsPath ?? '~/.config/gdrive-proton-sync/credentials.json'),
        googleTokenPath: expandHome(c.googleTokenPath ?? '~/.config/gdrive-proton-sync/token.json'),
        statePath: expandHome(c.statePath ?? '~/.config/gdrive-proton-sync/state.json'),
        protonConfigPath: expandHome(c.protonConfigPath ?? '~/.config/proton-drive/session.json'),
        concurrency: c.concurrency ?? 4,
        ignore: c.ignore ?? [],
    };
}

function expandHome(p: string): string {
    return p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p;
}
