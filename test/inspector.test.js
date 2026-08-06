const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const inspectorHtml = fs.readFileSync(
    path.join(__dirname, "..", "src", "plugin", "inspector.html"),
    "utf8"
);
const inspectorSource = inspectorHtml.match(/<script>([\s\S]*?)<\/script>/)?.[1];

function createElement() {
    const listeners = new Map();
    const classes = new Set();
    return {
        classList: {
            add(value) {
                classes.add(value);
            },
            contains(value) {
                return classes.has(value);
            }
        },
        dataset: {},
        disabled: false,
        textContent: "",
        title: "",
        addEventListener(type, listener) {
            listeners.set(type, listener);
        },
        emit(type) {
            listeners.get(type)?.();
        },
        removeAttribute(name) {
            delete this[name];
        }
    };
}

function runInspector(search = "?id=item-1&theme=dark&lang=en", translationsReady = true) {
    const button = createElement();
    const status = createElement();
    const content = createElement();
    content["aria-hidden"] = "true";
    const errorBoxes = [];
    const timers = new Map();
    let nextTimerId = 1;
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
        close() {}
    }
    const translations = {
        "manifest.app.name": "Web Zip",
        "inspector.title": "Web Zip Thumbnail",
        "inspector.generateThumbnail": "Generate thumbnail",
        "inspector.checkingViewer": "Checking the format preview...",
        "inspector.generating": "Generating...",
        "inspector.success": "Thumbnail updated",
        "inspector.failed": "Unable to generate thumbnail: {{message}}",
        "inspector.viewerUnavailable": "Viewer unavailable",
        "inspector.missingId": "Missing ID"
    };
    const window = {
        addEventListener() {},
        i18next: {
            t(key, values = {}) {
                if (!translationsReady) return key;
                return (translations[key] || key).replace(/{{(\w+)}}/g, (_, name) => values[name] ?? "");
            }
        },
        location: { search }
    };
    const document = {
        documentElement: { dataset: {}, lang: "" },
        querySelector(selector) {
            return {
                ".inspector-content": content,
                ".generate-thumbnail": button,
                ".thumbnail-status": status
            }[selector];
        },
        title: ""
    };
    const context = vm.createContext({
        BroadcastChannel: TestBroadcastChannel,
        Date,
        Math,
        URLSearchParams,
        clearTimeout(timerId) {
            timers.delete(timerId);
        },
        document,
        eagle: {
            dialog: {
                showErrorBox(title, message) {
                    errorBoxes.push({ title, message });
                }
            }
        },
        requestAnimationFrame: callback => setImmediate(callback),
        setTimeout(callback, delay) {
            const timerId = nextTimerId;
            nextTimerId += 1;
            timers.set(timerId, { callback, delay });
            return timerId;
        },
        window
    });

    vm.runInContext(inspectorSource, context);
    return {
        button,
        content,
        document,
        errorBoxes,
        get broadcastChannel() {
            return broadcastChannel;
        },
        runTimers(delay) {
            for (const [timerId, timer] of [...timers]) {
                if (timer.delay === delay) {
                    timers.delete(timerId);
                    timer.callback();
                }
            }
        },
        loadTranslations() {
            translationsReady = true;
            this.runTimers(50);
        },
        status
    };
}

test("requests and reports thumbnail generation over the item ID channel", async () => {
    const inspector = runInspector();
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(inspector.document.documentElement.dataset.theme, "dark");
    assert.equal(inspector.document.title, "Web Zip Thumbnail");
    assert.equal(inspector.button.textContent, "Generate thumbnail");
    assert.equal(inspector.broadcastChannel.name, "webzip-item-1");

    inspector.button.emit("click");
    assert.equal(inspector.button.disabled, true);
    assert.equal(inspector.status.textContent, "Checking the format preview...");
    assert.equal(inspector.broadcastChannel.messages.length, 1);
    const heartbeat = inspector.broadcastChannel.messages[0];
    assert.equal(heartbeat.type, "viewer-ping");

    inspector.broadcastChannel.emit({
        type: "viewer-pong",
        requestId: heartbeat.requestId
    });
    assert.equal(inspector.status.textContent, "Generating...");
    assert.equal(inspector.broadcastChannel.messages.length, 2);
    const request = inspector.broadcastChannel.messages[1];
    assert.equal(request.type, "generate-thumbnail");
    assert.equal(request.requestId, heartbeat.requestId);

    inspector.broadcastChannel.emit({
        type: "generate-thumbnail-result",
        requestId: request.requestId,
        ok: true
    });
    assert.equal(inspector.button.disabled, false);
    assert.equal(inspector.status.dataset.state, "success");
    assert.equal(inspector.status.textContent, "Thumbnail updated");
    assert.deepEqual(inspector.errorBoxes, []);
});

test("keeps controls hidden until i18next is ready", async () => {
    const inspector = runInspector("?id=item-1&theme=dark&lang=en", false);

    assert.equal(inspector.content.classList.contains("is-ready"), false);
    assert.equal(inspector.content["aria-hidden"], "true");
    assert.equal(inspector.button.textContent, "");

    inspector.loadTranslations();
    await new Promise(resolve => setImmediate(resolve));
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(inspector.content.classList.contains("is-ready"), true);
    assert.equal(inspector.content["aria-hidden"], undefined);
    assert.equal(inspector.button.textContent, "Generate thumbnail");
});

test("does not generate when the format preview does not answer the heartbeat", async () => {
    const inspector = runInspector();
    await new Promise(resolve => setImmediate(resolve));

    inspector.button.emit("click");
    assert.equal(inspector.broadcastChannel.messages.length, 1);
    assert.equal(inspector.broadcastChannel.messages[0].type, "viewer-ping");

    inspector.runTimers(3_000);
    assert.equal(inspector.button.disabled, false);
    assert.equal(inspector.status.textContent, "");
    assert.deepEqual(inspector.errorBoxes, [{
        title: "Web Zip Thumbnail",
        message: "Viewer unavailable"
    }]);
    assert.equal(inspector.broadcastChannel.messages.length, 1);
});

test("shows viewer thumbnail errors in an Eagle error dialog", async () => {
    const inspector = runInspector();
    await new Promise(resolve => setImmediate(resolve));

    inspector.button.emit("click");
    const heartbeat = inspector.broadcastChannel.messages[0];
    inspector.broadcastChannel.emit({
        type: "viewer-pong",
        requestId: heartbeat.requestId
    });
    inspector.broadcastChannel.emit({
        type: "generate-thumbnail-result",
        requestId: heartbeat.requestId,
        ok: false,
        message: "Capture failed"
    });

    assert.equal(inspector.button.disabled, false);
    assert.equal(inspector.status.textContent, "");
    assert.deepEqual(inspector.errorBoxes, [{
        title: "Web Zip Thumbnail",
        message: "Unable to generate thumbnail: Capture failed"
    }]);
});

test("disables thumbnail generation when the item ID is missing", async () => {
    const inspector = runInspector("?theme=light&lang=en");
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(inspector.button.disabled, true);
    assert.equal(inspector.status.textContent, "");
    assert.deepEqual(inspector.errorBoxes, [{
        title: "Web Zip Thumbnail",
        message: "Missing ID"
    }]);
    assert.equal(inspector.broadcastChannel, undefined);
});
