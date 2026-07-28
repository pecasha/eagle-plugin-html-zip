const fs = require("fs");
const { ipcRenderer } = require("electron");
const { pathToFileURL } = require("url");
const { prepareHtmlZip } = require("../core/index.ts");

const PAGE_LOAD_TIMEOUT_MS = 30_000;

module.exports = async ({ src, dest, item }) => {
    const {
        indexPath,
        window: windowConfig,
        thumbnail: thumbnailConfig
    } = await prepareHtmlZip(src);
    const frame = createPreviewFrame();
    const source = pathToFileURL(indexPath).href;

    try {
        applyConfiguredFrameSize(frame, windowConfig);
        await loadFrame(frame, source);
        const frameDocument = getFrameDocument(frame);
        await waitForPageContent(frameDocument);
        const captureSize = await fitPreviewWindow(frame, frameDocument, windowConfig, source);
        if (thumbnailConfig.captureDelay > 0) {
            await delay(thumbnailConfig.captureDelay);
            await waitForLayout();
        }
        const jpeg = await capturePreview(frame, captureSize);
        await fs.promises.writeFile(dest, Buffer.from(jpeg));
        item.width = captureSize.width || item.width;
        item.height = captureSize.height || item.height;
        return item;
    } finally {
        frame.remove();
    }
};

function createPreviewFrame() {
    document.documentElement.style.cssText = "width:100%;height:100%;margin:0;overflow:hidden;background:#fff";
    document.body.style.cssText = "width:100%;height:100%;margin:0;overflow:hidden;background:#fff";

    const frame = document.createElement("iframe");
    frame.setAttribute("title", "HTML Zip thumbnail");
    frame.style.cssText = "display:block;width:100%;height:100%;border:0;background:#fff";
    document.body.appendChild(frame);
    return frame;
}

function loadFrame(frame, source) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            cleanup();
            reject(new Error("Timed out while loading index.html"));
        }, PAGE_LOAD_TIMEOUT_MS);
        const cleanup = () => {
            clearTimeout(timeout);
            frame.removeEventListener("load", onLoaded);
            frame.removeEventListener("error", onFailed);
        };
        const onLoaded = () => {
            cleanup();
            resolve();
        };
        const onFailed = () => {
            cleanup();
            reject(new Error("Unable to load index.html"));
        };

        frame.addEventListener("load", onLoaded);
        frame.addEventListener("error", onFailed);
        frame.src = source;
    });
}

function getFrameDocument(frame) {
    try {
        if (frame.contentDocument?.documentElement) {
            return frame.contentDocument;
        }
    } catch (error) {
        throw new Error(`Unable to access the rendered HTML document: ${error.message}`);
    }
    throw new Error("Unable to access the rendered HTML document");
}

function applyConfiguredFrameSize(frame, windowConfig) {
    if (windowConfig.width !== "auto") {
        frame.style.width = `${windowConfig.width}px`;
        document.documentElement.style.width = `${windowConfig.width}px`;
        document.body.style.width = `${windowConfig.width}px`;
    }
    if (windowConfig.height !== "auto") {
        frame.style.height = `${windowConfig.height}px`;
        document.documentElement.style.height = `${windowConfig.height}px`;
        document.body.style.height = `${windowConfig.height}px`;
    }
}

async function fitPreviewWindow(frame, frameDocument, windowConfig, source) {
    let captureSize = resolveWindowSize(frameDocument, windowConfig);
    if (frame.clientWidth === captureSize.width && frame.clientHeight === captureSize.height) {
        return captureSize;
    }

    await setFrameViewport(frame, captureSize);

    // Reload so page initialization code sees the final iframe viewport dimensions.
    await loadFrame(frame, source);
    const reloadedDocument = getFrameDocument(frame);
    await waitForPageContent(reloadedDocument);

    const settledSize = resolveWindowSize(reloadedDocument, windowConfig);
    if (settledSize.width !== captureSize.width || settledSize.height !== captureSize.height) {
        captureSize = settledSize;
        await setFrameViewport(frame, captureSize);
        await loadFrame(frame, source);
        await waitForPageContent(getFrameDocument(frame));
    }
    return captureSize;
}

async function setFrameViewport(frame, size) {
    frame.style.width = `${size.width}px`;
    frame.style.height = `${size.height}px`;
    document.documentElement.style.width = `${size.width}px`;
    document.documentElement.style.height = `${size.height}px`;
    document.body.style.width = `${size.width}px`;
    document.body.style.height = `${size.height}px`;
    await waitForLayout();
}

function resolveWindowSize(frameDocument, windowConfig) {
    const contentSize = measureDocument(frameDocument);
    return {
        width: windowConfig.width === "auto" ? contentSize.width : windowConfig.width,
        height: windowConfig.height === "auto" ? contentSize.height : windowConfig.height
    };
}

function measureDocument(frameDocument) {
    const root = frameDocument.documentElement;
    const body = frameDocument.body;
    return {
        width: Math.max(1, Math.ceil(Math.max(
            root.scrollWidth,
            root.offsetWidth,
            body?.scrollWidth || 0,
            body?.offsetWidth || 0
        ))),
        height: Math.max(1, Math.ceil(Math.max(
            root.scrollHeight,
            root.offsetHeight,
            body?.scrollHeight || 0,
            body?.offsetHeight || 0
        )))
    };
}

function waitForLayout() {
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
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
                await waitForLayout();

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

async function waitForPageContent(frameDocument) {
    if (frameDocument.fonts?.ready) {
        await Promise.race([frameDocument.fonts.ready, delay(3_000)]);
    }

    await Promise.all(Array.from(frameDocument.images).map(image => {
        if (image.complete) {
            return Promise.resolve();
        }
        return Promise.race([
            new Promise(resolve => {
                image.addEventListener("load", resolve, { once: true });
                image.addEventListener("error", resolve, { once: true });
            }),
            delay(3_000)
        ]);
    }));

    await Promise.all(Array.from(frameDocument.querySelectorAll("video")).map(video => {
        if (video.readyState >= 2) {
            return Promise.resolve();
        }
        return Promise.race([
            new Promise(resolve => {
                video.addEventListener("loadeddata", resolve, { once: true });
                video.addEventListener("error", resolve, { once: true });
            }),
            delay(3_000)
        ]);
    }));

    await waitForLayout();
}

function delay(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}
