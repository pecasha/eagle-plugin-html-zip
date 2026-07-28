import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Readable } from "stream";
import yauzl, { Entry, ZipFile } from "yauzl";

const CACHE_DIRECTORY_NAME = "eagle-html-zip-preview";
const ACCESS_MARKER_NAME = ".last-access";
const CLEANUP_MARKER_NAME = ".last-cleanup";
const CACHE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const STAGING_LIFETIME_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRY_COUNT = 50_000;
const MAX_UNCOMPRESSED_SIZE = 4 * 1024 * 1024 * 1024;
const MAX_MANIFEST_SIZE = 1024 * 1024;
const MAX_TIMEOUT_MS = 2_147_483_647;

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
}

export interface CleanupOptions {
    cacheRoot?: string;
    now?: number;
    force?: boolean;
}

export interface PreparedPreview {
    cacheDirectory: string;
    indexPath: string;
    window: PreviewWindowConfig;
    thumbnail: PreviewThumbnailConfig;
}

export function getPreviewCacheRoot(): string {
    return path.join(os.tmpdir(), CACHE_DIRECTORY_NAME);
}

export async function prepareHtmlZip(
    sourcePath: string,
    options: PreparePreviewOptions = {}
): Promise<PreparedPreview> {
    if (!sourcePath) {
        throw new Error("Missing HTML Zip file path");
    }

    const cacheRoot = options.cacheRoot || getPreviewCacheRoot();
    const now = options.now ?? Date.now();
    await fs.promises.mkdir(cacheRoot, { recursive: true });

    if (options.cleanup !== false) {
        await cleanupPreviewCache({ cacheRoot, now });
    }

    const absoluteSourcePath = await fs.promises.realpath(path.resolve(sourcePath));
    const sourceStat = await fs.promises.stat(absoluteSourcePath);
    if (!sourceStat.isFile()) {
        throw new Error("HTML Zip path is not a file");
    }

    const cacheKey = createHash("sha256")
        .update("html-zip-cache-v1\0")
        .update(absoluteSourcePath)
        .update("\0")
        .update(String(sourceStat.size))
        .update("\0")
        .update(String(sourceStat.mtimeMs))
        .digest("hex");
    const cacheDirectory = path.join(cacheRoot, cacheKey);
    const indexPath = path.join(cacheDirectory, "index.html");

    if (!(await isFile(indexPath))) {
        if (await pathExists(cacheDirectory)) {
            await fs.promises.rm(cacheDirectory, { recursive: true, force: true });
        }
        await extractToCache(absoluteSourcePath, cacheDirectory, cacheRoot);
    }

    if (!(await isFile(indexPath))) {
        throw new Error("The HTML Zip package must contain index.html at its root");
    }

    const manifest = await readManifestConfig(cacheDirectory);
    await touchAccessMarker(cacheDirectory, now);
    return { cacheDirectory, indexPath, ...manifest };
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
        if (entry.name.startsWith(".extract-")) {
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
    cacheRoot: string
): Promise<void> {
    const stagingDirectory = await fs.promises.mkdtemp(path.join(cacheRoot, ".extract-"));

    try {
        await extractZip(sourcePath, stagingDirectory);
        if (!(await isFile(path.join(stagingDirectory, "index.html")))) {
            throw new Error("The HTML Zip package must contain index.html at its root");
        }

        try {
            await fs.promises.rename(stagingDirectory, cacheDirectory);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if ((code === "EEXIST" || code === "ENOTEMPTY" || code === "EPERM") &&
                await isFile(path.join(cacheDirectory, "index.html"))) {
                return;
            }
            throw error;
        }
    } finally {
        await fs.promises.rm(stagingDirectory, { recursive: true, force: true });
    }
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
                        throw new Error("HTML Zip package contains too many files");
                    }
                    if (uncompressedSize > MAX_UNCOMPRESSED_SIZE) {
                        throw new Error("HTML Zip package is too large after extraction");
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
        throw new Error(`Unsafe path in HTML Zip package: ${entry.fileName}`);
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
        throw new Error(`Unsafe path in HTML Zip package: ${fileName}`);
    }
    return portablePath;
}

function openZip(sourcePath: string): Promise<ZipFile> {
    return new Promise((resolve, reject) => {
        yauzl.open(sourcePath, { lazyEntries: true, autoClose: true }, (error, zipFile) => {
            if (error || !zipFile) {
                reject(error || new Error("Unable to open HTML Zip package"));
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
