import { createHash } from "crypto";
import { spawn } from "child_process";
import * as fs from "fs";
import { createServer, ServerResponse } from "http";
import * as os from "os";
import * as path from "path";
import { Readable } from "stream";
import yauzl, { Entry, ZipFile } from "yauzl";

const CACHE_DIRECTORY_NAME = "eagle-web-zip-preview";
const LEGACY_CACHE_DIRECTORY_NAME = "eagle-html-zip-preview";
const ACCESS_MARKER_NAME = ".last-access";
const CLEANUP_MARKER_NAME = ".last-cleanup";
const CACHE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const STAGING_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRY_COUNT = 50_000;
const MAX_UNCOMPRESSED_SIZE = 4 * 1024 * 1024 * 1024;
const MAX_MANIFEST_SIZE = 1024 * 1024;
const MAX_PACKAGE_JSON_SIZE = 1024 * 1024;
const MAX_TIMEOUT_MS = 2_147_483_647;
const NPM_COMMAND_TIMEOUT_MS = 15 * 60 * 1000;
const PREPARATION_LOCK_TIMEOUT_MS = 35 * 60 * 1000;
const PREPARATION_LOCK_STALE_MS = 2 * 60 * 60 * 1000;
const PREPARATION_LOCK_POLL_MS = 250;
const PREPARATION_LOCK_HEARTBEAT_MS = 30 * 1000;
const MAX_COMMAND_OUTPUT_LENGTH = 32 * 1024;
const CONTENT_TYPES: Readonly<Record<string, string>> = {
    ".css": "text/css; charset=utf-8",
    ".gif": "image/gif",
    ".html": "text/html; charset=utf-8",
    ".ico": "image/x-icon",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".ogg": "audio/ogg",
    ".png": "image/png",
    ".svg": "image/svg+xml; charset=utf-8",
    ".wasm": "application/wasm",
    ".webm": "video/webm",
    ".webp": "image/webp",
    ".woff": "font/woff",
    ".woff2": "font/woff2"
};

export type WebZipFormat = "htmz" | "npmz";
export type NpmBuildPhase = "install" | "build";
export type NpmProgressStatus = "start" | "output" | "complete";

export interface NpmCommandOutput {
    stream: "stdout" | "stderr";
    text: string;
}

export interface NpmProgressEvent {
    phase: NpmBuildPhase;
    status: NpmProgressStatus;
    command?: string;
    output?: NpmCommandOutput;
}

export type NpmProgressHandler = (event: NpmProgressEvent) => void;
export type NpmCommandRunner = (
    args: readonly string[],
    cwd: string,
    onOutput?: (output: NpmCommandOutput) => void
) => Promise<void>;

export type PreviewWindowDimension = number | "auto";

export interface PreviewWindowConfig {
    width: PreviewWindowDimension;
    height: PreviewWindowDimension;
}

export interface PreviewThumbnailConfig {
    captureDelay: number;
}

interface PreviewManifestConfig {
    window: PreviewWindowConfig;
    thumbnail: PreviewThumbnailConfig;
}

export interface PreparePreviewOptions {
    cacheRoot?: string;
    now?: number;
    cleanup?: boolean;
    allowNpmBuild?: boolean;
    npmCommandRunner?: NpmCommandRunner;
    onNpmProgress?: NpmProgressHandler;
}

export interface CleanupOptions {
    cacheRoot?: string;
    now?: number;
    force?: boolean;
}

export interface PreparedPreview {
    cacheDirectory: string;
    indexPath: string;
    format: WebZipFormat;
    window: PreviewWindowConfig;
    thumbnail: PreviewThumbnailConfig;
}

export interface PreviewServer {
    url: string;
    close(): Promise<void>;
}

export class NpmBuildPermissionError extends Error {
    readonly code = "NPM_BUILD_PERMISSION_REQUIRED";

    constructor() {
        super("Building this npmz package requires permission to install dependencies and run npm scripts");
        this.name = "NpmBuildPermissionError";
    }
}

export function getPreviewCacheRoot(): string {
    return path.join(os.tmpdir(), CACHE_DIRECTORY_NAME);
}

function getWebZipFormat(sourcePath: string): WebZipFormat {
    const extension = path.extname(sourcePath).toLowerCase();
    if (extension === ".htmz") {
        return "htmz";
    }
    if (extension === ".npmz") {
        return "npmz";
    }
    throw new Error("Web Zip files must use the .htmz or .npmz extension");
}

function getPreviewIndexPath(cacheDirectory: string, format: WebZipFormat): string {
    return format === "htmz"
        ? path.join(cacheDirectory, "index.html")
        : path.join(cacheDirectory, "dist", "index.html");
}

export async function prepareWebZip(
    sourcePath: string,
    options: PreparePreviewOptions = {}
): Promise<PreparedPreview> {
    if (!sourcePath) {
        throw new Error("Missing Web Zip file path");
    }

    const format = getWebZipFormat(sourcePath);
    const cacheRoot = options.cacheRoot || getPreviewCacheRoot();
    const now = options.now ?? Date.now();
    await fs.promises.mkdir(cacheRoot, { recursive: true });

    if (options.cleanup !== false) {
        await cleanupPreviewCache({ cacheRoot, now });
        if (!options.cacheRoot) {
            await cleanupPreviewCache({
                cacheRoot: path.join(os.tmpdir(), LEGACY_CACHE_DIRECTORY_NAME),
                now
            });
        }
    }

    const absoluteSourcePath = await fs.promises.realpath(path.resolve(sourcePath));
    const sourceStat = await fs.promises.stat(absoluteSourcePath);
    if (!sourceStat.isFile()) {
        throw new Error("Web Zip path is not a file");
    }

    const cacheKey = createHash("sha256")
        .update("web-zip-cache-v2\0")
        .update(format)
        .update("\0")
        .update(absoluteSourcePath)
        .update("\0")
        .update(String(sourceStat.size))
        .update("\0")
        .update(String(sourceStat.mtimeMs))
        .digest("hex");
    const cacheDirectory = path.join(cacheRoot, cacheKey);
    const indexPath = getPreviewIndexPath(cacheDirectory, format);

    if (!(await isFile(indexPath))) {
        if (format === "npmz" && options.allowNpmBuild !== true) {
            throw new NpmBuildPermissionError();
        }

        await withPreparationLock(cacheRoot, cacheKey, async () => {
            if (await isFile(indexPath)) {
                return;
            }
            if (await pathExists(cacheDirectory)) {
                await fs.promises.rm(cacheDirectory, { recursive: true, force: true });
            }
            await extractToCache(
                absoluteSourcePath,
                cacheDirectory,
                cacheRoot,
                format,
                options.npmCommandRunner || runNpmCommand,
                options.onNpmProgress
            );
        });
    }

    if (!(await isFile(indexPath))) {
        throw new Error(format === "htmz"
            ? "The htmz package must contain index.html at its root"
            : "The npmz build must create dist/index.html");
    }

    const manifest = await readManifestConfig(cacheDirectory);
    await touchAccessMarker(cacheDirectory, now);
    return { cacheDirectory, indexPath, format, ...manifest };
}

export function prepareHtmlZip(
    sourcePath: string,
    options: PreparePreviewOptions = {}
): Promise<PreparedPreview> {
    return prepareWebZip(sourcePath, options);
}

export async function createPreviewServer(preview: PreparedPreview): Promise<PreviewServer> {
    const rootDirectory = path.resolve(preview.format === "npmz"
        ? path.join(preview.cacheDirectory, "dist")
        : preview.cacheDirectory);
    const server = createServer((request, response) => {
        void servePreviewRequest(rootDirectory, request.method, request.url, response);
    });

    await new Promise<void>((resolve, reject) => {
        const fail = (error: Error) => {
            server.off("listening", resolve);
            reject(error);
        };
        server.once("error", fail);
        server.once("listening", () => {
            server.off("error", fail);
            resolve();
        });
        server.listen(0, "127.0.0.1");
    });

    const address = server.address();
    if (!address || typeof address === "string") {
        server.close();
        throw new Error("Unable to determine the Web Zip preview server address");
    }

    let closed = false;
    return {
        url: `http://127.0.0.1:${address.port}/index.html`,
        close: () => new Promise<void>((resolve, reject) => {
            if (closed) {
                resolve();
                return;
            }
            closed = true;
            server.close(error => error ? reject(error) : resolve());
        })
    };
}

async function servePreviewRequest(
    rootDirectory: string,
    method: string | undefined,
    requestUrl: string | undefined,
    response: ServerResponse
): Promise<void> {
    try {
        if (method !== "GET" && method !== "HEAD") {
            response.writeHead(405, { Allow: "GET, HEAD" });
            response.end();
            return;
        }

        const url = new URL(requestUrl || "/", "http://127.0.0.1");
        const portablePath = decodeURIComponent(url.pathname).replace(/\\/g, "/");
        const relativePath = portablePath.replace(/^\/+/, "") || "index.html";
        let targetPath = path.resolve(rootDirectory, ...relativePath.split("/"));
        if (targetPath !== rootDirectory && !targetPath.startsWith(`${rootDirectory}${path.sep}`)) {
            response.writeHead(403);
            response.end();
            return;
        }

        let stat = await fs.promises.stat(targetPath).catch(() => null);
        if (stat?.isDirectory()) {
            targetPath = path.join(targetPath, "index.html");
            stat = await fs.promises.stat(targetPath).catch(() => null);
        }
        if (!stat?.isFile()) {
            response.writeHead(404);
            response.end();
            return;
        }

        response.writeHead(200, {
            "Cache-Control": "no-store",
            "Content-Length": stat.size,
            "Content-Type": CONTENT_TYPES[path.extname(targetPath).toLowerCase()] || "application/octet-stream"
        });
        if (method === "HEAD") {
            response.end();
            return;
        }

        const stream = fs.createReadStream(targetPath);
        stream.once("error", () => response.destroy());
        stream.pipe(response);
    } catch {
        if (!response.headersSent) {
            response.writeHead(400);
        }
        response.end();
    }
}

async function withPreparationLock(
    cacheRoot: string,
    cacheKey: string,
    action: () => Promise<void>
): Promise<void> {
    const lockDirectory = path.join(cacheRoot, `.prepare-${cacheKey}.lock`);
    const deadline = Date.now() + PREPARATION_LOCK_TIMEOUT_MS;

    while (true) {
        try {
            await fs.promises.mkdir(lockDirectory);
            break;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                throw error;
            }

            const stat = await fs.promises.stat(lockDirectory).catch(() => null);
            if (stat && Date.now() - stat.mtimeMs > PREPARATION_LOCK_STALE_MS) {
                await fs.promises.rm(lockDirectory, { recursive: true, force: true });
                continue;
            }
            if (Date.now() >= deadline) {
                throw new Error("Timed out while waiting for another Web Zip preparation");
            }
            await delay(PREPARATION_LOCK_POLL_MS);
        }
    }

    const heartbeat = setInterval(() => {
        const timestamp = new Date();
        void fs.promises.utimes(lockDirectory, timestamp, timestamp).catch(() => undefined);
    }, PREPARATION_LOCK_HEARTBEAT_MS);

    try {
        await action();
    } finally {
        clearInterval(heartbeat);
        await fs.promises.rm(lockDirectory, { recursive: true, force: true });
    }
}

export async function cleanupPreviewCache(options: CleanupOptions = {}): Promise<void> {
    const cacheRoot = options.cacheRoot || getPreviewCacheRoot();
    const now = options.now ?? Date.now();
    await fs.promises.mkdir(cacheRoot, { recursive: true });

    const cleanupMarker = path.join(cacheRoot, CLEANUP_MARKER_NAME);
    if (!options.force && await wasTouchedToday(cleanupMarker, now)) {
        return;
    }

    const entries = await fs.promises.readdir(cacheRoot, { withFileTypes: true });
    await Promise.all(entries.map(async entry => {
        if (!entry.isDirectory()) {
            return;
        }

        const directoryPath = path.join(cacheRoot, entry.name);
        if ([".staging-", ".result-", ".prepare-"].some(prefix => entry.name.startsWith(prefix))) {
            const stat = await fs.promises.stat(directoryPath).catch(() => null);
            if (stat && now - stat.mtimeMs > STAGING_LIFETIME_MS) {
                await fs.promises.rm(directoryPath, { recursive: true, force: true });
            }
            return;
        }

        if (!/^[a-f0-9]{64}$/.test(entry.name)) {
            return;
        }

        const accessMarker = path.join(directoryPath, ACCESS_MARKER_NAME);
        const stat = await fs.promises.stat(accessMarker).catch(() => null);
        const lastAccess = stat?.mtimeMs ?? 0;
        if (now - lastAccess > CACHE_LIFETIME_MS) {
            await fs.promises.rm(directoryPath, { recursive: true, force: true });
        }
    }));

    await writeMarker(cleanupMarker, now);
}

async function extractToCache(
    sourcePath: string,
    cacheDirectory: string,
    cacheRoot: string,
    format: WebZipFormat,
    npmCommandRunner: NpmCommandRunner,
    onNpmProgress?: NpmProgressHandler
): Promise<void> {
    const stagingDirectory = await fs.promises.mkdtemp(path.join(cacheRoot, ".staging-"));
    let resultDirectory: string | null = null;

    try {
        await extractZip(sourcePath, stagingDirectory);
        if (format === "htmz") {
            if (!(await isFile(path.join(stagingDirectory, "index.html")))) {
                throw new Error("The htmz package must contain index.html at its root");
            }
            await publishCacheDirectory(stagingDirectory, cacheDirectory, format);
            return;
        }

        const installArgs = await validateNpmPackage(stagingDirectory);
        await runNpmPhase("install", installArgs, stagingDirectory, npmCommandRunner, onNpmProgress);
        await runNpmPhase("build", ["run", "build"], stagingDirectory, npmCommandRunner, onNpmProgress);

        const builtIndexPath = path.join(stagingDirectory, "dist", "index.html");
        if (!(await isFile(builtIndexPath))) {
            throw new Error("The npmz build must create dist/index.html");
        }

        resultDirectory = await fs.promises.mkdtemp(path.join(cacheRoot, ".result-"));
        await fs.promises.cp(
            path.join(stagingDirectory, "dist"),
            path.join(resultDirectory, "dist"),
            { recursive: true, errorOnExist: true }
        );
        const manifestPath = path.join(stagingDirectory, "manifest.json");
        if (await isFile(manifestPath)) {
            await fs.promises.copyFile(manifestPath, path.join(resultDirectory, "manifest.json"));
        }
        await publishCacheDirectory(resultDirectory, cacheDirectory, format);
    } finally {
        await fs.promises.rm(stagingDirectory, { recursive: true, force: true });
        if (resultDirectory) {
            await fs.promises.rm(resultDirectory, { recursive: true, force: true });
        }
    }
}

async function runNpmPhase(
    phase: NpmBuildPhase,
    args: readonly string[],
    cwd: string,
    npmCommandRunner: NpmCommandRunner,
    onNpmProgress?: NpmProgressHandler
): Promise<void> {
    reportNpmProgress(onNpmProgress, {
        phase,
        status: "start",
        command: `npm ${args.join(" ")}`
    });
    await npmCommandRunner(args, cwd, output => {
        reportNpmProgress(onNpmProgress, { phase, status: "output", output });
    });
    reportNpmProgress(onNpmProgress, { phase, status: "complete" });
}

function reportNpmProgress(
    onNpmProgress: NpmProgressHandler | undefined,
    event: NpmProgressEvent
): void {
    try {
        onNpmProgress?.(event);
    } catch {}
}

async function publishCacheDirectory(
    stagingDirectory: string,
    cacheDirectory: string,
    format: WebZipFormat
): Promise<void> {
    try {
        await fs.promises.rename(stagingDirectory, cacheDirectory);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if ((code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM") &&
            await isFile(getPreviewIndexPath(cacheDirectory, format))) {
            return;
        }
        throw error;
    }
}

async function validateNpmPackage(projectDirectory: string): Promise<readonly string[]> {
    const packagePath = path.join(projectDirectory, "package.json");
    const stat = await fs.promises.stat(packagePath).catch(() => null);
    if (!stat?.isFile()) {
        throw new Error("The npmz package must contain package.json at its root");
    }
    if (stat.size > MAX_PACKAGE_JSON_SIZE) {
        throw new Error("The npmz package.json file is too large");
    }

    let packageJson: unknown;
    try {
        packageJson = JSON.parse(await fs.promises.readFile(packagePath, "utf8"));
    } catch {
        throw new Error("The npmz package contains an invalid package.json file");
    }

    const scripts = packageJson && typeof packageJson === "object"
        ? (packageJson as { scripts?: unknown }).scripts
        : null;
    const buildScript = scripts && typeof scripts === "object"
        ? (scripts as { build?: unknown }).build
        : null;
    if (typeof buildScript !== "string" || !buildScript.trim()) {
        throw new Error("The npmz package.json must define a build script");
    }

    return await isFile(path.join(projectDirectory, "package-lock.json"))
        ? ["ci", "--no-audit", "--no-fund"]
        : ["install", "--no-audit", "--no-fund"];
}

function runNpmCommand(
    args: readonly string[],
    cwd: string,
    onOutput?: (output: NpmCommandOutput) => void
): Promise<void> {
    const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
    const commandLabel = `npm ${args.join(" ")}`;

    return new Promise((resolve, reject) => {
        let settled = false;
        let output = "";
        const child = spawn(npmCommand, [...args], {
            cwd,
            env: {
                ...process.env,
                CI: "1",
                NO_UPDATE_NOTIFIER: "1"
            },
            shell: false,
            windowsHide: true
        });
        const appendOutput = (stream: NpmCommandOutput["stream"]) => (chunk: Buffer | string) => {
            const text = chunk.toString();
            output += text;
            if (output.length > MAX_COMMAND_OUTPUT_LENGTH) {
                output = output.slice(-MAX_COMMAND_OUTPUT_LENGTH);
            }
            onOutput?.({ stream, text });
        };
        const fail = (error: Error) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            reject(error);
        };
        const timeout = setTimeout(() => {
            child.kill();
            fail(new Error(`${commandLabel} timed out after 15 minutes`));
        }, NPM_COMMAND_TIMEOUT_MS);

        child.stdout?.on("data", appendOutput("stdout"));
        child.stderr?.on("data", appendOutput("stderr"));
        child.once("error", error => {
            fail(new Error(`Unable to start npm. Make sure Node.js and npm are installed: ${error.message}`));
        });
        child.once("close", code => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            if (code === 0) {
                resolve();
                return;
            }
            const detail = output.trim();
            reject(new Error(`${commandLabel} failed with exit code ${code}${detail ? `\n${detail}` : ""}`));
        });
    });
}

async function extractZip(sourcePath: string, destination: string): Promise<void> {
    const zipFile = await openZip(sourcePath);
    let entryCount = 0;
    let uncompressedSize = 0;

    await new Promise<void>((resolve, reject) => {
        let settled = false;

        const fail = (error: unknown) => {
            if (settled) {
                return;
            }
            settled = true;
            zipFile.close();
            reject(error);
        };

        zipFile.once("error", fail);
        zipFile.once("end", () => {
            if (!settled) {
                settled = true;
                resolve();
            }
        });
        zipFile.on("entry", (entry: Entry) => {
            void extractEntry(zipFile, entry, destination, {
                addEntry(size: number) {
                    entryCount += 1;
                    uncompressedSize += size;
                    if (entryCount > MAX_ENTRY_COUNT) {
                        throw new Error("Web Zip package contains too many files");
                    }
                    if (uncompressedSize > MAX_UNCOMPRESSED_SIZE) {
                        throw new Error("Web Zip package is too large after extraction");
                    }
                }
            }).then(() => zipFile.readEntry(), fail);
        });

        zipFile.readEntry();
    });
}

async function extractEntry(
    zipFile: ZipFile,
    entry: Entry,
    destination: string,
    limits: { addEntry(size: number): void }
): Promise<void> {
    limits.addEntry(entry.uncompressedSize);
    const relativePath = validateEntryPath(entry.fileName);
    if (!relativePath && entry.fileName.replace(/\\/g, "/").endsWith("/")) {
        return;
    }
    const targetPath = path.resolve(destination, ...relativePath.split("/"));
    const destinationRoot = path.resolve(destination);

    if (targetPath !== destinationRoot && !targetPath.startsWith(`${destinationRoot}${path.sep}`)) {
        throw new Error(`Unsafe path in Web Zip package: ${entry.fileName}`);
    }

    const unixFileType = (entry.externalFileAttributes >>> 16) & 0o170000;
    if (unixFileType === 0o120000) {
        throw new Error(`Symbolic links are not supported: ${entry.fileName}`);
    }

    if (entry.fileName.endsWith("/")) {
        await fs.promises.mkdir(targetPath, { recursive: true });
        return;
    }

    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    const readStream = await openEntryStream(zipFile, entry);
    await pipeToFile(readStream, targetPath);
}

function validateEntryPath(fileName: string): string {
    const portablePath = fileName.replace(/\\/g, "/").replace(/^\.\/+/, "");
    if (!portablePath && /^\.\/+$/u.test(fileName.replace(/\\/g, "/"))) {
        return "";
    }
    const segments = portablePath.split("/");
    if (!portablePath || portablePath.includes("\0") || portablePath.startsWith("/") ||
        /^[a-zA-Z]:/.test(portablePath) || segments.some(segment => segment === ".." || segment.includes(":"))) {
        throw new Error(`Unsafe path in Web Zip package: ${fileName}`);
    }
    return portablePath;
}

function openZip(sourcePath: string): Promise<ZipFile> {
    return new Promise((resolve, reject) => {
        yauzl.open(sourcePath, { lazyEntries: true, autoClose: true }, (error, zipFile) => {
            if (error || !zipFile) {
                reject(error || new Error("Unable to open Web Zip package"));
                return;
            }
            resolve(zipFile);
        });
    });
}

function openEntryStream(zipFile: ZipFile, entry: Entry): Promise<Readable> {
    return new Promise((resolve, reject) => {
        zipFile.openReadStream(entry, (error, stream) => {
            if (error || !stream) {
                reject(error || new Error(`Unable to read ${entry.fileName}`));
                return;
            }
            resolve(stream);
        });
    });
}

function pipeToFile(readStream: Readable, targetPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const writeStream = fs.createWriteStream(targetPath, { flags: "wx" });
        readStream.once("error", reject);
        writeStream.once("error", reject);
        writeStream.once("finish", resolve);
        readStream.pipe(writeStream);
    });
}

async function touchAccessMarker(cacheDirectory: string, now: number): Promise<void> {
    await writeMarker(path.join(cacheDirectory, ACCESS_MARKER_NAME), now);
}

async function writeMarker(markerPath: string, now: number): Promise<void> {
    await fs.promises.writeFile(markerPath, String(now), "utf8");
    const timestamp = new Date(now);
    await fs.promises.utimes(markerPath, timestamp, timestamp);
}

async function wasTouchedToday(markerPath: string, now: number): Promise<boolean> {
    const stat = await fs.promises.stat(markerPath).catch(() => null);
    if (!stat) {
        return false;
    }

    const markerDate = new Date(stat.mtimeMs);
    const currentDate = new Date(now);
    return markerDate.getFullYear() === currentDate.getFullYear() &&
        markerDate.getMonth() === currentDate.getMonth() &&
        markerDate.getDate() === currentDate.getDate();
}

async function isFile(filePath: string): Promise<boolean> {
    const stat = await fs.promises.stat(filePath).catch(() => null);
    return stat?.isFile() === true;
}

async function pathExists(filePath: string): Promise<boolean> {
    return fs.promises.access(filePath).then(() => true, () => false);
}

async function readManifestConfig(cacheDirectory: string): Promise<PreviewManifestConfig> {
    const defaults: PreviewManifestConfig = {
        window: { width: "auto", height: "auto" },
        thumbnail: { captureDelay: 0 }
    };
    const manifestPath = path.join(cacheDirectory, "manifest.json");
    const stat = await fs.promises.stat(manifestPath).catch(() => null);
    if (!stat?.isFile() || stat.size > MAX_MANIFEST_SIZE) {
        return defaults;
    }

    try {
        const manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf8"));
        const window = manifest && typeof manifest === "object" ? manifest.window : null;
        const thumbnail = manifest && typeof manifest === "object" ? manifest.thumbnail : null;
        return {
            window: {
                width: normalizeWindowDimension(window?.width),
                height: normalizeWindowDimension(window?.height)
            },
            thumbnail: {
                captureDelay: normalizeCaptureDelay(thumbnail?.captureDelay)
            }
        };
    } catch {
        return defaults;
    }
}

function normalizeWindowDimension(value: unknown): PreviewWindowDimension {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return "auto";
    }

    const integer = Math.trunc(value);
    return integer > 0 && Number.isSafeInteger(integer) ? integer : "auto";
}

function normalizeCaptureDelay(value: unknown): number {
    return typeof value === "number" && Number.isSafeInteger(value) &&
        value > 0 && value <= MAX_TIMEOUT_MS ? value : 0;
}

function delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}
