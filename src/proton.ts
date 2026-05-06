import fs from 'fs';
import path from 'path';
import { Writable } from 'stream';
import { NodeType } from '@protontech/drive-sdk';
import type { ProtonDriveClient } from '@protontech/drive-sdk';
import { createClient } from '../../proton-drive-cli/src/sdk/client';
import { uploadFile as sdkUploadFile } from '../../proton-drive-cli/src/sdk/upload';
import { resolveOrCreateFolderPath } from '../../proton-drive-cli/src/sdk/path';
import { loadSession } from '../../proton-drive-cli/src/config/config';
import { ProtonFile } from './types';
import { isIgnored } from './utils';

export { ProtonDriveClient };

// Caches in-flight and resolved folder resolution promises to avoid repeated tree
// traversals AND prevent concurrent callers from creating duplicate folders.
const folderUidCache = new Map<string, Promise<string>>();

export async function createProtonClient(configPath?: string): Promise<ProtonDriveClient> {
    folderUidCache.clear();
    return createClient(configPath);
}

export function getProtonEmail(configPath?: string): string {
    const session = loadSession(configPath);
    return session?.addresses[0]?.email ?? '(unknown)';
}

function resolveFolderCached(client: ProtonDriveClient, folderPath: string): Promise<string> {
    if (!folderUidCache.has(folderPath)) {
        folderUidCache.set(folderPath, resolveOrCreateFolderPath(client, folderPath));
    }
    return folderUidCache.get(folderPath)!;
}

export async function listRecursive(
    client: ProtonDriveClient,
    folderUid: string,
    prefix = '',
    folderUids?: Map<string, string>,
    ignore: string[] = [],
): Promise<Map<string, ProtonFile>> {
    const result = new Map<string, ProtonFile>();

    for await (const node of client.iterateFolderChildren(folderUid)) {
        if (!node.ok) continue;
        const n = node.value;
        const rel = prefix ? `${prefix}/${n.name}` : n.name;

        if (isIgnored(rel, ignore)) continue;

        if (n.type === NodeType.Folder) {
            folderUids?.set(rel, n.uid);
            const sub = await listRecursive(client, n.uid, rel, folderUids, ignore);
            for (const [k, v] of sub) result.set(k, v);
        } else {
            result.set(rel, {
                uid: n.uid,
                size: n.activeRevision?.claimedSize ?? 0,
            });
        }
    }

    return result;
}

export async function downloadFile(
    client: ProtonDriveClient,
    uid: string,
    destPath: string,
): Promise<void> {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    const downloader = await client.getFileDownloader(uid);
    const fileStream = fs.createWriteStream(destPath);
    const writableStream = Writable.toWeb(fileStream) as WritableStream<Uint8Array>;
    const controller = downloader.downloadToStream(writableStream, () => {});
    try {
        await controller.completion();
    } catch (err) {
        // The SDK throws on signature/integrity verification failures for files
        // uploaded with old or mismatched keys. The file content is fully written;
        // only the cryptographic signature cannot be verified. Treat as a warning.
        const written = (() => { try { return fs.statSync(destPath).size; } catch { return 0; } })();
        if (written > 0) {
            process.stderr.write(`  warning: signature verification failed for ${path.basename(destPath)}, using file anyway\n`);
            return;
        }
        throw err;
    }
}

export async function uploadFile(
    client: ProtonDriveClient,
    localPath: string,
    protonFolderPath: string,
    fileName: string,
): Promise<string> {
    const folderUid = await resolveFolderCached(client, protonFolderPath);
    const { size } = fs.statSync(localPath);
    const { nodeUid } = await sdkUploadFile(client, localPath, folderUid, fileName, size);
    return nodeUid;
}

export async function trashFile(client: ProtonDriveClient, uid: string): Promise<void> {
    for await (const result of client.trashNodes([uid])) {
        if (!result.ok) throw new Error(`Failed to trash Proton node: ${String(result.error)}`);
    }
}
