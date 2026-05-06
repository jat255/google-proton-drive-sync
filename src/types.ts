export interface FileEntry {
    size: number;
    googleId: string;
    protonUid: string;
}

export interface SyncState {
    lastSync: string;
    files: Record<string, FileEntry>;
}

export interface GDriveFile {
    size: number;
    id: string;
    modifiedTime: string;
    mimeType: string;
    webViewLink?: string;  // present for Google Workspace files; synced as a .url shortcut
}

export interface ProtonFile {
    size: number;
    uid: string;
}

export interface SyncOptions {
    delete: boolean;
    dryRun: boolean;
    concurrency: number;
    ignore: string[];
}

export interface SyncStats {
    uploaded: number;
    downloaded: number;
    skipped: number;
    deleted: number;
    conflicts: number;
    errors: number;
}
