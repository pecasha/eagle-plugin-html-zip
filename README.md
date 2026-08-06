# Eagle Web Zip Format Extension

An Eagle format extension for previewing static web archives stored as `.htmz` files and buildable npm projects stored as `.npmz` files.

## Formats

### Static HTML (`.htmz`)

An `.htmz` file is a standard ZIP archive whose root directory must contain an `index.html` file. JavaScript, CSS, images, videos, and other resources referenced through relative paths are extracted with the page and loaded directly by Chromium.

### npm project (`.npmz`)

An `.npmz` file is a standard ZIP archive whose root directory must contain a `package.json` file with a non-empty `scripts.build` command. The project must produce `dist/index.html` when `npm run build` completes.

The first time an `.npmz` file is opened, the plugin asks for confirmation before executing any project code. After confirmation it runs:

```shell
# Used when package-lock.json exists
npm ci --no-audit --no-fund

# Used when package-lock.json does not exist
npm install --no-audit --no-fund

npm run build
```

While these commands run, the viewer shows the current install or build phase and streams recent npm console output into the loading screen.

Node.js and npm must be installed and available on the system `PATH`. Each command has a 15-minute timeout. A lock file is strongly recommended so that dependency installation is reproducible.

Only the generated `dist` directory and the root `manifest.json` are retained in the completed preview cache. Source files and `node_modules` are removed with the temporary build directory.

Built output is served by an ephemeral HTTP server bound only to `127.0.0.1`. This allows default Vite-style absolute asset paths such as `/assets/app.js` to work. The server is closed when the viewer or thumbnail capture ends.

> [!WARNING]
> Installing dependencies and running npm scripts can execute arbitrary commands with the current user's permissions. Only build `.npmz` files from sources you trust.

The `.npmz` format does not register an automatic thumbnail handler. While its format preview is open, use the inspector's **Generate thumbnail** button to capture the current preview and save it as the item's custom thumbnail. The inspector checks that the matching viewer is open before starting the capture and reports when the preview is unavailable. Dependency installation and project builds only begin after the user opens the viewer and approves the security prompt.

## Preview configuration

Both `.htmz` and `.npmz` archives may contain a `manifest.json` file at the archive root. It configures the page viewport and thumbnail capture behavior:

```json
{
    "window": {
        "width": 1280,
        "height": 720
    },
    "thumbnail": {
        "captureDelay": 1500
    }
}
```

`window.width` and `window.height` both default to `"auto"`, which derives the corresponding dimension from the page content. Positive numbers set an explicit dimension, with decimal portions truncated. Zero, negative numbers, and values of other types are treated as `"auto"`.

`thumbnail.captureDelay` is the time in milliseconds to wait between the final page load and the start of thumbnail capture. It must be a non-negative integer. An omitted value or `0` adds no delay.

Configured dimensions may exceed the available screen resolution. The plugin creates the page viewport at the requested size, captures regions outside the visible window in tiles, and combines them into a complete thumbnail.

## Cache

Extracted and built previews are cached in the `eagle-web-zip-preview` folder under the system temporary directory. Cache keys include the archive format, source path, file size, and modification time. Each use refreshes the access timestamp, and the first cache access of each day removes previews that have not been opened for more than seven days. Caches created by older HTML Zip versions are also checked and expire under the same rule.

Concurrent requests for the same archive share a filesystem preparation lock, preventing duplicate extraction, dependency installation, or builds.

## Development

```shell
pnpm install
pnpm run build:test
```

Create a production build:

```shell
pnpm run build:prod
```

The complete plugin is written to `dist`. In Eagle, press `P` to open the plugin panel, select **Developer Options** > **Import Local Project**, and choose the `dist` directory.

## Testing

```shell
pnpm test
```
