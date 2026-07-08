---
name: "api-image-gen"
description: "Generate or edit images using the API Image Gen plugin. Trigger when the user wants AI images through Responses API, batch image generation, continuous or adaptive image generation, images saved to disk, or edits to existing images."
---

# API Image Gen

Use this skill to generate or edit raster images through API. Text-to-image and image-to-image are fixed to Responses API. Do not route image edits to `/v1/images/edits` in this plugin.

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
node "$HOME/plugins/api-image-gen/scripts/generate.mjs" --prompt "<PROMPT>" --api-root "<API_ROOT>" --text-model "<TEXT_MODEL>" --image-model "<IMAGE_MODEL>"
node "$HOME/plugins/api-image-gen/scripts/generate.mjs" --prompt "<PROMPT>" --api-profile "<PROFILE_NAME>"
```

Persist API call config in the local config file with:

```bash
node "$HOME/plugins/api-image-gen/scripts/generate.mjs" --set-api-config --api-root "<API_ROOT>" --text-model "<TEXT_MODEL>" --image-model "<IMAGE_MODEL>"
node "$HOME/plugins/api-image-gen/scripts/generate.mjs" --set-api-config --api-profile "<PROFILE_NAME>" --api-root "<API_ROOT>" --text-model "<TEXT_MODEL>" --image-model "<IMAGE_MODEL>"
node "$HOME/plugins/api-image-gen/scripts/generate.mjs" --api-profile "<PROFILE_NAME>" --set-key "<USER_KEY>"
node "$HOME/plugins/api-image-gen/scripts/generate.mjs" --set-default-api "<PROFILE_NAME>"
```

The config file can contain multiple API profiles under `apis` and choose the default with `defaultApi`. Each profile can contain `apiKey`, `apiRoot`, `responsesUrl`, `textModel`, and `imageModel`. `responsesUrl` overrides `apiRoot`; when only `apiRoot` is configured, the script appends `/v1/responses`. Parameters override the config file, and `--api-profile` overrides `defaultApi`. Use `--config <FILE>` or `API_IMAGE_GEN_CONFIG` to point at another config file. The legacy top-level `apiKey` plus `api` object remains supported.

```json
{
  "defaultApi": "openai",
  "apis": {
    "openai": {
      "apiKey": "<USER_KEY>",
      "apiRoot": "https://api.openai.com",
      "responsesUrl": "https://api.openai.com/v1/responses",
      "textModel": "gpt-5.5",
      "imageModel": "gpt-image-2"
    },
    "backup": {
      "apiKey": "<BACKUP_KEY>",
      "apiRoot": "https://backup.example.com",
      "textModel": "gpt-5.5",
      "imageModel": "gpt-image-2"
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

Generation requests default to the 2K preset matrix. `--quality 1K` is supported for the same enabled aspect list. Do not offer 4K choices. If the user asks for another exact pixel size, add it to config `sizes` first or map the request to the nearest supported fixed aspect preset and tell them: `由于上游请求限制只能接收1K图像，详细计费以后台为准。`

Pass only `--ratio`/`--aspect` when the user asks for a shape. Do not use `--size` for normal generation or edit requests. For custom dimensions, add them to config `sizes` first, then pass the configured label through `--aspect` or `--ratio`.

```bash
node "$HOME/plugins/api-image-gen/scripts/generate.mjs" --prompt "<PROMPT>" --aspect 16:9
```

Supported default 2K aspects are fixed to `1:1`, `3:2`, `2:3`, `4:3`, `3:4`, `16:9`, `9:16`, `2:1`, `1:2`, `7:4`, and `4:7`. `--quality 1K` supports those same enabled aspects. Aliases are `square=1:1`, `landscape=4:3`, and `portrait=3:4`.

The ratios `5:4`, `4:5`, `3:1`, and `1:3` are disabled in this plugin because repeated upstream tests returned `502` for them. Do not request them, and do not re-enable them unless new real tests prove they are stable.

Upstream may return a near-aspect image with non-exact pixels. On Windows, the script keeps the original upstream PNG, writes a center-cropped/resized copy beside it with a `_resized` suffix, and reports `resized from <original>` plus the original path. Resize is enabled by default for text-to-image, batch, and edit; pass `--no-resize` to keep the true upstream raster as the final output, or `--resize` to enable it explicitly.

For same-prompt multi-image requests, use `--count 1..9`. For longer continuous runs, use `--repeat 1..50`. Each image is a separate Responses request:

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

The image-to-image route is fixed to Responses API in this plugin. Endpoint and model values below are defaults and may be overridden by CLI flags or config:

- Endpoint: `POST https://api.openai.com/v1/responses`
- Text model: `gpt-5.5`
- Image tool: `gpt-image-2`
- Tool action: `edit`
- Input method: first one `input_text`, then one `input_image` block per source image, in order
- Output policy: `output_format:"png"`, `moderation:"low"`, `partial_images:0`, `stream:true`
- This is not a collage step and not legacy multipart edit

Default image-to-image edits use Responses API with `input_image` and the image tool `action:"edit"`:

```bash
node "$HOME/plugins/api-image-gen/scripts/generate.mjs" --edit --image "<IMAGE_PATH>" --prompt "<EDIT_INSTRUCTION>" --aspect 9:16
```

For multiple edit variations of one source, each variation is a separate Responses request with independent retry:

```bash
node "$HOME/plugins/api-image-gen/scripts/generate.mjs" --edit --image "<IMAGE_PATH>" --prompt "<EDIT_INSTRUCTION>" --count 3
```

For multi-reference image-to-image, pass multiple `--image` flags. The plugin follows the desktop API behavior: each source image becomes its own `input_image` block inside one Responses edit request, in the same order as the CLI arguments:

```bash
node "$HOME/plugins/api-image-gen/scripts/generate.mjs" --edit --image "<PATH_1>" --image "<PATH_2>" --prompt "<EDIT_INSTRUCTION>" --aspect 9:16
```

To force per-source batch behavior instead of one combined multi-reference request, opt in explicitly:

```bash
node "$HOME/plugins/api-image-gen/scripts/generate.mjs" --batch-edit --edit --image "<PATH_1>" --image "<PATH_2>" --prompt "<EDIT_INSTRUCTION>" --concurrency 3
```

Do not use `--legacy-edit` or `--edit-api images` here. They are disabled so the image-edit chain stays fixed to Responses API.

## API Contract

- Text-to-image: `POST https://api.openai.com/v1/responses`
- Image edit: `POST https://api.openai.com/v1/responses`
- Responses text model: `gpt-5.5`
- Image generation tool model: `gpt-image-2`
- The endpoint and model names above are defaults; the script can override them with CLI flags, `--api-profile`, or the local `defaultApi` / `apis` config
- Request size policy: use the default preset matrix, `--quality 1K`, or a user-defined config `sizes` entry; do not request 4K, disabled ratios, or arbitrary `--size`
- Auth: `Authorization: Bearer <API Key>`
- Responses body: JSON with `model`, `input`, `tools`, `tool_choice`, `reasoning`, `store:false`, and `stream:true`
- Edit Responses input: `input_text` plus one `input_image` data URL per source image, in order
- Edit Responses tool: `type:"image_generation"`, `action:"edit"`, `output_format:"png"`, `moderation:"low"`, `partial_images:0`
- Responses result parsing: final image comes from SSE event `response.output_item.done` where `item.type` is `image_generation_call` and `item.result` is base64 image data
- Saved PNG dimensions are normalized locally to the requested `size` unless `--no-resize` is used; when resize occurs, `path` points to the `_resized` copy and `originalPath` points to the retained upstream PNG

## Verification

After changing the script or API contract, run:

```powershell
node --check "$HOME\plugins\api-image-gen\scripts\generate.mjs"
node "$HOME\plugins\api-image-gen\scripts\generate.mjs" --help
node "$HOME\plugins\api-image-gen\scripts\generate.mjs" --get-config
node "$HOME\plugins\api-image-gen\scripts\generate.mjs" --resolve-size --aspect 9:16
node "$HOME\plugins\api-image-gen\scripts\generate.mjs" --self-test-adaptive
node "$HOME\plugins\api-image-gen\scripts\generate.mjs" --self-test-edit-responses
```

When real generation or edit requests succeed, always show the successful saved images in Codex immediately with absolute-path Markdown image tags.

## Limits

- Quick same-prompt generation: 1 to 9 images
- Continuous generation: `--repeat 1..50`
- Request quality: default 2K; `1K` is supported with the default enabled aspects
- Edit variations: 1 to 4 images
- Batch prompts: up to 20
- Batch edit source images: up to 10
- Concurrency: 1 to 9
- Generation timeout: 180 seconds
- Edit timeout: 180 seconds
