# IMG Gen Codex Plugins

给 Codex 用的图片生成插件 marketplace。

当前已提供插件：`api-image-gen`

## 快速开始

直接执行下面两条命令即可添加 marketplace 并安装插件：

```bash
codex plugin marketplace add JENJET/IMG-Codex-Plugins
codex plugin add api-image-gen@img-gen-plugins
```

如果你已经添加过 marketplace，只需要执行第二条安装命令。

## 项目简介

这个仓库是一个 Codex Git marketplace，marketplace 名称是 `img-gen-plugins`，展示名称是 `IMG Gen Plugins`。

目前仓库里提供的插件是：

- `api-image-gen`：基于 Responses API 的文生图 / 图生图插件，支持固定比例、批量生图、多参考图图生图、连续出图和自适应并发。

## 安装前准备

开始前请确认：

- 你已经安装并可以正常使用 Codex
- 你的网络可以访问 GitHub 和图片生成 API 服务
- 你已经准备好自己的 API Key
- 你知道 API Key 只保存在本机，不要写进仓库或公开发到网上

## 如何添加 Marketplace

### 方式一：命令行安装

这是最直接的方式：

```bash
codex plugin marketplace add JENJET/IMG-Codex-Plugins
```

添加完成后，Codex 会识别这个仓库里的 marketplace 配置，并注册 `img-gen-plugins`。

### 方式二：在 Codex App 中添加

如果你更习惯界面操作，可以在 Codex 的插件管理界面中：

1. 打开插件或 marketplace 管理页面
2. 选择添加 marketplace
3. 选择从 GitHub 仓库添加
4. 填入仓库地址：`https://github.com/JENJET/IMG-Codex-Plugins.git`

添加成功后，你会看到 `IMG Gen Plugins` 这个 marketplace。

## 如何安装插件

安装 `api-image-gen`：

```bash
codex plugin add api-image-gen@img-gen-plugins
```

安装完成后，插件标识就是：

```text
api-image-gen@img-gen-plugins
```

如果后续 marketplace 有更新，可以重新同步 marketplace 后再更新插件。

```bash
codex plugin marketplace upgrade img-gen-plugins
```

## 首次配置 API Key

`api-image-gen` 需要先写入你自己的 API Key。

### Windows PowerShell

```powershell
node "$HOME\plugins\api-image-gen\scripts\generate.mjs" --set-key "<你的API_KEY>"
node "$HOME\plugins\api-image-gen\scripts\generate.mjs" --get-config
```

### macOS / Linux / Git Bash

```bash
node "$HOME/plugins/api-image-gen/scripts/generate.mjs" --set-key "<你的API_KEY>"
node "$HOME/plugins/api-image-gen/scripts/generate.mjs" --get-config
```

配置文件保存在本机：

```text
~/.codex/api-image-gen-config.json
```

`--get-config` 只会显示脱敏后的 key 预览，不会打印完整 API Key。看到 `hasKey: true` 就说明配置成功。

## API 调用配置

默认 API 调用配置仍然是：

```text
API root: https://api.openai.com
Responses URL: https://api.openai.com/v1/responses
Text model: 不配置或为空字符串则不发送
Image tool model: gpt-image-2
```

如果需要临时覆盖，可以直接传参数：

```powershell
node "$HOME\plugins\api-image-gen\scripts\generate.mjs" --prompt "一只在河边钓鱼的小狗" --api-root "https://example.com" --image-model "gpt-image-2"
node "$HOME\plugins\api-image-gen\scripts\generate.mjs" --prompt "一只在河边钓鱼的小狗" --text-model "<TEXT_MODEL>"
node "$HOME\plugins\api-image-gen\scripts\generate.mjs" --prompt "一只在河边钓鱼的小狗" --api-profile manxiaobai
```

如果要持久保存到配置文件，可以使用：

```powershell
node "$HOME\plugins\api-image-gen\scripts\generate.mjs" --set-api-config --api-root "https://example.com" --image-model "gpt-image-2"
node "$HOME\plugins\api-image-gen\scripts\generate.mjs" --set-api-config --api-profile manxiaobai --api-root "https://api.manxiaobai.online" --image-model "gpt-image-2" --image-model-as-top-level
node "$HOME\plugins\api-image-gen\scripts\generate.mjs" --api-profile manxiaobai --set-key "<MANXIAOBAI_API_KEY>"
node "$HOME\plugins\api-image-gen\scripts\generate.mjs" --set-default-api manxiaobai
node "$HOME\plugins\api-image-gen\scripts\generate.mjs" --get-config
```

`textModel` 可以省略，也可以设为空字符串；这两种情况下默认不会发送 Responses 顶层 `model` 字段。只有 `textModel` 是非空字符串且没有启用 `imageModelAsTopLevel` 时，才会作为顶层 `model` 发送。启用 `imageModelAsTopLevel` 时，顶层 `model` 改用 `imageModel`。

也可以直接编辑配置文件。推荐使用 `defaultApi` + `apis` 配置多个 API 档位，`defaultApi` 指定默认使用哪一个：

```json
{
  "defaultApi": "openai",
  "apis": {
    "openai": {
      "apiKey": "你的OPENAI_API_KEY",
      "apiRoot": "https://api.openai.com",
      "imageModel": "gpt-image-2"
    },
    "manxiaobai": {
      "apiKey": "你的MANXIAOBAI_API_KEY",
      "apiRoot": "https://api.manxiaobai.online",
      "imageModel": "gpt-image-2",
      "imageModelAsTopLevel": true
    },
    "mikotopro": {
      "apiKey": "你的MIKOTO_API_KEY",
      "apiRoot": "https://api.mikoto.vip",
      "imageModel": "gpt-image-2",
      "imageModelAsTopLevel": true
    }
  },
  "sizes": {
    "1K": {
      "poster": "1024x1824",
      "1024x1824": "1024x1824"
    },
    "2K": {
      "2048x1024": "2048x1024",
      "wide-card": "2048x1024"
    }
  }
}
```

示例里不要写真实 API Key。`responsesUrl` 可以不配；如果只配置 `apiRoot`，脚本会自动拼接 `/v1/responses`，如果 `apiRoot` 已经以 `/v1` 结尾则只补 `/responses`。Infinite-Canvas 风格的 OpenAI RS 中转建议设置 `imageModelAsTopLevel: true`，此时顶层 `model` 使用 `imageModel`，`textModel` 不参与图片请求。`responsesUrl` 的优先级高于 `apiRoot`，只在中转路径不是 `/v1/responses` 时才需要手动覆盖。参数优先级高于配置文件，`--api-profile` 优先于 `defaultApi`。需要指定另一份配置文件时，可以使用 `--config path.json`，也可以设置 `API_IMAGE_GEN_CONFIG` 环境变量。旧的顶层 `apiKey` + `api` 写法仍然兼容。

`sizes` 可以扩展可用尺寸，第一层是质量档位，第二层是你想在 `--aspect` / `--ratio` 里使用的名称，值是实际请求尺寸。上面的例子可以这样使用：

```powershell
node "$HOME\plugins\api-image-gen\scripts\generate.mjs" --prompt "海报图" --quality 1K --aspect poster
node "$HOME\plugins\api-image-gen\scripts\generate.mjs" --prompt "海报图" --quality 1K --aspect 1024x1824
```

## 如何使用

安装完成后，你可以直接在 Codex 对话里让它用 API Image Gen 出图，也可以手动运行脚本。

插件规则已经要求：只要出图成功，图片会立即返回到 Codex 对话框里，同时也会保存到本地。

默认保存目录：

```text
~/Pictures/api-image-gen
```

如果上游返回的 PNG 像素尺寸和请求尺寸不完全一致，脚本会保留原始上游图片，并在同目录另存一张带 `_resized` 后缀的调整后图片；命令输出里的 `Path` 指向调整后的图片，`original saved at` 指向保留的原图。

尺寸调整默认开启。需要关闭时，在文生图、批量出图或图生图命令后加 `--no-resize`；需要显式开启时可加 `--resize`。

### 1. 文生图

最基础的文生图：

```powershell
node "$HOME\plugins\api-image-gen\scripts\generate.mjs" --prompt "一只在河边钓鱼的小狗"
```

指定比例：

```powershell
node "$HOME\plugins\api-image-gen\scripts\generate.mjs" --prompt "一只在河边钓鱼的小狗" --aspect 16:9
```

直接指定尺寸：

```powershell
node "$HOME\plugins\api-image-gen\scripts\generate.mjs" --prompt "一只在河边钓鱼的小狗" --size 2048*1024
```

### 2. 同提示词多张

同一个提示词一次生成多张，`--count` 上限是 `9`：

```powershell
node "$HOME\plugins\api-image-gen\scripts\generate.mjs" --prompt "一只在河边钓鱼的小狗" --count 9 --concurrency 3 --aspect 16:9
```

### 3. 连续出图 / 自适应并发

连续跑很多张时，用 `--repeat`：

```powershell
node "$HOME\plugins\api-image-gen\scripts\generate.mjs" --prompt "一只在河边钓鱼的小狗" --repeat 20 --concurrency 4 --aspect 16:9
```

说明：

- `--repeat` 范围是 `1..50`
- 默认开启自适应并发
- 如果上游出现 `502 / 503 / 504 / 524 / rate limit / account busy` 这类可重试错误，插件会自动重试，并把后续任务降到 `concurrency=1`
- 目标是优先保证最终成功率，而不是硬顶并发

如果你明确不想启用自适应：

```powershell
node "$HOME\plugins\api-image-gen\scripts\generate.mjs" --prompt "一只在河边钓鱼的小狗" --repeat 20 --concurrency 4 --aspect 16:9 --no-adaptive
```

### 4. 多提示词批量生图

不同提示词可以直接内联批量：

```powershell
node "$HOME\plugins\api-image-gen\scripts\generate.mjs" --batch-inline "一只钓鱼的小猫" "一只看书的小狗" "一只晒太阳的小兔子"
```

也可以使用 JSON 文件：

```powershell
node "$HOME\plugins\api-image-gen\scripts\generate.mjs" --batch prompts.json
```

### 5. 单图图生图

图生图默认走 Responses API，不走旧的 Images Edits 路线。

```powershell
node "$HOME\plugins\api-image-gen\scripts\generate.mjs" --edit --image "C:\path\input.png" --prompt "把这张图改成 9:16 海报风格" --aspect 9:16
```

如果你想基于同一张参考图连续生成多个编辑版本，可以追加 `--count 1..4`。

### 6. 多参考图图生图

如果你想让多张参考图一起参与同一次生成，可以传多个 `--image`。插件会按顺序把它们作为多个 `input_image` 上传到同一个 Responses 请求里，不会先拼图。

```powershell
node "$HOME\plugins\api-image-gen\scripts\generate.mjs" --edit --image "C:\path\one.png" --image "C:\path\two.png" --image "C:\path\three.png" --prompt "将这些玩具组合成一个在互相玩耍的场景，保留玩具质感和颜色风格" --aspect 16:9
```

当前批量图生图的源图数量上限是 `10` 张。

### 7. 按源图分别批量图生图

如果你不是想把多张图作为一组参考，而是想让每一张源图各自单独出图，可以显式使用 `--batch-edit`：

```powershell
node "$HOME\plugins\api-image-gen\scripts\generate.mjs" --batch-edit --edit --image "C:\path\one.png" --image "C:\path\two.png" --prompt "生成玩具海报图" --concurrency 3
```

## 支持的比例与尺寸

插件已经把支持比例固定下来，只允许使用已验证通过的比例。

支持的比例：

- `1:1`
- `3:2`
- `2:3`
- `4:3`
- `3:4`
- `16:9`
- `9:16`
- `2:1`
- `1:2`
- `7:4`
- `4:7`

别名：

- `square = 1:1`
- `landscape = 4:3`
- `portrait = 3:4`

默认使用 2K 预设矩阵；也可以使用 `--quality 1K` 请求 1K 预设。需要自定义尺寸时，可以直接传 `--size 2048x1024`，也可以先写入配置文件 `sizes`，再通过 `--aspect` / `--ratio` 使用对应名称。

| 质量 | 比例 | 对应尺寸 |
| --- | --- | --- |
| 1K | 1:1 | 1024x1024 |
| 1K | 3:2 | 1536x1024 |
| 1K | 2:3 | 1024x1536 |
| 1K | 4:3 | 1536x1152 |
| 1K | 3:4 | 1152x1536 |
| 1K | 16:9 | 1536x864 |
| 1K | 9:16 | 864x1536 |
| 1K | 2:1 | 1536x768 |
| 1K | 1:2 | 768x1536 |
| 1K | 7:4 | 1664x944 |
| 1K | 4:7 | 944x1664 |
| 2K | 1:1 | 2048x2048 |
| 2K | 3:2 | 2048x1360 |
| 2K | 2:3 | 1360x2048 |
| 2K | 4:3 | 2048x1536 |
| 2K | 3:4 | 1536x2048 |
| 2K | 16:9 | 2048x1152 |
| 2K | 9:16 | 1152x2048 |
| 2K | 2:1 | 2048x1024 |
| 2K | 1:2 | 1024x2048 |
| 2K | 7:4 | 2208x1264 |
| 2K | 4:7 | 1264x2208 |

以下比例已经因为重复实测返回上游 `502` 被禁用，不允许在插件里随便重新打开：

- `5:4`
- `4:5`
- `3:1`
- `1:3`

## 能力与限制

这个插件当前的真实行为是：

- 文生图默认走 `POST https://api.openai.com/v1/responses`，可通过参数或配置文件覆盖
- 图生图默认也走 `POST https://api.openai.com/v1/responses`，可通过参数或配置文件覆盖
- Responses 请求优先走 `background:true` + 轮询；中转不支持时回退 SSE 流式，再回退普通 JSON 请求
- Responses 顶层 `model` 默认不发送；只有 `textModel` 是非空字符串时才发送
- `imageModelAsTopLevel: true` 时改为 Infinite-Canvas RS 兼容模式：顶层 `model` 使用 `imageModel`，tool 内不再发送 `model`
- 图片工具模型默认是 `gpt-image-2`
- 图生图使用 `input_text + input_image` 的 Responses 方式
- 多参考图图生图是多图上传，不是拼图，不走旧版 multipart Images API
- 支持直接传 `--size`，格式可用 `2048x1024`、`2048X1024`、`2048*1024` 或 `2048×1024`
- 默认按已验证的 2K 比例矩阵请求；支持 `--quality 1K`，额外尺寸通过配置文件 `sizes` 自定义

插件内同时保留下面这条提示，供你了解当前上游限制说明：

> 由于上游请求限制只能接收1K图像，详细计费以后台为准。

如果你只是正常使用插件，可以直接理解为：当前版本已经把可用的比例、尺寸和请求方式都固化好了，按支持列表使用即可。

## 在 Codex 里怎么用

安装好插件并配置 API Key 后，最简单的方式就是直接在 Codex 对话里提出你的出图需求，例如：

- “用 API Image Gen 出一张 16:9 的海边小狗照片”
- “用 API Image Gen 把这张参考图改成竖版海报”
- “同一个提示词连续出 20 张，开启自适应并发”

插件命中后，会自动调用本地脚本，成功出图后会把图片直接显示在对话里。

如果你是刚安装完插件，当前线程里还没有正常触发，最稳的做法是新开一个 Codex 线程再使用。

如果你想检查插件配置是否正常，可先执行：

```powershell
node "$HOME\plugins\api-image-gen\scripts\generate.mjs" --get-config
```

## 基础排错

### 1. 安装 marketplace 失败

先确认仓库地址和命令是否正确：

```bash
codex plugin marketplace add JENJET/IMG-Codex-Plugins
```

如果你是在公司网络或代理环境下，先确认 Codex 当前能访问 GitHub。

### 2. 插件安装失败

确认 marketplace 已经成功添加，然后重新执行：

```bash
codex plugin add api-image-gen@img-gen-plugins
```

也可以先查看当前已添加的 marketplace 和插件，再判断是不是名称输错了。

### 3. `hasKey` 是 `false`

说明本机还没有写入可用的 API Key，重新执行：

```powershell
node "$HOME\plugins\api-image-gen\scripts\generate.mjs" --set-key "<你的API_KEY>"
node "$HOME\plugins\api-image-gen\scripts\generate.mjs" --get-config
```

### 4. 提示比例不支持

这不是 bug，说明你传入了未开放或已禁用的比例。请只使用 README 里列出的支持比例。

### 5. 出图时报 502 / 503 / 504 / 524

这通常是 API 上游暂时不稳定。连续出图场景下，插件会自动重试并降级并发。单次失败时，稍后再试通常更稳。

### 6. 图生图失败

先确认：

- 图片路径存在且可读取
- 图片格式正常
- 你使用的是 `--edit`
- 你没有尝试走旧版 Images Edits 路线

这个插件已经把图生图链路固定在 Responses API 上，不建议再切回旧版编辑接口。

## 仓库与插件信息

- GitHub 仓库：[JENJET/IMG-Codex-Plugins](https://github.com/JENJET/IMG-Codex-Plugins.git)
- Marketplace 名称：`img-gen-plugins`
- Marketplace 展示名：`IMG Gen Plugins`
- 插件标识：`api-image-gen@img-gen-plugins`
- 插件目录：`./plugins/api-image-gen`

如果你只想记住一句安装命令，就记这两行：

```bash
codex plugin marketplace add JENJET/IMG-Codex-Plugins
codex plugin add api-image-gen@img-gen-plugins
```
