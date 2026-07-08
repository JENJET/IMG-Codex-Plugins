---
name: "api-image-gen"
description: "Generate or edit images using the API Image Gen plugin. Trigger when the user wants AI images through OpenAI-standard Images API or Responses API, batch image generation, continuous or adaptive image generation, images saved to disk, or edits to existing images."
---

# API Image Gen

Use this skill to generate or edit raster images through API. Text-to-image and image-to-image default to OpenAI-standard Images API. Use Responses API only when config or CLI sets `imageRequestMode` to `openai-responses`.

## Script

```bash
node "$HOME/plugins/api-image-gen/scripts/generate.mjs"
```

On Windows PowerShell:

```powershell
node "$HOME\plugins\api-image-gen\scripts\generate.mjs"
```

## Entry Check

Every time this skill is triggered, run:

```bash
node "$HOME/plugins/api-image-gen/scripts/generate.mjs" --get-config
```

The output is JSON with a masked key preview. Never display the full API key. If `hasKey` is false, ask the user for their API key and save it with:

```bash
node "$HOME/plugins/api-image-gen/scripts/generate.mjs" --set-key "<USER_KEY>"
```

API call defaults are configurable. Use one-off CLI overrides when the user asks for a different upstream endpoint or model:

```bash
node "$HOME/plugins/api-image-gen/scripts/generate.mjs" --prompt "<PROMPT>" --api-root "<API_ROOT>" --image-request-mode "openai" --image-model "<IMAGE_MODEL>"
node "$HOME/plugins/api-image-gen/scripts/generate.mjs" --prompt "<PROMPT>" --api-profile "<PROFILE_NAME>"
```

Persist API call config in the local config file with:

```bash
node "$HOME/plugins/api-image-gen/scripts/generate.mjs" --set-api-config --api-root "<API_ROOT>" --image-request-mode "openai" --image-model "<IMAGE_MODEL>" --image-quality "auto"
node "$HOME/plugins/api-image-gen/scripts/generate.mjs" --set-api-config --api-profile "<PROFILE_NAME>" --api-root "<API_ROOT>" --image-request-mode "openai" --image-model "<IMAGE_MODEL>" --image-quality "high"
node "$HOME/plugins/api-image-gen/scripts/generate.mjs" --api-profile "<PROFILE_NAME>" --set-key "<USER_KEY>"
node "$HOME/plugins/api-image-gen/scripts/generate.mjs" --set-default-api "<PROFILE_NAME>"
```

The config file can contain multiple API profiles under `apis` and choose the default with `defaultApi`. Each profile can contain `apiKey`, `apiRoot`, `imageRequestMode`, optional endpoint overrides (`imageGenerationUrl`, `imageEditUrl`, `responsesUrl`), `imageModel`, and `imageQuality`. `imageRequestMode` defaults to `openai`, which sends text-to-image to `/v1/images/generations` and image-to-image to multipart `/v1/images/edits`. `imageQuality` accepts `auto`, `low`, `medium`, or `high`; `auto` means the request does not explicitly send a quality field. Set `imageRequestMode:"openai-responses"` for Infinite-Canvas OpenAI RS style `/v1/responses`; in this mode the Responses top-level `model` is the image model and `tools[0].model` is omitted. Parameters override the config file, and `--api-profile` overrides `defaultApi`. Use `--config <FILE>` or `API_IMAGE_GEN_CONFIG` to point at another config file. The legacy top-level `apiKey` plus `api` object remains supported.

```json
{
  "defaultApi": "openai",
  "apis": {
    "openai": {
      "apiKey": "<USER_KEY>",
      "apiRoot": "https://api.openai.com",
      "imageRequestMode": "openai",
      "imageModel": "gpt-image-2",
      "imageQuality": "auto"
    },
    "manxiaobai": {
      "apiKey": "<MANXIAOBAI_KEY>",
      "apiRoot": "https://api.manxiaobai.online",
      "imageRequestMode": "openai",
      "imageModel": "gpt-image-2",
      "imageQuality": "high"
    },
    "mikotopro-rs": {
      "apiKey": "<MIKOTO_KEY>",
      "apiRoot": "https://api.mikoto.vip",
      "imageRequestMode": "openai-responses",
      "imageModel": "gpt-image-2",
      "imageQuality": "high"
    }
  }
}
```

The config file can also contain custom sizes under `sizes` or `sizeMatrix`. The first level is the quality name and the second level maps an `--aspect` / `--ratio` label to a concrete `WIDTHxHEIGHT` value:

```json
{
  "sizes": {
    "1K": {
      "poster": "1024x1824",
      "1024x1824": "1024x1824"
    }
  }
}
```

## Codex Display Rule

This plugin must immediately show every successful saved image in the Codex conversation with an absolute-path Markdown image tag such as `![result](C:\absolute\path.png)`.

Apply this to all successful outputs from text-to-image, edit, `--count`, `--repeat`, batch, and batch edit runs. If multiple images succeed, show all successful images in the same reply and separately report any failed items.

## Generate

For clear text-to-image requests, do not ask for confirmation:

```bash
node "$HOME/plugins/api-image-gen/scripts/generate.mjs" --prompt "<PROMPT>"
```

Generation requests default to the 2K preset matrix. `--quality 1K` is supported for the same enabled aspect list. Do not offer 4K choices. If the user asks for another exact pixel size, pass it through `--size` when it is a concrete `WIDTHxHEIGHT` request.

Pass `--ratio`/`--aspect` when the user asks for a shape, or pass `--size` for explicit dimensions. `--size` accepts `WIDTHxHEIGHT`, `WIDTHXHEIGHT`, `WIDTH*HEIGHT`, and `WIDTH×HEIGHT`, for example `2048x1024` or `2048*1024`. Config `sizes` labels remain supported through `--aspect` or `--ratio`.

```bash
node "$HOME/plugins/api-image-gen/scripts/generate.mjs" --prompt "<PROMPT>" --aspect 16:9
```

Supported default 2K aspects are fixed to `1:1`, `3:2`, `2:3`, `4:3`, `3:4`, `16:9`, `9:16`, `2:1`, `1:2`, `7:4`, and `4:7`. `--quality 1K` supports those same enabled aspects. Aliases are `square=1:1`, `landscape=4:3`, and `portrait=3:4`.

The preset `--ratio` / `--aspect` values `5:4`, `4:5`, `3:1`, and `1:3` are disabled in this plugin because repeated upstream tests returned `502` for them. Do not re-enable those preset ratio labels unless new real tests prove they are stable. Explicit `--size WIDTHxHEIGHT` remains allowed.

Upstream may return a near-aspect image with non-exact pixels. On Windows, the script keeps the original upstream PNG, writes a center-cropped/resized copy beside it with a `_resized` suffix, and reports `resized from <original>` plus the original path. Resize is enabled by default for text-to-image, batch, and edit; pass `--no-resize` to keep the true upstream raster as the final output, or `--resize` to enable it explicitly.

For same-prompt multi-image requests, use `--count 1..9`. For longer continuous runs, use `--repeat 1..50`. Each image is a separate API request:

```bash
node "$HOME/plugins/api-image-gen/scripts/generate.mjs" --prompt "一只钓鱼的小猫" --count 9 --concurrency 3 --aspect 16:9
node "$HOME/plugins/api-image-gen/scripts/generate.mjs" --prompt "一只钓鱼的小猫" --repeat 50 --concurrency 4 --adaptive
```

Adaptive concurrency is enabled by default. If retryable upstream errors occur (`502`, `503`, `504`, `524`, rate limits, no available account, account pool busy, temporarily unavailable), the failed item retries up to 3 times and future queued work drops to `concurrency=1`.

## Batch Generate

Use batch mode for multiple different prompts:

```bash
node "$HOME/plugins/api-image-gen/scripts/generate.mjs" --batch-inline "<PROMPT_1>" "<PROMPT_2>" "<PROMPT_3>"
node "$HOME/plugins/api-image-gen/scripts/generate.mjs" --batch "<FILE.json>"
```

If batch config is missing, ask for ratio/aspect and concurrency, then save it:

```bash
node "$HOME/plugins/api-image-gen/scripts/generate.mjs" --set-batch-mode --ratio 4:3 --concurrency 3
```

## Edit Existing Images

The image-to-image route defaults to OpenAI-standard Images API. Endpoint and model values below are defaults and may be overridden by CLI flags or config:

- Default endpoint: `POST https://api.openai.com/v1/images/edits`
- Default body: multipart form with `model`, `prompt`, `size`, and one `image` field per source image
- Responses endpoint when `imageRequestMode:"openai-responses"`: `POST https://api.openai.com/v1/responses`
- Responses top-level `model`: `imageModel`; `tools[0].model` is omitted
- This is not a collage step

Default image-to-image edits use standard Images API:

```bash
node "$HOME/plugins/api-image-gen/scripts/generate.mjs" --edit --image "<IMAGE_PATH>" --prompt "<EDIT_INSTRUCTION>" --aspect 9:16
```

For multiple edit variations of one source, each variation is a separate API request with independent retry:

```bash
node "$HOME/plugins/api-image-gen/scripts/generate.mjs" --edit --image "<IMAGE_PATH>" --prompt "<EDIT_INSTRUCTION>" --count 3
```

For multi-reference image-to-image, pass multiple `--image` flags. In standard mode, each source image becomes its own multipart `image` field inside one Images Edits request. In Responses mode, each source image becomes its own `input_image` block inside one Responses edit request. The CLI argument order is preserved.

```bash
node "$HOME/plugins/api-image-gen/scripts/generate.mjs" --edit --image "<PATH_1>" --image "<PATH_2>" --prompt "<EDIT_INSTRUCTION>" --aspect 9:16
```

To force per-source batch behavior instead of one combined multi-reference request, opt in explicitly:

```bash
node "$HOME/plugins/api-image-gen/scripts/generate.mjs" --batch-edit --edit --image "<PATH_1>" --image "<PATH_2>" --prompt "<EDIT_INSTRUCTION>" --concurrency 3
```

Use `--edit-api responses` or `--image-request-mode openai-responses` only when the configured upstream needs OpenAI RS / Responses mode. Otherwise keep the default standard mode.

## API Contract

- Default text-to-image: `POST https://api.openai.com/v1/images/generations`
- Default image edit: `POST https://api.openai.com/v1/images/edits`
- Optional Responses mode: `POST https://api.openai.com/v1/responses` when `imageRequestMode:"openai-responses"`
- Image model: `gpt-image-2`
- Image API quality: `imageQuality` defaults to `auto`; `low`, `medium`, and `high` are sent as the API `quality` value
- The endpoint and model names above are defaults; the script can override them with CLI flags, `--api-profile`, or the local `defaultApi` / `apis` config
- Request size policy: use the default preset matrix, `--quality 1K`, a user-defined config `sizes` entry, or explicit `--size WIDTHxHEIGHT` / `WIDTH*HEIGHT`
- Auth: `Authorization: Bearer <API Key>`
- Standard Images generation body: JSON with `model`, `prompt`, `size`, and optional `quality`
- Standard Images edit body: multipart form with `model`, `prompt`, `size`, optional `quality`, and one `image` field per source image
- Responses body: JSON with `model`, `input`, `tools`, `tool_choice`, `reasoning`, and `store:false`; top-level `model` is `imageModel`, `tools[0].model` is omitted, and `tools[0].quality` is sent only for `low`, `medium`, or `high`; request mode follows the background -> SSE -> plain JSON fallback chain
- Response tracing: API requests temporarily write `*_trace.json` plus raw `*.raw.txt` files in the output directory; successful image saves delete the corresponding logs, while failures keep them for troubleshooting. Responses mode also records response ids when available
- Responses result parsing: final image can come from background/plain JSON `image_generation_call.result`, SSE `response.output_item.done`, or the last partial image event as a fallback
- Image saving accepts `b64_json`, `base64`, `image_generation_call.result`, common URL fields, nested `result.images`, and image links in Responses `output_text`; if one URL candidate cannot be downloaded, the script tries the next image candidate from the same response
- Saved PNG dimensions are normalized locally to the requested `size` unless `--no-resize` is used; when resize occurs, `path` points to the `_resized` copy and `originalPath` points to the retained upstream PNG

## Verification

After changing the script or API contract, run:

```powershell
node --check "$HOME\plugins\api-image-gen\scripts\generate.mjs"
node "$HOME\plugins\api-image-gen\scripts\generate.mjs" --help
node "$HOME\plugins\api-image-gen\scripts\generate.mjs" --get-config
node "$HOME\plugins\api-image-gen\scripts\generate.mjs" --resolve-size --aspect 9:16
node "$HOME\plugins\api-image-gen\scripts\generate.mjs" --self-test-adaptive
node "$HOME\plugins\api-image-gen\scripts\generate.mjs" --self-test-openai-standard
node "$HOME\plugins\api-image-gen\scripts\generate.mjs" --self-test-responses
```

When real generation or edit requests succeed, always show the successful saved images in Codex immediately with absolute-path Markdown image tags.

## Limits

- Quick same-prompt generation: 1 to 9 images
- Continuous generation: `--repeat 1..50`
- Size preset: default 2K; `1K` is supported with the default enabled aspects
- Edit variations: 1 to 4 images
- Batch prompts: up to 20
- Batch edit source images: up to 10
- Concurrency: 1 to 9
- Generation timeout: 180 seconds
- Edit timeout: 180 seconds
