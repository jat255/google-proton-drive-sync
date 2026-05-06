import fs from 'fs';
import path from 'path';
import type { drive_v3 } from 'googleapis';
import type { ProtonDriveClient } from '@protontech/drive-sdk';
import { resolveOrCreateFolderPath } from '../../proton-drive-cli/src/sdk/path';
import * as GDrive from './gdrive';
import { workspaceLinkContent } from './gdrive';
import * as Proton from './proton';

export interface DownloadOptions {
    concurrency: number;
    ignore: string[];
}

interface DownloadStats {
    downloaded: number;
    skipped: number;
    errors: number;
}

export async function runDownload(
    drive: drive_v3.Drive,
    client: ProtonDriveClient,
    gdriveFolderId: string,
    protonFolderPath: string,
    outputDir: string,
    options: DownloadOptions,
): Promise<void> {
    const gdriveOut = path.join(outputDir, 'gdrive');
    const protonOut = path.join(outputDir, 'proton');
    fs.mkdirSync(gdriveOut, { recursive: true });
    fs.mkdirSync(protonOut, { recursive: true });

    GDrive.clearFolderCache();

    console.log('Listing Google Drive files...');
    const gdriveFiles = await GDrive.listRecursive(drive, gdriveFolderId, '', undefined, options.ignore);
    console.log(`  Found ${gdriveFiles.size} files`);

    console.log('Listing Proton Drive files...');
    const protonRootUid = await resolveOrCreateFolderPath(client, protonFolderPath);
    const protonFiles = await Proton.listRecursive(client, protonRootUid, '', undefined, options.ignore);
    console.log(`  Found ${protonFiles.size} files\n`);

    const stats: DownloadStats = { downloaded: 0, skipped: 0, errors: 0 };

    await withConcurrency([...gdriveFiles.entries()], options.concurrency, async ([rel, g]) => {
        const dest = path.join(gdriveOut, rel);
        if (fs.existsSync(dest) && fs.statSync(dest).size === g.size) {
            console.log(`  skip (up to date)  gdrive/${rel}`);
            stats.skipped++;
            return;
        }
        try {
            console.log(`  gdrive → local     gdrive/${rel}`);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            if (g.webViewLink) {
                fs.writeFileSync(dest, workspaceLinkContent(g.webViewLink), 'utf-8');
            } else {
                await GDrive.downloadFile(drive, g.id, dest);
            }
            stats.downloaded++;
        } catch (err) {
            console.error(`  ERROR gdrive/${rel}: ${(err as Error).message}`);
            stats.errors++;
        }
    });

    await withConcurrency([...protonFiles.entries()], options.concurrency, async ([rel, p]) => {
        const dest = path.join(protonOut, rel);
        if (fs.existsSync(dest) && fs.statSync(dest).size === p.size) {
            console.log(`  skip (up to date)  proton/${rel}`);
            stats.skipped++;
            return;
        }
        try {
            console.log(`  proton → local     proton/${rel}`);
            await Proton.downloadFile(client, p.uid, dest);
            stats.downloaded++;
        } catch (err) {
            console.error(`  ERROR proton/${rel}: ${(err as Error).message}`);
            stats.errors++;
        }
    });

    console.log(`\nDone: ${stats.downloaded} downloaded, ${stats.skipped} skipped, ${stats.errors} errors`);
    console.log(`Output: ${path.resolve(outputDir)}`);
}

async function withConcurrency<T>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<void>,
): Promise<void> {
    const queue = [...items];
    await Promise.all(
        Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
            while (queue.length > 0) await fn(queue.shift()!);
        }),
    );
}
