import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { Command } from 'commander';
import { loadConfig } from './config';
import { createGDriveClient, runAuthFlow } from './gdrive';
import { createProtonClient, getProtonEmail } from './proton';
import { runSync } from './sync';
import { runDownload } from './download';
import { authenticate } from '../../proton-drive-cli/src/auth/protonAuth';
import { saveSession } from '../../proton-drive-cli/src/config/config';
import type { drive_v3 } from 'googleapis';

async function getGDriveEmail(drive: drive_v3.Drive): Promise<string> {
    const res = await drive.about.get({ fields: 'user' });
    return res.data.user?.emailAddress ?? '(unknown)';
}

async function prompt(question: string): Promise<string> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer); }));
}

async function promptPassword(question: string): Promise<string> {
    return new Promise(resolve => {
        process.stdout.write(question);
        process.stdin.setRawMode?.(true);
        process.stdin.resume();
        process.stdin.setEncoding('utf8');
        let value = '';
        const handler = (chunk: string) => {
            for (const char of chunk) {
                if (char === '\r' || char === '\n') {
                    process.stdin.setRawMode?.(false);
                    process.stdin.pause();
                    process.stdin.removeListener('data', handler);
                    process.stdout.write('\n');
                    resolve(value);
                    return;
                } else if (char === '\u0003') {
                    process.exit();
                } else if (char === '\u007f') {
                    if (value.length > 0) { value = value.slice(0, -1); process.stdout.write('\b \b'); }
                } else {
                    value += char;
                    process.stdout.write('*');
                }
            }
        };
        process.stdin.on('data', handler);
    });
}

const program = new Command('gdrive-proton-sync');

program
    .description('Bidirectional sync between a Google Drive folder and a Proton Drive folder')
    .version('0.1.0');

program
    .command('auth-proton')
    .description('Authenticate with a Proton account (saves session to protonConfigPath)')
    .option('-c, --config <path>', 'Path to config.json', 'config.json')
    .action(async (options: { config: string }) => {
        try {
            const config = loadConfig(path.resolve(options.config));
            const email = await prompt('Proton email: ');
            const password = await promptPassword('Password: ');
            console.log('Authenticating...');
            const session = await authenticate(email, password);
            fs.mkdirSync(path.dirname(config.protonConfigPath), { recursive: true });
            saveSession(session, config.protonConfigPath);
            console.log(`Logged in as ${session.addresses[0]?.email ?? 'unknown'}`);
            console.log(`Session saved to ${config.protonConfigPath}`);
        } catch (err) {
            console.error('Proton auth failed:', (err as Error).message);
            process.exit(1);
        }
    });

program
    .command('auth')
    .description('Authenticate with Google Drive (run once before first sync)')
    .option('-c, --config <path>', 'Path to config.json', 'config.json')
    .action(async (options: { config: string }) => {
        try {
            const config = loadConfig(path.resolve(options.config));
            await runAuthFlow(config.googleCredentialsPath, config.googleTokenPath);
            console.log('\nAuthentication complete. You can now run: npm run sync');
        } catch (err) {
            console.error('Auth failed:', (err as Error).message);
            process.exit(1);
        }
    });

program
    .command('sync')
    .description('Run bidirectional sync between Google Drive and Proton Drive')
    .option('-c, --config <path>', 'Path to config.json', 'config.json')
    .option('--delete', 'Propagate deletions: remove files from the other side when deleted on one side')
    .option('--dry-run', 'Preview changes without applying them')
    .action(async (options: { config: string; delete: boolean; dryRun: boolean }) => {
        try {
            const config = loadConfig(path.resolve(options.config));

            const configPath = path.resolve(options.config);
            const drive = createGDriveClient(config.googleCredentialsPath, config.googleTokenPath);
            const client = await createProtonClient(config.protonConfigPath);

            const [gdriveEmail, protonEmail] = await Promise.all([getGDriveEmail(drive), getProtonEmail(config.protonConfigPath)]);
            console.log(`Config:        ${configPath}`);
            console.log(`Google Drive:  ${gdriveEmail}  (folder: ${config.gdriveFolderId})`);
            console.log(`Proton Drive:  ${protonEmail}  (path: ${config.protonFolderPath})`);
            console.log();

            await runSync(drive, client, config.gdriveFolderId, config.protonFolderPath, config.statePath, {
                delete: options.delete ?? false,
                dryRun: options.dryRun ?? false,
                concurrency: config.concurrency,
                ignore: config.ignore,
            });
        } catch (err) {
            console.error('Sync failed:', (err as Error).message);
            process.exit(1);
        }
    });

program
    .command('download')
    .description('Download all files from both drives to a local directory')
    .option('-c, --config <path>', 'Path to config.json', 'config.json')
    .option('-o, --output <dir>', 'Output directory', './gdrive-proton-download')
    .action(async (options: { config: string; output: string }) => {
        try {
            const config = loadConfig(path.resolve(options.config));
            const drive = createGDriveClient(config.googleCredentialsPath, config.googleTokenPath);
            const client = await createProtonClient(config.protonConfigPath);

            const [gdriveEmail, protonEmail] = await Promise.all([getGDriveEmail(drive), getProtonEmail(config.protonConfigPath)]);
            console.log(`Config:        ${path.resolve(options.config)}`);
            console.log(`Google Drive:  ${gdriveEmail}  (folder: ${config.gdriveFolderId})`);
            console.log(`Proton Drive:  ${protonEmail}  (path: ${config.protonFolderPath})`);
            console.log(`Output:        ${path.resolve(options.output)}\n`);

            await runDownload(drive, client, config.gdriveFolderId, config.protonFolderPath, options.output, {
                concurrency: config.concurrency,
                ignore: config.ignore,
            });
        } catch (err) {
            console.error('Download failed:', (err as Error).message);
            process.exit(1);
        }
    });

program.parse(process.argv);
