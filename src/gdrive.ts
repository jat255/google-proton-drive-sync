import fs from 'fs';
import http from 'http';
import path from 'path';
import { google } from 'googleapis';
import type { drive_v3 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { GDriveFile } from './types';
import { isIgnored } from './utils';

const SCOPES = ['https://www.googleapis.com/auth/drive'];
const AUTH_PORT = 3000;

// Google Workspace native formats that can't be downloaded as-is
const GOOGLE_NATIVE_MIMETYPES = new Set([
    'application/vnd.google-apps.document',
    'application/vnd.google-apps.spreadsheet',
    'application/vnd.google-apps.presentation',
    'application/vnd.google-apps.drawing',
    'application/vnd.google-apps.form',
    'application/vnd.google-apps.map',
    'application/vnd.google-apps.site',
]);

function loadCredentials(credentialsPath: string): OAuth2Client {
    const raw = JSON.parse(fs.readFileSync(credentialsPath, 'utf-8'));
    const creds = raw.installed ?? raw.web;
    return new google.auth.OAuth2(creds.client_id, creds.client_secret, `http://localhost:${AUTH_PORT}`);
}

export async function runAuthFlow(credentialsPath: string, tokenPath: string): Promise<void> {
    const auth = loadCredentials(credentialsPath);
    const authUrl = auth.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent' });

    const code = await captureCodeViaLocalServer(authUrl);
    const { tokens } = await auth.getToken(code);

    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
    console.log(`Token saved to ${tokenPath}`);
}

function captureCodeViaLocalServer(authUrl: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            const url = new URL(req.url ?? '/', `http://localhost:${AUTH_PORT}`);
            const code = url.searchParams.get('code');
            if (code) {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end('<h1>Authorization successful! You can close this window.</h1>');
                server.close();
                resolve(code);
            } else {
                res.writeHead(400);
                res.end('No authorization code received.');
                server.close();
                reject(new Error('No code in OAuth callback'));
            }
        });
        server.listen(AUTH_PORT, () => {
            console.log(`\nOpen this URL in your browser:\n\n${authUrl}\n`);
            console.log(`Waiting for authorization on http://localhost:${AUTH_PORT} ...`);
        });
    });
}

export function createGDriveClient(credentialsPath: string, tokenPath: string): drive_v3.Drive {
    const auth = loadCredentials(credentialsPath);
    const token = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
    auth.setCredentials(token);

    auth.on('tokens', (newToken) => {
        const current = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
        fs.writeFileSync(tokenPath, JSON.stringify({ ...current, ...newToken }, null, 2), { mode: 0o600 });
    });

    return google.drive({ version: 'v3', auth });
}

export async function listRecursive(
    drive: drive_v3.Drive,
    folderId: string,
    prefix = '',
    folderIds?: Map<string, string>,
    ignore: string[] = [],
): Promise<Map<string, GDriveFile>> {
    const result = new Map<string, GDriveFile>();
    let pageToken: string | undefined;

    do {
        const res = await drive.files.list({
            q: `'${folderId}' in parents and trashed = false`,
            fields: 'nextPageToken, files(id, name, size, modifiedTime, mimeType, webViewLink)',
            pageSize: 1000,
            pageToken,
        });

        for (const file of res.data.files ?? []) {
            if (!file.id || !file.name) continue;

            const rel = prefix ? `${prefix}/${file.name}` : file.name;

            if (isIgnored(rel, ignore)) continue;

            if (file.mimeType === 'application/vnd.google-apps.folder') {
                folderIds?.set(rel, file.id);
                const sub = await listRecursive(drive, file.id, rel, folderIds, ignore);
                for (const [k, v] of sub) result.set(k, v);
            } else if (GOOGLE_NATIVE_MIMETYPES.has(file.mimeType ?? '')) {
                const webViewLink = file.webViewLink;
                if (webViewLink) {
                    const content = workspaceLinkContent(webViewLink);
                    result.set(`${rel}.url`, {
                        size: Buffer.byteLength(content, 'utf-8'),
                        id: file.id,
                        modifiedTime: file.modifiedTime ?? '',
                        mimeType: 'text/uri-list',
                        webViewLink,
                    });
                }
            } else {
                result.set(rel, {
                    size: parseInt(file.size ?? '0', 10),
                    id: file.id,
                    modifiedTime: file.modifiedTime ?? '',
                    mimeType: file.mimeType ?? 'application/octet-stream',
                });
            }
        }

        pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);

    return result;
}

export async function downloadFile(drive: drive_v3.Drive, fileId: string, destPath: string): Promise<void> {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });

    await new Promise<void>((resolve, reject) => {
        const dest = fs.createWriteStream(destPath);
        (res.data as NodeJS.ReadableStream).pipe(dest);
        dest.on('finish', resolve);
        dest.on('error', reject);
    });
}

export async function uploadFile(
    drive: drive_v3.Drive,
    localPath: string,
    parentFolderId: string,
    fileName: string,
): Promise<string> {
    const res = await drive.files.create({
        requestBody: { name: fileName, parents: [parentFolderId] },
        media: { body: fs.createReadStream(localPath) },
        fields: 'id',
    });
    return res.data.id!;
}

export async function updateFile(
    drive: drive_v3.Drive,
    fileId: string,
    localPath: string,
): Promise<void> {
    await drive.files.update({
        fileId,
        media: { body: fs.createReadStream(localPath) },
    });
}

export async function renameFile(
    drive: drive_v3.Drive,
    fileId: string,
    newName: string,
): Promise<void> {
    await drive.files.update({ fileId, requestBody: { name: newName } });
}

export async function trashFile(drive: drive_v3.Drive, fileId: string): Promise<void> {
    await drive.files.update({ fileId, requestBody: { trashed: true } });
}

// Caches in-flight and resolved folder creation promises to prevent race conditions
// under concurrent uploads creating duplicate folders for the same path.
const folderPathCache = new Map<string, Promise<string>>();

export function clearFolderCache(): void {
    folderPathCache.clear();
}

export function getOrCreateFolderPath(
    drive: drive_v3.Drive,
    rootFolderId: string,
    relativeFolderPath: string,
): Promise<string> {
    const key = `${rootFolderId}:${relativeFolderPath}`;
    if (!folderPathCache.has(key)) {
        folderPathCache.set(key, _buildFolderPath(drive, rootFolderId, relativeFolderPath));
    }
    return folderPathCache.get(key)!;
}

async function _buildFolderPath(
    drive: drive_v3.Drive,
    rootFolderId: string,
    relativeFolderPath: string,
): Promise<string> {
    const segments = relativeFolderPath.split('/').filter(Boolean);
    let currentId = rootFolderId;
    for (const segment of segments) {
        currentId = await _getOrCreateFolderSegment(drive, currentId, segment);
    }
    return currentId;
}

export function workspaceLinkContent(webViewLink: string): string {
    return `[InternetShortcut]\nURL=${webViewLink}\n`;
}

async function _getOrCreateFolderSegment(
    drive: drive_v3.Drive,
    parentId: string,
    name: string,
): Promise<string> {
    const escapedName = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const res = await drive.files.list({
        q: `'${parentId}' in parents and name = '${escapedName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id)',
    });
    if (res.data.files?.length) return res.data.files[0].id!;

    const folder = await drive.files.create({
        requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] },
        fields: 'id',
    });
    return folder.data.id!;
}
