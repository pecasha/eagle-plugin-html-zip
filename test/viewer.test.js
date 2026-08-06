const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const viewerSource = fs.readFileSync(path.join(__dirname, "..", "src", "plugin", "viewer.js"), "utf8");

function createClassList() {
    const values = new Set();
    return {
        add: value => values.add(value),
        contains: value => values.has(value),
        remove: value => values.delete(value)
    };
}

function createButton() {
    const listeners = new Set();
    return {
        focused: false,
        textContent: "",
        addEventListener(type, listener) {
            if (type === "click") listeners.add(listener);
        },
        removeEventListener(type, listener) {
            if (type === "click") listeners.delete(listener);
        },
        click() {
            for (const listener of [...listeners]) listener();
        },
        focus() {
            this.focused = true;
        }
    };
}

async function waitFor(condition, message) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        if (condition()) return;
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.fail(message);
}

function runViewer(prepareWebZip, options = {}) {
    const frameListeners = new Map();
    const frame = {
        hidden: false,
        style: {},
        title: "",
        addEventListener(type, listener) {
            frameListeners.set(type, listener);
        },
        emit(type) {
            frameListeners.get(type)?.();
        },
        getBoundingClientRect() {
            return { left: 0, top: 0, width: 640, height: 480 };
        },
        get src() {
            return this.source || "";
        },
        set src(value) {
            this.source = value;
        }
    };
    const status = { hidden: false, classList: createClassList() };
    const statusMessage = { textContent: "" };
    const npmConsole = { hidden: true };
    const npmConsoleTitle = { textContent: "" };
    const npmOutput = {
        scrollHeight: 100,
        scrollTop: 0,
        textContent: ""
    };
    const npmConsent = { hidden: true };
    const npmConsentTitle = { textContent: "" };
    const npmConsentMessage = { textContent: "" };
    const npmConsentCancel = createButton();
    const npmConsentApprove = createButton();
    const canvasDrawCalls = [];
    const canvasBlob = options.canvasBlob || new Blob(["jpeg"], { type: "image/jpeg" });
    const canvasContext = {
        fillRect() {},
        drawImage(...args) {
            canvasDrawCalls.push(args);
        }
    };
    const canvas = {
        height: 0,
        width: 0,
        getContext(type, settings) {
            assert.equal(type, "2d");
            assert.equal(settings.alpha, false);
            return canvasContext;
        },
        toBlob(callback, type, quality) {
            assert.equal(type, "image/jpeg");
            assert.equal(quality, 1);
            callback(canvasBlob);
        }
    };
    class TestImage {
        constructor() {
            this.listeners = new Map();
        }
        addEventListener(type, listener) {
            this.listeners.set(type, listener);
        }
        set src(value) {
            this.source = value;
            setImmediate(() => this.listeners.get("load")?.());
        }
    }
    let broadcastChannel;
    class TestBroadcastChannel {
        constructor(name) {
            this.name = name;
            this.messages = [];
            this.listeners = new Set();
            broadcastChannel = this;
        }
        addEventListener(type, listener) {
            if (type === "message") this.listeners.add(listener);
        }
        emit(data) {
            for (const listener of this.listeners) listener({ data });
        }
        postMessage(message) {
            this.messages.push(message);
        }
        close() {
            this.closed = true;
        }
    }
    const translations = {
        "manifest.app.name": "Web Zip",
        "viewer.title": "Web Zip Preview",
        "viewer.npmBuildConfirm": "Build now?",
        "viewer.npmConsentTitle": "Permission to run local commands",
        "viewer.npmConsentCancel": "Cancel",
        "viewer.npmConsentApprove": "Allow and build",
        "viewer.npmPreparing": "Preparing npm project...",
        "viewer.npmInstalling": "Installing dependencies...",
        "viewer.npmRunningBuild": "Building npm project...",
        "viewer.npmConsoleTitle": "Current command and output",
        "viewer.npmBuildCancelled": "Build cancelled."
    };
    const window = {
        addEventListener() {},
        i18next: { t: key => translations[key] || key },
        innerHeight: 480,
        innerWidth: 640,
        location: { search: options.search || "?id=item-1&path=sample.npmz" }
    };
    const document = {
        createElement(tagName) {
            assert.equal(tagName, "canvas");
            return canvas;
        },
        documentElement: { dataset: {}, lang: "" },
        querySelector(selector) {
            return {
                ".preview-frame": frame,
                ".status": status,
                ".status-message": statusMessage,
                ".npm-console": npmConsole,
                ".npm-console-title": npmConsoleTitle,
                ".npm-output": npmOutput,
                ".npm-consent": npmConsent,
                ".npm-consent-title": npmConsentTitle,
                ".npm-consent-message": npmConsentMessage,
                ".npm-consent-cancel": npmConsentCancel,
                ".npm-consent-approve": npmConsentApprove
            }[selector];
        },
        title: ""
    };
    const context = vm.createContext({
        BroadcastChannel: TestBroadcastChannel,
        Blob,
        Buffer,
        Image: TestImage,
        URLSearchParams,
        clearTimeout,
        console,
        document,
        eagle: {
            item: {
                getById: options.getById || (async () => ({
                    setCustomThumbnail: async () => undefined
                }))
            }
        },
        requestAnimationFrame: callback => setImmediate(callback),
        require(moduleName) {
            if (moduleName === "crypto") {
                return { randomBytes: () => Buffer.from("0123456789ab", "hex") };
            }
            if (moduleName === "electron") {
                return {
                    ipcRenderer: {
                        invoke: options.invoke || (async () => ({
                            toDataURL: () => "data:image/png;base64,AA=="
                        }))
                    }
                };
            }
            if (moduleName === "url") {
                return { pathToFileURL: filePath => ({ href: `file://${filePath}` }) };
            }
            if (moduleName === "fs") {
                return {
                    promises: {
                        unlink: options.unlink || (async () => undefined),
                        writeFile: options.writeFile || (async () => undefined)
                    }
                };
            }
            if (moduleName === "os") {
                return { tmpdir: () => "C:\\temp" };
            }
            if (moduleName === "path") {
                return path.win32;
            }
            if (moduleName === "../core/index.ts") {
                return {
                    createPreviewServer: async () => ({
                        close: async () => undefined,
                        url: "http://127.0.0.1:1234/index.html"
                    }),
                    prepareWebZip
                };
            }
            throw new Error(`Unexpected module: ${moduleName}`);
        },
        setTimeout,
        window
    });

    vm.runInContext(viewerSource, context);
    return {
        canvas,
        canvasBlob,
        canvasDrawCalls,
        frame,
        get broadcastChannel() {
            return broadcastChannel;
        },
        npmConsole,
        npmConsoleTitle,
        npmConsent,
        npmConsentApprove,
        npmConsentCancel,
        npmConsentMessage,
        npmConsentTitle,
        npmOutput,
        status,
        statusMessage
    };
}

test("shows npm status and output during the first build", async () => {
    let callCount = 0;
    let releaseBuild;
    let markBuildStarted;
    const buildStarted = new Promise(resolve => {
        markBuildStarted = resolve;
    });
    const buildRelease = new Promise(resolve => {
        releaseBuild = resolve;
    });
    const elements = runViewer(async (sourcePath, options = {}) => {
        callCount += 1;
        if (callCount === 1) {
            const error = new Error("permission required");
            error.code = "NPM_BUILD_PERMISSION_REQUIRED";
            throw error;
        }
        options.onNpmProgress({
            phase: "install",
            status: "start",
            command: "npm ci --no-audit --no-fund"
        });
        options.onNpmProgress({
            phase: "install",
            status: "output",
            output: { stream: "stdout", text: "added 128 packages\n" }
        });
        markBuildStarted();
        await buildRelease;
        return { format: "npmz", indexPath: "dist/index.html" };
    });

    await new Promise(resolve => setImmediate(resolve));
    assert.equal(elements.npmConsent.hidden, false);
    assert.equal(elements.npmConsentTitle.textContent, "Permission to run local commands");
    assert.equal(elements.npmConsentMessage.textContent, "Build now?");
    assert.equal(elements.npmConsentCancel.textContent, "Cancel");
    assert.equal(elements.npmConsentApprove.textContent, "Allow and build");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(elements.npmConsentCancel.focused, true);

    elements.npmConsentApprove.click();
    await buildStarted;
    assert.equal(elements.npmConsent.hidden, true);
    assert.equal(elements.status.hidden, false);
    assert.equal(elements.status.classList.contains("is-building"), true);
    assert.equal(elements.statusMessage.textContent, "Installing dependencies...");
    assert.equal(elements.npmConsole.hidden, false);
    assert.equal(elements.npmConsoleTitle.textContent, "Current command and output");
    assert.match(elements.npmOutput.textContent, /\$ npm ci --no-audit --no-fund/);
    assert.match(elements.npmOutput.textContent, /added 128 packages/);
    releaseBuild();
});

test("keeps status text hidden when an npmz build cache already exists", async () => {
    const elements = runViewer(async () => ({
        format: "npmz",
        indexPath: "dist/index.html"
    }));

    await new Promise(resolve => setImmediate(resolve));
    assert.equal(elements.statusMessage.textContent, "");
    assert.equal(elements.status.classList.contains("is-building"), false);
    assert.equal(elements.npmConsole.hidden, true);
    assert.equal(elements.npmConsent.hidden, true);
});

test("cancels an npmz build from the in-page permission prompt", async () => {
    let callCount = 0;
    const elements = runViewer(async () => {
        callCount += 1;
        const error = new Error("permission required");
        error.code = "NPM_BUILD_PERMISSION_REQUIRED";
        throw error;
    });

    await new Promise(resolve => setImmediate(resolve));
    assert.equal(elements.npmConsent.hidden, false);

    elements.npmConsentCancel.click();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(callCount, 1);
    assert.equal(elements.npmConsent.hidden, true);
    assert.equal(elements.status.hidden, false);
    assert.equal(elements.status.classList.contains("is-error"), true);
    assert.equal(elements.statusMessage.textContent, "Build cancelled.");
});

test("captures the viewer and saves a custom thumbnail on an inspector request", async () => {
    const thumbnailBlob = new Blob(["canvas jpeg"], { type: "image/jpeg" });
    const thumbnailBytes = await thumbnailBlob.arrayBuffer();
    const fileOperations = [];
    let thumbnailFileExists = false;
    let finishThumbnailUpdate;
    const thumbnailUpdate = new Promise(resolve => {
        finishThumbnailUpdate = resolve;
    });
    let captureCall;
    let requestedItemId;
    let savedThumbnailPath;
    let writtenThumbnail;
    const elements = runViewer(async () => ({
        format: "npmz",
        indexPath: "dist/index.html"
    }), {
        canvasBlob: thumbnailBlob,
        getById: async id => {
            requestedItemId = id;
            return {
                setCustomThumbnail: async filePath => {
                    assert.equal(thumbnailFileExists, true);
                    fileOperations.push("setCustomThumbnail");
                    savedThumbnailPath = filePath;
                    await thumbnailUpdate;
                }
            };
        },
        invoke: async (channel, payload) => {
            captureCall = { channel, payload };
            return { toDataURL: () => "data:image/png;base64,AA==" };
        },
        unlink: async filePath => {
            assert.equal(filePath, savedThumbnailPath);
            fileOperations.push("unlink");
            thumbnailFileExists = false;
        },
        writeFile: async (filePath, data) => {
            fileOperations.push("writeFile");
            thumbnailFileExists = true;
            savedThumbnailPath = filePath;
            writtenThumbnail = data;
        }
    });

    await new Promise(resolve => setImmediate(resolve));
    elements.broadcastChannel.emit({
        type: "viewer-ping",
        requestId: "heartbeat-1"
    });
    assert.deepEqual(JSON.parse(JSON.stringify(elements.broadcastChannel.messages)), [{
        type: "viewer-pong",
        requestId: "heartbeat-1"
    }]);
    elements.broadcastChannel.messages.length = 0;

    elements.frame.emit("load");
    elements.broadcastChannel.emit({
        type: "generate-thumbnail",
        requestId: "request-1"
    });
    await waitFor(
        () => elements.broadcastChannel.messages.length === 1,
        "thumbnail generation did not finish"
    );

    assert.equal(elements.broadcastChannel.name, "webzip-item-1");
    assert.equal(elements.canvas.width, 640);
    assert.equal(elements.canvas.height, 480);
    assert.equal(elements.canvasDrawCalls.length, 1);
    assert.deepEqual(elements.canvasDrawCalls[0].slice(1), [0, 0, 640, 480]);
    assert.equal(captureCall.channel, "plugin.window.webContents.");
    assert.equal(captureCall.payload.method, "capturePage");
    assert.deepEqual(
        JSON.parse(JSON.stringify(captureCall.payload.value)),
        { x: 0, y: 0, width: 640, height: 480 }
    );
    assert.equal(requestedItemId, "item-1");
    assert.match(savedThumbnailPath, /^C:\\temp\\eagle-web-zip-thumbnail-\d+-0123456789ab\.jpg$/);
    assert.deepEqual(writtenThumbnail, Buffer.from(thumbnailBytes));
    assert.deepEqual(fileOperations, ["writeFile", "setCustomThumbnail"]);
    assert.equal(thumbnailFileExists, true);
    assert.deepEqual(JSON.parse(JSON.stringify(elements.broadcastChannel.messages)), [{
        type: "generate-thumbnail-result",
        requestId: "request-1",
        ok: true
    }]);

    finishThumbnailUpdate();
    await waitFor(
        () => fileOperations.includes("unlink"),
        "temporary thumbnail was not removed"
    );
    assert.deepEqual(fileOperations, ["writeFile", "setCustomThumbnail", "unlink"]);
    assert.equal(thumbnailFileExists, false);
});
