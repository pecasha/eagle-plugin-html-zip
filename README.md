# Eagle HTML Zip Format Extension

An Eagle format extension for previewing static HTML archives stored as `.htmz` files.

An `.htmz` file is a standard ZIP archive whose root directory must contain an `index.html` file. JavaScript, CSS, images, videos, and other resources referenced through relative paths are extracted with the page and loaded directly by Chromium.

The archive root may contain a `manifest.json` file that configures the page viewport and thumbnail capture behavior:

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

## Cache

Extracted previews are cached in the `eagle-html-zip-preview` folder under the system temporary directory. Cache keys include the source path, file size, and modification time. Each use refreshes the access timestamp, and the first cache access of each day removes previews that have not been opened for more than seven days.

## Testing

```shell
pnpm test
```
