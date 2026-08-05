const { pathToFileURL } = require("url");
const { createPreviewServer, prepareWebZip } = require("../core/index.ts");
const MAX_NPM_OUTPUT_LENGTH = 12_000;
let translatorPromise;

(async function initializeViewer() {
    const translate = await waitForTranslator();
    const params = new URLSearchParams(window.location.search);
    const filePath = params.get("path");
    const theme = params.get("theme") || "light";
    const lang = params.get("lang") || "en";
    const frame = document.querySelector(".preview-frame");
    const status = document.querySelector(".status");
    const statusMessage = document.querySelector(".status-message");
    const npmConsole = document.querySelector(".npm-console");
    const npmConsoleTitle = document.querySelector(".npm-console-title");
    const npmOutput = document.querySelector(".npm-output");
    let npmOutputText = "";
    let previewServer = null;

    document.documentElement.dataset.theme = theme;
    document.documentElement.lang = lang;
    document.title = translate("viewer.title");
    frame.title = translate("viewer.title");
    npmConsoleTitle.textContent = translate("viewer.npmConsoleTitle");
    frame.hidden = true;

    if (!filePath) {
        showError(translate("viewer.missingPath"));
        return;
    }

    try {
        let preview;
        try {
            preview = await prepareWebZip(filePath);
        } catch (error) {
            if (error?.code !== "NPM_BUILD_PERMISSION_REQUIRED") {
                throw error;
            }
            if (!window.confirm(translate("viewer.npmBuildConfirm"))) {
                showError(translate("viewer.npmBuildCancelled"));
                return;
            }
            showNpmStage("viewer.npmPreparing");
            await waitForPaint();
            preview = await prepareWebZip(filePath, {
                allowNpmBuild: true,
                onNpmProgress: showNpmProgress
            });
        }

        const source = preview.format === "npmz"
            ? (previewServer = await createPreviewServer(preview)).url
            : pathToFileURL(preview.indexPath).href;
        if (previewServer) {
            window.addEventListener("beforeunload", () => {
                void previewServer.close();
            }, { once: true });
        }
        frame.addEventListener("load", () => {
            frame.hidden = false;
            status.hidden = true;
        }, { once: true });
        frame.src = source;
    } catch (error) {
        if (previewServer) {
            await previewServer.close().catch(() => undefined);
        }
        console.error(error);
        const detail = error && error.message ? error.message : String(error);
        showError(translate("viewer.openFailed", { message: detail }));
    }

    function showError(message) {
        frame.hidden = true;
        status.hidden = false;
        status.classList.remove("is-building");
        status.classList.add("is-error");
        statusMessage.textContent = message;
    }

    function showNpmProgress(event) {
        if (event.status === "start") {
            showNpmStage(event.phase === "install"
                ? "viewer.npmInstalling"
                : "viewer.npmRunningBuild");
            if (event.phase === "install") {
                npmOutputText = "";
                npmOutput.textContent = "";
                npmConsole.hidden = true;
            }
            if (event.command) {
                appendNpmOutput(`$ ${event.command}\n`);
            }
            return;
        }
        if (event.status !== "output" || !event.output?.text) {
            return;
        }

        appendNpmOutput(stripTerminalFormatting(event.output.text));
    }

    function showNpmStage(translationKey) {
        status.hidden = false;
        status.classList.remove("is-error");
        status.classList.add("is-building");
        statusMessage.textContent = translate(translationKey);
    }

    function appendNpmOutput(text) {
        npmOutputText = `${npmOutputText}${text}`.slice(-MAX_NPM_OUTPUT_LENGTH);
        npmOutput.textContent = npmOutputText;
        npmConsole.hidden = !npmOutputText.trim();
        requestAnimationFrame(() => {
            npmOutput.scrollTop = npmOutput.scrollHeight;
        });
    }
})();

function stripTerminalFormatting(text) {
    return text
        .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, "")
        .replace(/\r(?!\n)/g, "\n");
}

function waitForPaint() {
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function waitForTranslator() {
    if (!translatorPromise) {
        translatorPromise = new Promise(resolve => {
            const detect = () => {
                try {
                    const instance = window.i18next;
                    const appName = instance?.t?.("manifest.app.name");
                    if (typeof appName === "string" && appName.trim() && appName !== "manifest.app.name") {
                        resolve(instance.t.bind(instance));
                        return;
                    }
                } catch {}
                setTimeout(detect, 50);
            };
            detect();
        });
    }
    return translatorPromise;
}
