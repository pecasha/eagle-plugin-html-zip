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

function runViewer(prepareWebZip) {
    const frame = {
        hidden: false,
        title: "",
        addEventListener() {},
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
    const translations = {
        "manifest.app.name": "Web Zip",
        "viewer.title": "Web Zip Preview",
        "viewer.npmBuildConfirm": "Build now?",
        "viewer.npmPreparing": "Preparing npm project...",
        "viewer.npmInstalling": "Installing dependencies...",
        "viewer.npmRunningBuild": "Building npm project...",
        "viewer.npmConsoleTitle": "Current command and output"
    };
    const window = {
        addEventListener() {},
        confirm: () => true,
        i18next: { t: key => translations[key] || key },
        location: { search: "?path=sample.npmz" }
    };
    const document = {
        documentElement: { dataset: {}, lang: "" },
        querySelector(selector) {
            return {
                ".preview-frame": frame,
                ".status": status,
                ".status-message": statusMessage,
                ".npm-console": npmConsole,
                ".npm-console-title": npmConsoleTitle,
                ".npm-output": npmOutput
            }[selector];
        },
        title: ""
    };
    const context = vm.createContext({
        Buffer,
        URLSearchParams,
        clearTimeout,
        console,
        document,
        requestAnimationFrame: callback => setImmediate(callback),
        require(moduleName) {
            if (moduleName === "url") {
                return { pathToFileURL: filePath => ({ href: `file://${filePath}` }) };
            }
            return {
                createPreviewServer: async () => ({
                    close: async () => undefined,
                    url: "http://127.0.0.1:1234/index.html"
                }),
                prepareWebZip
            };
        },
        setTimeout,
        window
    });

    vm.runInContext(viewerSource, context);
    return { frame, npmConsole, npmConsoleTitle, npmOutput, status, statusMessage };
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

    await buildStarted;
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
});
