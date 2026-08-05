const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const yazl = require("yazl");
const {
    cleanupPreviewCache,
    createPreviewServer,
    prepareWebZip
} = require("../dist/lib/core.js");

async function createZip(filePath, entries) {
    const zipFile = new yazl.ZipFile();
    for (const [entryPath, content] of Object.entries(entries)) {
        zipFile.addBuffer(Buffer.from(content), entryPath);
    }
    zipFile.end();
    await new Promise((resolve, reject) => {
        zipFile.outputStream
            .pipe(fs.createWriteStream(filePath))
            .on("close", resolve)
            .on("error", reject);
    });
}

async function replaceZipEntryName(filePath, originalName, replacementName) {
    assert.equal(Buffer.byteLength(originalName), Buffer.byteLength(replacementName));
    const archive = await fs.promises.readFile(filePath);
    const original = Buffer.from(originalName);
    const replacement = Buffer.from(replacementName);
    let offset = 0;
    let replacements = 0;

    while ((offset = archive.indexOf(original, offset)) !== -1) {
        replacement.copy(archive, offset);
        offset += replacement.length;
        replacements += 1;
    }

    assert.ok(replacements >= 2, "entry name should occur in local and central ZIP headers");
    await fs.promises.writeFile(filePath, archive);
}

async function makeWorkspace(t) {
    const workspace = await fs.promises.mkdtemp(path.join(os.tmpdir(), "htmz-test-"));
    t.after(() => fs.promises.rm(workspace, { recursive: true, force: true }));
    return workspace;
}

function readUrl(url) {
    return new Promise((resolve, reject) => {
        http.get(url, response => {
            const chunks = [];
            response.on("data", chunk => chunks.push(chunk));
            response.on("end", () => {
                if (response.statusCode !== 200) {
                    reject(new Error(`Unexpected HTTP status ${response.statusCode}`));
                    return;
                }
                resolve(Buffer.concat(chunks).toString("utf8"));
            });
        }).on("error", reject);
    });
}

test("extracts index.html and nested relative resources", async t => {
    const workspace = await makeWorkspace(t);
    const source = path.join(workspace, "sample.htmz");
    const cacheRoot = path.join(workspace, "cache");
    await createZip(source, {
        "index.html": "<link rel=\"stylesheet\" href=\"assets/site.css\">",
        "assets/site.css": "body { color: green; }",
        "assets/app.js": "window.loaded = true;"
    });

    const preview = await prepareWebZip(source, { cacheRoot });
    assert.equal(await fs.promises.readFile(preview.indexPath, "utf8"), "<link rel=\"stylesheet\" href=\"assets/site.css\">");
    assert.equal(await fs.promises.readFile(path.join(preview.cacheDirectory, "assets/site.css"), "utf8"), "body { color: green; }");
    assert.deepEqual(preview.window, { width: "auto", height: "auto" });
    assert.deepEqual(preview.thumbnail, { captureDelay: 0 });
});

test("reads thumbnail window dimensions from the root manifest", async t => {
    const workspace = await makeWorkspace(t);
    const source = path.join(workspace, "configured.htmz");
    await createZip(source, {
        "index.html": "configured",
        "manifest.json": JSON.stringify({
            window: { width: 1280.9, height: 720 },
            thumbnail: { captureDelay: 1500 }
        })
    });

    const preview = await prepareWebZip(source, { cacheRoot: path.join(workspace, "cache") });
    assert.deepEqual(preview.window, { width: 1280, height: 720 });
    assert.deepEqual(preview.thumbnail, { captureDelay: 1500 });
});

test("builds npmz packages and preserves their root manifest configuration", async t => {
    const workspace = await makeWorkspace(t);
    const source = path.join(workspace, "vite-project.npmz");
    const cacheRoot = path.join(workspace, "cache");
    const commands = [];
    const progressEvents = [];
    await createZip(source, {
        "index.html": "Vite source entry, not the preview entry",
        "package.json": JSON.stringify({
            name: "vite-project",
            scripts: { build: "vite build" }
        }),
        "package-lock.json": "{}",
        "manifest.json": JSON.stringify({
            window: { width: 1440, height: 900 },
            thumbnail: { captureDelay: 750 }
        })
    });

    await assert.rejects(
        prepareWebZip(source, { cacheRoot }),
        error => error.code === "NPM_BUILD_PERMISSION_REQUIRED"
    );

    const preview = await prepareWebZip(source, {
        cacheRoot,
        allowNpmBuild: true,
        onNpmProgress: event => progressEvents.push(event),
        npmCommandRunner: async (args, cwd, onOutput) => {
            commands.push([...args]);
            onOutput({
                stream: args[0] === "run" ? "stderr" : "stdout",
                text: args[0] === "run" ? "building\n" : "installing\n"
            });
            if (args[0] === "run" && args[1] === "build") {
                await fs.promises.mkdir(path.join(cwd, "dist", "assets"), { recursive: true });
                await fs.promises.writeFile(path.join(cwd, "dist", "index.html"), "built", "utf8");
                await fs.promises.writeFile(path.join(cwd, "dist", "assets", "app.js"), "built asset", "utf8");
            }
        }
    });

    assert.equal(preview.format, "npmz");
    assert.equal(await fs.promises.readFile(preview.indexPath, "utf8"), "built");
    assert.equal(
        await fs.promises.readFile(path.join(preview.cacheDirectory, "dist", "assets", "app.js"), "utf8"),
        "built asset"
    );
    assert.deepEqual(preview.window, { width: 1440, height: 900 });
    assert.deepEqual(preview.thumbnail, { captureDelay: 750 });
    assert.deepEqual(commands, [
        ["ci", "--no-audit", "--no-fund"],
        ["run", "build"]
    ]);
    assert.deepEqual(progressEvents, [
        {
            phase: "install",
            status: "start",
            command: "npm ci --no-audit --no-fund"
        },
        {
            phase: "install",
            status: "output",
            output: { stream: "stdout", text: "installing\n" }
        },
        { phase: "install", status: "complete" },
        {
            phase: "build",
            status: "start",
            command: "npm run build"
        },
        {
            phase: "build",
            status: "output",
            output: { stream: "stderr", text: "building\n" }
        },
        { phase: "build", status: "complete" }
    ]);
    assert.equal(fs.existsSync(path.join(preview.cacheDirectory, "package.json")), false);

    const previewServer = await createPreviewServer(preview);
    t.after(() => previewServer.close());
    assert.equal(await readUrl(previewServer.url), "built");
    assert.equal(
        await readUrl(new URL("/assets/app.js", previewServer.url)),
        "built asset"
    );

    const reused = await prepareWebZip(source, { cacheRoot });
    assert.equal(reused.cacheDirectory, preview.cacheDirectory);
    assert.equal(commands.length, 2);
});

test("requires npmz packages to define a build script even when root index.html exists", async t => {
    const workspace = await makeWorkspace(t);
    const source = path.join(workspace, "invalid.npmz");
    await createZip(source, {
        "index.html": "must not be treated as a static package",
        "package.json": JSON.stringify({ name: "invalid", scripts: {} })
    });

    await assert.rejects(
        prepareWebZip(source, {
            cacheRoot: path.join(workspace, "cache"),
            allowNpmBuild: true,
            npmCommandRunner: async () => assert.fail("npm must not run")
        }),
        /must define a build script/
    );
});

test("requires npmz builds to create dist index.html", async t => {
    const workspace = await makeWorkspace(t);
    const source = path.join(workspace, "missing-dist.npmz");
    await createZip(source, {
        "package.json": JSON.stringify({ scripts: { build: "custom-build" } })
    });

    await assert.rejects(
        prepareWebZip(source, {
            cacheRoot: path.join(workspace, "cache"),
            allowNpmBuild: true,
            npmCommandRunner: async () => undefined
        }),
        /must create dist\/index\.html/
    );
});

test("treats zero and invalid capture delays as no delay", async t => {
    const workspace = await makeWorkspace(t);
    const values = [0, -1, 1.5, "1000", null];

    for (const [index, captureDelay] of values.entries()) {
        const source = path.join(workspace, `delay-${index}.htmz`);
        await createZip(source, {
            "index.html": "configured",
            "manifest.json": JSON.stringify({ thumbnail: { captureDelay } })
        });
        const preview = await prepareWebZip(source, {
            cacheRoot: path.join(workspace, `delay-cache-${index}`)
        });
        assert.deepEqual(preview.thumbnail, { captureDelay: 0 });
    }
});

test("treats zero and non-numeric manifest dimensions as auto", async t => {
    const workspace = await makeWorkspace(t);
    const cases = [
        [{ width: 0, height: "auto" }, { width: "auto", height: "auto" }],
        [{ width: "1280", height: null }, { width: "auto", height: "auto" }],
        [{ width: -10, height: {} }, { width: "auto", height: "auto" }]
    ];

    for (const [index, [configured, expected]] of cases.entries()) {
        const name = `case-${index}.htmz`;
        const source = path.join(workspace, name);
        await createZip(source, {
            "index.html": "configured",
            "manifest.json": JSON.stringify({ window: configured })
        });
        const preview = await prepareWebZip(source, {
            cacheRoot: path.join(workspace, `cache-${name}`)
        });
        assert.deepEqual(preview.window, expected);
    }
});

test("ignores malformed root manifests", async t => {
    const workspace = await makeWorkspace(t);
    const source = path.join(workspace, "malformed.htmz");
    await createZip(source, {
        "index.html": "configured",
        "manifest.json": "{not valid json"
    });

    const preview = await prepareWebZip(source, { cacheRoot: path.join(workspace, "cache") });
    assert.deepEqual(preview.window, { width: "auto", height: "auto" });
    assert.deepEqual(preview.thumbnail, { captureDelay: 0 });
});

test("reuses cache until the source file changes", async t => {
    const workspace = await makeWorkspace(t);
    const source = path.join(workspace, "sample.htmz");
    const cacheRoot = path.join(workspace, "cache");
    await createZip(source, { "index.html": "first" });

    const first = await prepareWebZip(source, { cacheRoot });
    const second = await prepareWebZip(source, { cacheRoot });
    assert.equal(second.cacheDirectory, first.cacheDirectory);

    await new Promise(resolve => setTimeout(resolve, 20));
    await createZip(source, { "index.html": "second version" });
    const changed = await prepareWebZip(source, { cacheRoot });
    assert.notEqual(changed.cacheDirectory, first.cacheDirectory);
    assert.equal(await fs.promises.readFile(changed.indexPath, "utf8"), "second version");
});

test("rejects packages without a root index.html", async t => {
    const workspace = await makeWorkspace(t);
    const source = path.join(workspace, "invalid.htmz");
    await createZip(source, { "site/index.html": "nested" });

    await assert.rejects(
        prepareWebZip(source, { cacheRoot: path.join(workspace, "cache") }),
        /must contain index\.html at its root/
    );
});

test("rejects ZIP path traversal entries", async t => {
    const workspace = await makeWorkspace(t);
    const source = path.join(workspace, "unsafe.htmz");
    await createZip(source, {
        "index.html": "valid entry",
        "xx/escape.txt": "must not escape"
    });
    await replaceZipEntryName(source, "xx/escape.txt", "../escape.txt");

    await assert.rejects(
        prepareWebZip(source, { cacheRoot: path.join(workspace, "cache") }),
        /invalid relative path|Unsafe path/
    );
    assert.equal(fs.existsSync(path.join(workspace, "escape.txt")), false);
});

test("removes cache entries not accessed for more than seven days", async t => {
    const workspace = await makeWorkspace(t);
    const source = path.join(workspace, "sample.htmz");
    const cacheRoot = path.join(workspace, "cache");
    const now = Date.now();
    await createZip(source, { "index.html": "cached" });
    const preview = await prepareWebZip(source, { cacheRoot, now });

    const oldDate = new Date(now - (8 * 24 * 60 * 60 * 1000));
    await fs.promises.utimes(path.join(preview.cacheDirectory, ".last-access"), oldDate, oldDate);
    await cleanupPreviewCache({ cacheRoot, now, force: true });

    assert.equal(fs.existsSync(preview.cacheDirectory), false);
});
