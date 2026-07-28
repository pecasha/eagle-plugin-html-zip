const { pathToFileURL } = require("url");
const { prepareHtmlZip } = require("../core/index.ts");

(async function initializeViewer() {
    const params = new URLSearchParams(window.location.search);
    const filePath = params.get("path");
    const theme = params.get("theme") || "light";
    const lang = params.get("lang") || "en";
    const frame = document.querySelector(".preview-frame");
    const status = document.querySelector(".status");
    const statusMessage = document.querySelector(".status-message");

    document.documentElement.dataset.theme = theme;
    document.documentElement.lang = lang;
    document.title = i18next.t("viewer.title");
    frame.title = i18next.t("viewer.title");
    statusMessage.textContent = i18next.t("viewer.loading");
    frame.hidden = true;

    if (!filePath) {
        showError(i18next.t("viewer.missingPath"));
        return;
    }

    try {
        const { indexPath } = await prepareHtmlZip(filePath);
        frame.addEventListener("load", () => {
            frame.hidden = false;
            status.hidden = true;
        }, { once: true });
        frame.src = pathToFileURL(indexPath).href;
    } catch (error) {
        console.error(error);
        const detail = error && error.message ? error.message : String(error);
        showError(i18next.t("viewer.openFailed", { message: detail }));
    }

    function showError(message) {
        frame.hidden = true;
        status.hidden = false;
        status.classList.add("is-error");
        statusMessage.textContent = message;
    }
})();
