const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomBytes } = require("crypto");
const { ipcRenderer } = require("electron");
const { pathToFileURL } = require("url");
const { createPreviewServer, prepareWebZip } = require("../core/index.ts");
const MAX_NPM_OUTPUT_LENGTH = 12_000;
const BROADCAST_CHANNEL_PREFIX = "webzip-";
const VIEWER_PING_MESSAGE = "viewer-ping";
const VIEWER_PONG_MESSAGE = "viewer-pong";
const GENERATE_THUMBNAIL_MESSAGE = "generate-thumbnail";
const THUMBNAIL_RESULT_MESSAGE = "generate-thumbnail-result";
let translatorPromise;

(async function initializeViewer() {
    const translate = await waitForTranslator();
    const params = new URLSearchParams(window.location.search);
    const id = params.get("id");
    const filePath = params.get("path");
    const theme = params.get("theme") || "light";
    const lang = params.get("lang") || "en";
    const frame = document.querySelector(".preview-frame");
    const status = document.querySelector(".status");
    const statusMessage = document.querySelector(".status-message");
    const npmConsole = document.querySelector(".npm-console");
    const npmConsoleTitle = document.querySelector(".npm-console-title");
    const npmOutput = document.querySelector(".npm-output");
    const npmConsent = document.querySelector(".npm-consent");
    const npmConsentTitle = document.querySelector(".npm-consent-title");
    const npmConsentMessage = document.querySelector(".npm-consent-message");
    const npmConsentCancel = document.querySelector(".npm-consent-cancel");
    const npmConsentApprove = document.querySelector(".npm-consent-approve");
    let npmOutputText = "";
    let previewServer = null;
    let thumbnailChannel = null;

    document.documentElement.dataset.theme = theme;
    document.documentElement.lang = lang;
    document.title = translate("viewer.title");
    frame.title = translate("viewer.title");
    npmConsoleTitle.textContent = translate("viewer.npmConsoleTitle");
    npmConsentTitle.textContent = translate("viewer.npmConsentTitle");
    npmConsentMessage.textContent = translate("viewer.npmBuildConfirm");
    npmConsentCancel.textContent = translate("viewer.npmConsentCancel");
    npmConsentApprove.textContent = translate("viewer.npmConsentApprove");
    frame.hidden = true;

    if (id) {
        thumbnailChannel = new BroadcastChannel(`${BROADCAST_CHANNEL_PREFIX}${id}`);
        thumbnailChannel.addEventListener("message", event => {
            const message = event.data;
            if (message?.type === VIEWER_PING_MESSAGE) {
                thumbnailChannel.postMessage({
                    type: VIEWER_PONG_MESSAGE,
                    requestId: message.requestId
                });
                return;
            }
            if (message?.type === GENERATE_THUMBNAIL_MESSAGE) {
                void generateAndSaveThumbnail(message.requestId);
            }
        });
        window.addEventListener("beforeunload", () => thumbnailChannel.close(), { once: true });
    }

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
            if (!await requestNpmBuildPermission()) {
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
        npmConsent.hidden = true;
        status.hidden = false;
        status.classList.remove("is-building");
        status.classList.add("is-error");
        statusMessage.textContent = message;
    }

    function requestNpmBuildPermission() {
        status.hidden = true;
        npmConsent.hidden = false;
        requestAnimationFrame(() => npmConsentCancel.focus());

        return new Promise(resolve => {
            const finish = allowed => {
                npmConsentCancel.removeEventListener("click", cancel);
                npmConsentApprove.removeEventListener("click", approve);
                npmConsent.hidden = true;
                resolve(allowed);
            };
            const cancel = () => finish(false);
            const approve = () => finish(true);

            npmConsentCancel.addEventListener("click", cancel);
            npmConsentApprove.addEventListener("click", approve);
        });
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

    async function generateAndSaveThumbnail(requestId) {
        let resultSent = false;
        try {
            if (!id) {
                throw new Error("Missing Eagle item ID");
            }
            if (frame.hidden || !frame.src) {
                throw new Error("The preview is not ready");
            }

            await waitForPaint();
            const bounds = frame.getBoundingClientRect();
            const thumbnailData = await capturePreview(frame, {
                width: Math.max(1, Math.round(bounds.width)),
                height: Math.max(1, Math.round(bounds.height))
            });
            const item = await eagle.item.getById(id);
            if (!item) {
                throw new Error("Unable to find the Eagle item");
            }
            await setCustomThumbnailFromData(item, thumbnailData, () => {
                resultSent = true;
                thumbnailChannel?.postMessage({
                    type: THUMBNAIL_RESULT_MESSAGE,
                    requestId,
                    ok: true
                });
            });
        } catch (error) {
            console.error(error);
            if (!resultSent) {
                thumbnailChannel?.postMessage({
                    type: THUMBNAIL_RESULT_MESSAGE,
                    requestId,
                    ok: false,
                    message: error?.message || String(error)
                });
            }
        }
    }
})();

async function setCustomThumbnailFromData(item, thumbnailData, onSubmitted) {
    const tempPath = path.join(
        os.tmpdir(),
        `eagle-web-zip-thumbnail-${Date.now()}-${randomBytes(6).toString("hex")}.jpg`
    );
    await fs.promises.writeFile(tempPath, Buffer.from(thumbnailData));
    try {
        const update = item.setCustomThumbnail(tempPath);
        onSubmitted();
        await update;
    } finally {
        await fs.promises.unlink(tempPath).catch(() => undefined);
    }
}

async function capturePreview(frame, captureSize) {
    const viewportWidth = Math.max(1, Math.min(window.innerWidth, captureSize.width));
    const viewportHeight = Math.max(1, Math.min(window.innerHeight, captureSize.height));
    const canvas = document.createElement("canvas");
    canvas.width = captureSize.width;
    canvas.height = captureSize.height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) {
        throw new Error("Unable to create the thumbnail canvas");
    }
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);

    frame.style.position = "fixed";
    try {
        for (let y = 0; y < captureSize.height; y += viewportHeight) {
            for (let x = 0; x < captureSize.width; x += viewportWidth) {
                const tileWidth = Math.min(viewportWidth, captureSize.width - x);
                const tileHeight = Math.min(viewportHeight, captureSize.height - y);
                frame.style.left = `${-x}px`;
                frame.style.top = `${-y}px`;
                await waitForPaint();

                const nativeImage = await captureVisiblePage(tileWidth, tileHeight);
                const image = await loadNativeImage(nativeImage);
                context.drawImage(image, x, y, tileWidth, tileHeight);
            }
        }
    } finally {
        frame.style.position = "";
        frame.style.left = "";
        frame.style.top = "";
    }

    return encodeCanvasJpeg(canvas);
}

async function encodeCanvasJpeg(canvas) {
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 1));
    if (!blob?.size) {
        throw new Error("Unable to encode the page capture");
    }
    return blob.arrayBuffer();
}

async function captureVisiblePage(width, height) {
    const image = await ipcRenderer.invoke("plugin.window.webContents.", {
        method: "capturePage",
        value: { x: 0, y: 0, width, height }
    });
    if (!image || typeof image.toDataURL !== "function") {
        throw new Error("Eagle did not return a valid page capture");
    }
    return image;
}

function loadNativeImage(nativeImage) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.addEventListener("load", () => resolve(image), { once: true });
        image.addEventListener("error", () => reject(new Error("Unable to decode the page capture")), {
            once: true
        });
        image.src = nativeImage.toDataURL();
    });
}

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
