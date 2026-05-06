import os from 'os';
import fs from 'fs';
import path from 'path';
import type { drive_v3 } from 'googleapis';
import { resolveOrCreateFolderPath } from '../../proton-drive-cli/src/sdk/path';
import type { ProtonDriveClient } from '@protontech/drive-sdk';
import * as GDrive from './gdrive';
import { workspaceLinkContent } from './gdrive';
import * as Proton from './proton';
import { loadState, saveState } from './state';
import type { FileEntry, GDriveFile, ProtonFile, SyncOptions, SyncState, SyncStats } from './types';

async function withConcurrency(items: string[], concurrency: number, fn: (item: string) => Promise<void>): Promise<void> {
    const queue = [...items];
    await Promise.all(
        Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
            while (queue.length > 0) {
                await fn(queue.shift()!);
            }
        }),
    );
}

export async function runSync(
    drive: drive_v3.Drive,
    client: ProtonDriveClient,
    gdriveFolderId: string,
    protonFolderPath: string,
    statePath: string,
    options: SyncOptions,
): Promise<void> {
    const state = loadState(statePath);

    GDrive.clearFolderCache();

    console.log('Listing Google Drive files...');
    const gdriveFolderIds = new Map<string, string>();
    const gdriveFiles = await GDrive.listRecursive(drive, gdriveFolderId, '', gdriveFolderIds, options.ignore);
    console.log(`  Found ${gdriveFiles.size} files`);

    console.log('Listing Proton Drive files...');
    const protonRootUid = await resolveOrCreateFolderPath(client, protonFolderPath);
    const protonFolderUids = new Map<string, string>();
    const protonFiles = await Proton.listRecursive(client, protonRootUid, '', protonFolderUids, options.ignore);
    console.log(`  Found ${protonFiles.size} files`);

    const allPaths = new Set([
        ...gdriveFiles.keys(),
        ...protonFiles.keys(),
        ...Object.keys(state.files),
    ]);

    const stats: SyncStats = { uploaded: 0, downloaded: 0, skipped: 0, deleted: 0, conflicts: 0, errors: 0 };
    const newState: SyncState = { lastSync: new Date().toISOString(), files: {} };

    console.log(`\nProcessing ${allPaths.size} paths (concurrency: ${options.concurrency})...\n`);

    await withConcurrency([...allPaths], options.concurrency, async (rel) => {
        const g = gdriveFiles.get(rel);
        const p = protonFiles.get(rel);
        const s = state.files[rel];

        try {
            if (g && p) {
                await handleBothPresent(drive, client, rel, g, p, s, gdriveFolderId, protonFolderPath, newState, stats, options);
            } else if (g) {
                await handleGDriveOnly(drive, client, rel, g, s, protonFolderPath, newState, stats, options);
            } else if (p) {
                await handleProtonOnly(drive, client, rel, p, s, gdriveFolderId, newState, stats, options);
            }
            // !g && !p && s: deleted from both, omit from newState (entry disappears)
        } catch (err) {
            console.error(`  ERROR [${rel}]: ${(err as Error).message}`);
            stats.errors++;
            if (s) newState.files[rel] = s;
        }
    });

    if (options.delete) {
        await cleanupEmptyFolders(client, drive, protonFolderUids, gdriveFolderIds, newState, stats, options.dryRun);
    }

    if (!options.dryRun) {
        saveState(newState, statePath);
    }

    console.log(
        `\nDone: ${stats.uploaded} uploaded, ${stats.downloaded} downloaded, ` +
        `${stats.skipped} skipped, ${stats.deleted} deleted, ` +
        `${stats.conflicts} conflicts, ${stats.errors} errors`,
    );
}

async function cleanupEmptyFolders(
    client: ProtonDriveClient,
    drive: drive_v3.Drive,
    protonFolderUids: Map<string, string>,
    gdriveFolderIds: Map<string, string>,
    newState: SyncState,
    stats: SyncStats,
    dryRun: boolean,
): Promise<void> {
    // Dirs that still have at least one file remaining after sync
    const activeDirs = new Set<string>();
    for (const filePath of Object.keys(newState.files)) {
        let dir = path.dirname(filePath);
        while (dir !== '.') {
            activeDirs.add(dir);
            dir = path.dirname(dir);
        }
    }

    // Delete deepest folders first so parents are empty by the time we reach them
    const byDepthDesc = (a: string, b: string) => b.split('/').length - a.split('/').length;

    const emptyProtonDirs = [...protonFolderUids.keys()]
        .filter(dir => !activeDirs.has(dir))
        .sort(byDepthDesc);

    for (const dir of emptyProtonDirs) {
        console.log(`  delete Proton folder  ${dir}  (empty)`);
        if (!dryRun) await Proton.trashFile(client, protonFolderUids.get(dir)!);
        stats.deleted++;
    }

    const emptyGDriveDirs = [...gdriveFolderIds.keys()]
        .filter(dir => !activeDirs.has(dir))
        .sort(byDepthDesc);

    for (const dir of emptyGDriveDirs) {
        console.log(`  delete GDrive folder  ${dir}  (empty)`);
        if (!dryRun) await GDrive.trashFile(drive, gdriveFolderIds.get(dir)!);
        stats.deleted++;
    }
}

async function handleBothPresent(
    drive: drive_v3.Drive,
    client: ProtonDriveClient,
    rel: string,
    g: GDriveFile,
    p: ProtonFile,
    s: FileEntry | undefined,
    gdriveFolderId: string,
    protonFolderPath: string,
    newState: SyncState,
    stats: SyncStats,
    options: SyncOptions,
): Promise<void> {
    if (g.size === p.size) {
        newState.files[rel] = { size: g.size, googleId: g.id, protonUid: p.uid };
        stats.skipped++;
        return;
    }

    if (!s) {
        // First sync with size mismatch: GDrive wins
        console.log(`  GDrive → Proton   ${rel}  (first sync, sizes differ)`);
        if (!options.dryRun) {
            await Proton.trashFile(client, p.uid);
            const newUid = await copyGDriveToProton(drive, client, g, rel, protonFolderPath);
            newState.files[rel] = { size: g.size, googleId: g.id, protonUid: newUid };
        }
        stats.uploaded++;
        return;
    }

    if (s.size === p.size) {
        // GDrive changed, Proton unchanged
        console.log(`  GDrive → Proton   ${rel}  (GDrive copy is newer)`);
        if (!options.dryRun) {
            await Proton.trashFile(client, p.uid);
            const newUid = await copyGDriveToProton(drive, client, g, rel, protonFolderPath);
            newState.files[rel] = { size: g.size, googleId: g.id, protonUid: newUid };
        }
        stats.uploaded++;
    } else if (s.size === g.size) {
        // Proton changed, GDrive unchanged
        console.log(`  Proton → GDrive   ${rel}  (Proton copy is newer)`);
        if (!options.dryRun) {
            const newGId = await copyProtonToGDrive(client, drive, p, rel, g.id, gdriveFolderId);
            newState.files[rel] = { size: p.size, googleId: newGId, protonUid: p.uid };
        }
        stats.downloaded++;
    } else {
        // Conflict: both changed since last sync — Proton wins
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const ext = path.extname(rel);
        const base = rel.slice(0, rel.length - ext.length);
        const backupName = path.basename(`${base}.conflict-backup-${timestamp}${ext}`);
        console.warn(`  conflict         ${rel}  (both changed; Proton wins, GDrive renamed to ${backupName})`);
        stats.conflicts++;

        if (!options.dryRun) {
            // Rename the GDrive file to backup before overwriting
            await GDrive.renameFile(drive, g.id, backupName);
            // Upload Proton version to GDrive as the original name
            const parentFolderId = await getGDriveParentFolderId(drive, gdriveFolderId, rel);
            const newGId = await copyProtonToGDriveNew(client, drive, p, rel, parentFolderId);
            newState.files[rel] = { size: p.size, googleId: newGId, protonUid: p.uid };
        }
    }
}

async function handleGDriveOnly(
    drive: drive_v3.Drive,
    client: ProtonDriveClient,
    rel: string,
    g: GDriveFile,
    s: FileEntry | undefined,
    protonFolderPath: string,
    newState: SyncState,
    stats: SyncStats,
    options: SyncOptions,
): Promise<void> {
    if (s) {
        // Was synced before, now missing from Proton → deleted from Proton
        if (options.delete) {
            console.log(`  delete GDrive     ${rel}  (removed from Proton)`);
            if (!options.dryRun) await GDrive.trashFile(drive, g.id);
            stats.deleted++;
        } else {
            console.log(`  skip delete       ${rel}  (removed from Proton; rerun with --delete to propagate)`);
            newState.files[rel] = s;
            stats.skipped++;
        }
    } else {
        // New on GDrive, not yet on Proton
        console.log(`  GDrive → Proton   ${rel}  (new file)`);
        if (!options.dryRun) {
            const newUid = await copyGDriveToProton(drive, client, g, rel, protonFolderPath);
            newState.files[rel] = { size: g.size, googleId: g.id, protonUid: newUid };
        }
        stats.uploaded++;
    }
}

async function handleProtonOnly(
    drive: drive_v3.Drive,
    client: ProtonDriveClient,
    rel: string,
    p: ProtonFile,
    s: FileEntry | undefined,
    gdriveFolderId: string,
    newState: SyncState,
    stats: SyncStats,
    options: SyncOptions,
): Promise<void> {
    if (s) {
        // Was synced before, now missing from GDrive → deleted from GDrive
        if (options.delete) {
            console.log(`  delete Proton     ${rel}  (removed from GDrive)`);
            if (!options.dryRun) await Proton.trashFile(client, p.uid);
            stats.deleted++;
        } else {
            console.log(`  skip delete       ${rel}  (removed from GDrive; rerun with --delete to propagate)`);
            newState.files[rel] = s;
            stats.skipped++;
        }
    } else {
        // New on Proton, not yet on GDrive
        console.log(`  Proton → GDrive   ${rel}  (new file)`);
        if (!options.dryRun) {
            const parentFolderId = await getGDriveParentFolderId(drive, gdriveFolderId, rel);
            const newGId = await copyProtonToGDriveNew(client, drive, p, rel, parentFolderId);
            newState.files[rel] = { size: p.size, googleId: newGId, protonUid: p.uid };
        }
        stats.downloaded++;
    }
}

async function copyGDriveToProton(
    drive: drive_v3.Drive,
    client: ProtonDriveClient,
    g: GDriveFile,
    rel: string,
    protonFolderPath: string,
): Promise<string> {
    const tmp = path.join(os.tmpdir(), `gdrive-proton-${Date.now()}-${path.basename(rel)}`);
    try {
        if (g.webViewLink) {
            fs.writeFileSync(tmp, workspaceLinkContent(g.webViewLink), 'utf-8');
        } else {
            await GDrive.downloadFile(drive, g.id, tmp);
        }
        const dir = path.dirname(rel);
        const parentPath = dir === '.' ? protonFolderPath : `${protonFolderPath}/${dir}`;
        return await Proton.uploadFile(client, tmp, parentPath, path.basename(rel));
    } finally {
        fs.rmSync(tmp, { force: true });
    }
}

// Replace existing GDrive file content (same ID) with content from Proton
async function copyProtonToGDrive(
    client: ProtonDriveClient,
    drive: drive_v3.Drive,
    p: ProtonFile,
    rel: string,
    existingGDriveId: string,
    gdriveFolderId: string,
): Promise<string> {
    const tmp = path.join(os.tmpdir(), `gdrive-proton-${Date.now()}-${path.basename(rel)}`);
    try {
        await Proton.downloadFile(client, p.uid, tmp);
        await GDrive.updateFile(drive, existingGDriveId, tmp);
        return existingGDriveId;
    } finally {
        fs.rmSync(tmp, { force: true });
    }
}

// Upload Proton file as a new GDrive file (no existing ID)
async function copyProtonToGDriveNew(
    client: ProtonDriveClient,
    drive: drive_v3.Drive,
    p: ProtonFile,
    rel: string,
    parentFolderId: string,
): Promise<string> {
    const tmp = path.join(os.tmpdir(), `gdrive-proton-${Date.now()}-${path.basename(rel)}`);
    try {
        await Proton.downloadFile(client, p.uid, tmp);
        return await GDrive.uploadFile(drive, tmp, parentFolderId, path.basename(rel));
    } finally {
        fs.rmSync(tmp, { force: true });
    }
}

async function getGDriveParentFolderId(
    drive: drive_v3.Drive,
    rootFolderId: string,
    rel: string,
): Promise<string> {
    const dir = path.dirname(rel);
    if (dir === '.') return rootFolderId;
    return GDrive.getOrCreateFolderPath(drive, rootFolderId, dir);
}
