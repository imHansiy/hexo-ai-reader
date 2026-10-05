# hexo-ai-reader

在 Hexo 编译时为文章生成 AI 导读稿，再合成一份连续语音。默认使用内置的纯 JavaScript Qwen3-TTS 渠道，支持切换阿里百炼。文章页提供播放器、导读目录、卡片内同步文字和正文高亮。访客只加载静态资源，浏览器不会调用生成接口，也不会拿到 API Key。

日常流程是：**配置 `_config.yml` → 给文章开启导读 → `hexo generate` → 预览或发布**。缓存有效就跳过生成；需要重做时使用强制生成命令。

要求 Node.js 22+、Hexo 6+。默认渠道使用 Node 原生 WebSocket 和 fetch，无需 Python 或额外 TTS npm 依赖。本仓库已验证 Hexo 8.1.2 / Volantis 6.0.4，不需要修改主题模板。其他主题需自行核对页面结构和 PJAX 行为。通过 GitHub 仓库安装，当前未发布到 npm registry。

## 1. 准备与安装

准备一个支持 OpenAI Compatible Chat Completions 的文本接口。默认语音渠道通过公开的 Hugging Face Space 合成，使用 Serena 预置音色，无需百炼密钥或参考音频。语音模块随插件分发，无需自行下载脚本；构建环境需能连接该服务。

若选择百炼，需要可调用的 TTS 模型、API Key 和与模型匹配的音色 ID。插件使用已有音色，百炼渠道不负责创建、覆盖或删除音色。

在已有 Hexo 博客根目录安装当前主分支版本：

```bash
npm install github:imHansiy/hexo-ai-reader#main
```

Hexo 会自动加载插件，不需要改主题模板或手写加载脚本。使用项目原有的包管理器；已有 pnpm 项目不要混用 npm。`main` 包含本文的人物设定、系统提示词和播放器自定义配置。`v0.1.0` 标签保留初始发布代码，不包含这些新增选项。

本地开发也可以克隆本仓库后，在博客根目录执行 `npm install <插件目录路径>`。正常使用不依赖作者博客、私有文件或额外便捷脚本。

以下命令都在**博客根目录**执行。没有全局安装 Hexo CLI 时，可将 `hexo` 换成 `npx hexo`。

## 2. 配置文本 AI 和默认语音渠道

在博客根目录 `_config.yml` 中添加或修改一个 `ai_reader` 区块。以下是**运行所需的完整最小配置**，不是省略了必填项的结构示意；将示例地址和占位符替换为自己的值：

```yaml
ai_reader:
  enabled: true
  default_enabled: false

  llm:
    base_url: https://api.example.com/v1
    api_key: '<你的文本模型密钥>'
    model: '<你的文本模型 ID>'

  tts:
    provider: qwen3
    qwen3:
      command: say
      speaker: Serena
```

参数相对于 `ai_reader`：

| 参数 | 是否必填 | 作用与缺省行为 |
| --- | --- | --- |
| `enabled` | 要启用时填 `true` | 总开关；省略或设为 `false` 时关闭插件 |
| `default_enabled` | 否，默认 `false` | 是否默认给全部公开文章开启导读 |
| `llm.base_url` | 真实生成必填 | 文本 API 基址，通常以 `/v1` 结束；不要包含 `/chat/completions` |
| `llm.api_key` | 真实生成必填 | 文本接口密钥 |
| `llm.model` | 真实生成必填 | 服务商支持的文本模型 ID |
| `tts.provider` | 否，默认 `qwen3` | `qwen3` 使用内置纯 JS 模块；`dashscope` 使用百炼 |
| `tts.qwen3.command` | 否，默认 `say` | 使用预置音色；克隆或音色设计见后文 |
| `tts.qwen3.speaker` | 否，默认 `Serena` | 预置说话人，默认中文、自然语气 |
| `tts.api_key` | 百炼生成必填 | 百炼密钥，需拥有对应模型和音色权限；Qwen3 渠道无需百炼凭据 |
| `tts.model` | 建议明确填写 | 与音色绑定的模型；未填时兼容读取 `TTS_MODEL`，再回退到 `qwen-audio-3.1-tts-flash` |
| `tts.voice` | 百炼生成必填 | 接口返回的音色 ID，不是音色显示名称 |
| `tts.endpoint` | 否 | 默认通用百炼端点；填写后优先于业务空间推导地址 |
| `tts.workspace_id` | 否 | 需要专属业务空间域名时填写；使用通用端点不要求额外填写 |

默认渠道的 `tts` 整段也可省略，插件仍使用 `qwen3/say/Serena`。表中的百炼专用字段仅在 `provider: dashscope` 时使用。

文本默认使用 SSE 流式输出，导读默认不超过 800 字。超时、缓存路径和播放器参数都有默认值，无需再复制一份完整参数清单。Qwen3 使用公开共享服务，导读文本及参考音频不能包含保密内容；服务停机或排队会影响首次生成，已有缓存可继续发布。

配置以 **Hexo 已加载的 YAML** 为准。插件不会自行读取或合并 `_config.local.yml`。需要多文件配置时，通过 Hexo 的参数显式指定，并在后续编译、预览和强制命令中使用同一组配置：

```bash
hexo generate --config _config.yml,_config.local.yml
```

### 可选：用环境变量保存私有值

接口信息可以直接写在 YAML 中；完整 YAML 配置不依赖环境文件。配置要提交到 Git 时，可用环境变量引用保护私有值，例如：

```yaml
# 合并到已有的 ai_reader 中，其他字段仍按上面的最小配置填写
ai_reader:
  llm:
    base_url: ${OPENAI_BASE_URL}
    api_key: ${OPENAI_API_KEY}
```

在运行 Hexo 的环境中设置这些变量，或合并进博客根目录被 Git 忽略的 `.env`：

```dotenv
OPENAI_BASE_URL='https://api.example.com/v1'
OPENAI_API_KEY='<你的文本模型密钥>'
```

本仓库提供 [环境文件示例](.env.ai-reader.example)。将需要的变量合并到博客根目录的 `.env`，保留其他插件已有变量，并通过 YAML 引用；默认 Qwen3 无需百炼变量、脚本或 Python 路径。旧 `.env.ai-reader` 仍兼容，只补充 `.env` 和进程环境中尚未设置的变量；统一配置后可以删除旧文件。

`${...}` 是本插件支持的替换方式，不是 Hexo 对所有配置的通用功能。优先级为明确 YAML 值、进程环境、`.env`、旧 `.env.ai-reader`；环境文件只解析赋值，不执行 shell。Mock 模式和完整 YAML 配置不读取环境文件。

修改环境文件后，重启正在运行的 Hexo 服务器；重新执行 `hexo generate` 会启动新进程并读取配置。

### 可选：切换阿里百炼

保持文本接口和文章开关，将 `tts` 改为：

```yaml
# 合并到已有 ai_reader 中
ai_reader:
  tts:
    provider: dashscope
    endpoint: https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer
    api_key: '<你的百炼密钥>'
    model: qwen-audio-3.0-tts-plus
    voice: '<与模型匹配的音色 ID>'
```

示例使用 3.0 Plus，音色必须与该模型匹配。切换百炼模型时核对音色绑定关系和账号权限。如用环境变量保存私有值，可将密钥和音色改为 `${DASHSCOPE_API_KEY}`、`${TTS_VOICE_ID}` 引用，并填写对应变量。

### 可选：Qwen3 音色与外部模块

内置实现位于 [lib/qwen3-tts.mjs](lib/qwen3-tts.mjs)。`say` 使用预置音色；如果需要自己的音色，可在 `tts.qwen3` 中选择 `voice`、`clone` 或 `design`，并补充对应参数。

用参考音频克隆音色时，保留文本接口，将已有 `tts.qwen3` 配置改为：

```yaml
# 合并到已有 ai_reader 中
ai_reader:
  tts:
    provider: qwen3
    qwen3:
      command: clone
      ref_audio: './voice/reference.wav'
      xvector: true
```

将自己的参考音频放到博客根目录的 `voice/reference.wav`，或把 `ref_audio` 改成实际路径。相对路径按博客根目录解析；参考文件留在 `source` 之外，不随静态站点发布。建议使用单人、清晰、少背景噪音的 3～10 秒片段，并控制在 500 KB 以内，以减少上传断连。

`xvector: true` 提取音色，不要求参考逐字稿。需要结合说话方式做完整 ICL 克隆时，改为 `xvector: false`，同时填写与参考音频逐字对应的 `ref_text`。克隆模式不用 `speaker` 和 `instruct`。参考音频会上传到公开共享服务，勿使用需要保密的录音。

之后仍只运行 `hexo generate`，插件复用有效文稿并补齐新音色的语音。再次编译命中缓存；参考音频内容、克隆方式或参考文本变化会更新音频版本。`hexo ai-reader --force` 会同时重做文稿和音频，单纯切换音色无需强制生成。

连接异常时可单独检查服务，不会生成语音：

```bash
node node_modules/hexo-ai-reader/lib/qwen3-tts.mjs doctor
```

插件通过独立 Node 进程调用导出接口，兼容 Windows 和带空格的路径。生成文本经 IPC 传递，不作为 shell 命令执行，产物只从指定临时文件读取。外部模块须导出对应生成方法与 `inspectAudio`，直接返回 `{ ok: true, status: 'Success' }` 并提供有效、非静音的 WAV；旧版 `{ exitCode: 0, data: { ok: true, status: 'Success' } }` 也兼容。业务失败或下载后音频校验失败时不会发布新版本。

| `tts.qwen3` 参数 | 默认值或必填条件 | 用途 |
| --- | --- | --- |
| `module` | 内置 `lib/qwen3-tts.mjs` | 可指定兼容的外部模块；支持 `QWEN3_TTS_MODULE` 回退，需确保该文件存在 |
| `python` / `python_script` | 默认空，仅旧桥接脚本需要 | 显式覆盖旧脚本解释器和 CLI 路径，支持 `${...}`；内置实现不使用它们 |
| `command` | `say` | `voice` 配置音色、`say` 预置音色、`clone` 参考音频克隆、`design` 音色设计 |
| `speaker` / `instruct` | `Serena` / `Neutral` | `say` 的说话人和语气 |
| `language` / `model_size` | `Chinese` / `1.7B` | `say`、`clone` 的语言和模型大小；`design` 使用语言参数 |
| `voice_config` / `mode` | `voice` 必填 / `xvector` | 默认音色 JSON；`mode` 可为 `xvector` 或 `icl` |
| `ref_audio` / `ref_text` / `xvector` | `clone` 必填音频 / 空 / `true` | 本地参考音频、逐字稿及克隆方式 |
| `description` | `design` 必填 | 音色描述 |

`voice_config` 的内容按脚本约定填写：

```json
{
  "ref_audio_short": "<短参考音频的绝对路径>",
  "ref_text_short": "<短参考音频逐字稿>",
  "ref_audio_full": "<完整参考音频的绝对路径>",
  "ref_text_full": "<完整参考音频逐字稿>"
}
```

`xvector` 模式使用 short 字段，`icl` 使用 full 字段；仅需填写实际使用的一组。`say` 无需音色配置，Serena 是预置音色，不能当作海灵复刻音色。

如使用旧 Python 桥接模块，需另外提供模块、解释器和 `python_script` 路径，并保留 Python CLI 的配套文件、安装其依赖；这是该外部模块的要求。内置渠道不加载 Python CLI，也不受旧 `QWEN3_TTS_PY`、`QWEN3_TTS_SCRIPT` 环境变量影响。

Qwen3 输出 WAV，采用估算时间轴，不需要百炼 Key 或百炼 voice ID；通用 `tts.model`、`tts.voice`、采样率和百炼指令不控制此渠道。切换渠道复用文稿，只生成新音频；切回百炼可复用既有百炼音频。脚本、所用参考音频或参考文本变化会更新音频缓存，Python 解释器路径和超时变化不会。

默认推理等待 600 秒，可用 `tts.timeout_ms` 覆盖，外层另留 150 秒用于建连、下载和进程收尾；推理期间可能长时间静默，不自动重试。服务使用公开共享的 Hugging Face Space，文本和参考音频不应包含保密内容。

## 3. 给文章开启导读

默认 `default_enabled: false`，在目标文章现有 Frontmatter 中加入 `ai_reader: true`：

```yaml
---
title: 示例文章
date: 2026-10-04 12:00:00
ai_reader: true
---
这里是正文。
```

保留文章其他字段，不要再增加第二个 Frontmatter 区块。

想默认给全部公开文章生成，设置 `default_enabled: true`。单篇的 `ai_reader: false` 优先，可关闭该文章。也可通过 `include` 数组指定文章 source（如 `_posts/example.md`）或 slug。

加密、带密码、受加密标签保护、未发布或非文章布局的内容始终排除。文章级对象形式也能作为开启标记，其中的模型、音色和模式不会覆盖全局参数；首次生成推荐使用布尔值。已发布文稿和音频可以通过对象内的 `generated` 保存，见下文。

## 4. 编译、预览和发布

正常编译只有 Hexo 自身的命令：

```bash
hexo generate
```

插件注册在 `before_generate` 生命周期中，与其他插件一起执行，不需要先运行独立的导读命令。

| 情况 | 编译行为 |
| --- | --- |
| 首次生成、正文或标题变化 | 生成所需文稿和语音，成功后发布新版本 |
| 文稿和语音缓存有效 | 直接复用，不调用文本模型或语音服务 |
| 修改文本模型或导读风格 | 更新文稿；最终朗读文本及语音参数相同则复用音频 |
| 仅修改音色或影响发声的参数 | 复用文稿，只补语音 |
| 缓存缺失或损坏 | 修复受影响的阶段 |
| 仅轮换密钥、修改超时或文本流式开关 | 保持既有缓存有效 |
| 生成失败 | 记录告警，文章继续构建；正文仍匹配时保留旧版导读 |

首次真实生成需要等待接口完成。默认每份导读调用一次文本模型和一次完整 TTS；文本超长时最多额外调用一次压缩。网络错误不会自动重试。

本地预览：

```bash
hexo server -p 6845
```

打开 [本地预览](http://localhost:6845/)，进入已开启导读的文章。服务器初始化和监听触发的构建使用相同生成规则，不自动播放音频。

到这里可按以下项目核对：

- 构建日志显示目标文章准备完成或命中缓存，失败数为 0。
- 文章页只有一个导读播放器，点击播放后有声音，目录、进度和正文高亮可用。
- `public/ai-reader/` 中有播放器资源、文章清单和音频。
- 再次编译显示命中缓存，生成文稿和音频数量均为 0。

发布沿用博客原有的 Hexo 部署流程，包含 `public/ai-reader/` 下的资源。静态产物中没有 API Key，部署后的浏览器不需要 AI 凭据。

### 可选：编译时自动上传到 B2

默认 `storage.provider: local`：生成结果保留在 `.cache/hexo-ai-reader/`，Hexo 编译时输出音频到 `public/ai-reader/`，随博客同域发布。缓存让 `hexo clean` 后仍可直接重新发布，无需再次付费生成；不要把 `public` 当作唯一缓存目录。

要使用 B2，在已有 `ai_reader` 下添加以下配置。文本 AI 和 TTS 配置保持原样：

```yaml
ai_reader:
  storage:
    provider: b2
    b2:
      key_id: ${B2_KEY_ID}
      key: ${B2_KEY}
      bucket: ${B2_BUCKET}
      bucket_id: ${B2_BUCKET_ID}
      region: ${B2_REGION}
      # 可选：自己的 HTTPS 域名，也可包含回源路径前缀
      # public_base: https://audio.example.com
```

在被 Git 忽略的项目 `.env` 中保存变量，或直接用完整 YAML 填写实际值；环境变量不是必需的配置方式：

```dotenv
B2_KEY_ID=<你的 Application Key ID>
B2_KEY=<你的 Application Key>
B2_BUCKET=<你的桶名>
B2_BUCKET_ID=<你的桶 ID>
B2_REGION=<桶所在区域，例如 us-east-005>
# 可选；YAML 的 public_base 优先于此变量
# B2_PUBLIC_BASE=https://audio.example.com
```

| `storage.b2` 参数 | 要求与作用 |
| --- | --- |
| `key_id`、`key` | 首次上传或缺少上传记录时必填；Key 需要目标桶的 `listFiles`、`readFiles`、`writeFiles` 权限 |
| `bucket`、`bucket_id` | 必填，已有桶的名称和 ID；插件不创建或删除桶 |
| `region` | 没有 `public_base` 时必填，用于生成公开 S3 地址 |
| `public_base` | 可选，公开 HTTPS 基址；省略时读取 `B2_PUBLIC_BASE`，再使用 `https://s3.<region>.backblazeb2.com/<bucket>` |
| `prefix` | 可选，默认 `ai-reader`；对象名为 `<prefix>/<完整音频 SHA-256>.wav` 或 `.mp3` |
| `timeout_ms` | 可选，默认 90000，单次存储请求超时 |

自定义域名须提前配置好 DNS、HTTPS 及到对应桶的回源，公开 URL 的路径与对象目录保持一致。填写 `public_base` 只改变播放地址，插件不配置 DNS/CDN。桶或回源服务需要允许访客匿名读取音频；地址不能含用户名、密码、查询参数或片段。站点配置 CSP 时，在 `media-src` 中允许音频域名。上传使用 [B2 Native API](https://www.backblaze.com/apidocs/b2-upload-file)，无需 Python、CLI 或额外存储 SDK。

然后照常执行 `hexo generate`。插件先复用或生成音频，再查重上传，回读远程 SHA-1 和文件大小，并核对公开地址的文件大小及音频开头。验证通过后清单引用公开 URL，`public/ai-reader/` 仅输出清单和播放器，不再输出该音频副本。上传记录保存在 `.cache`，再次编译不上传、不访问 B2；更换域名只验证新地址，密钥轮换不导致重新上传或合成。删除上传记录后会查重远程对象，避免创建重复版本。

上传或公开地址验证失败会保留已生成的文稿和音频；下次正常编译只补存储阶段。强制更新失败不切换旧版指针；普通构建告警，仍符合当前正文的旧版可以继续使用，手动准备/强制命令则返回失败。`auto_generate: false` 只复用已有且已验证的上传记录，不发起存储请求。切回 `provider: local` 会从缓存重新输出本地音频，无需调用 AI。

### 可选：在全新构建环境复用已经生成的导读

`.cache/hexo-ai-reader/` 是本地缓存，不应提交。如果部署平台每次从 Git 拉取后重新编译，需要把已有音频上传到自己的公开文件存储，并把导读数据保存进对应文章的 Frontmatter。这样云端执行普通 `hexo generate` 就能复用导读，无需 AI 密钥、克隆参考文件或本地缓存。播放器和清单仍由 Hexo 生成，音频直接从公开 HTTPS 地址播放。播放器支持 B2、S3 和 CDN 等其他域名上的公开音频；导读清单仍从博客同域加载。站点若配置 CSP，需在 `media-src` 中允许对应音频域名。

`ai_reader.generated` 的结构如下。这是产物字段说明，指纹和校验值必须取自实际缓存，不能直接复制占位符：

```yaml
ai_reader:
  generated:
    version: 1
    source_hash: '<ready-live.json 的 sourceHash>'
    audio_key: '<ready-live.json 的 audioKey>'
    audio:
      url: https://cdn.example.com/files/narration.wav
      sha256: '<音频 result.json 的 audioHash>'
      text_hash: '<音频 result.json 的 textHash>'
      duration: 86.5
    guide:
      title: 示例导读
      segments:
        - id: guide-1
          text: 这里保存实际生成的朗读文字。
          sourceIds:
            - '<文稿中的真实正文 source ID>'
```

在 `.cache/hexo-ai-reader/<文章目录>/` 中，`ready-live.json` 指向 `guides/<guideKey>/guide.json` 和 `audio/<audioKey>/result.json`。`guide` 取文稿记录中的 `title` 和 `segments`，时长取音频记录中的 `duration`；上传的是同目录的 `narration.wav` 或 `narration.mp3`，上传后先验证公开链接可播放，再填写 `audio.url`。音频地址必须是无用户名、密码、查询参数及片段的 HTTPS URL，不能使用带凭据的临时签名链接。不要把 API 参数、模型配置、参考录音或私有路径写入文章。

正文指纹包含文章标题和全部可导读段落；标题或正文变化后，旧导读不再使用。插件还校验文稿引用、文字哈希、音频校验值格式及有效时长；编译时不下载远程音频，因此公开存储的可达性和文件完整性需在上传时验证。时间轴重新从已保存文稿和时长计算，仍是估算对齐。

已保存的导读作为文章发布版本固定使用，修改模型、人物设定或音色不会自动覆盖它，`storage` 也不会下载或改写它保存的音频地址。需要更新时运行 `hexo ai-reader --force`；若启用 B2，新的音频自动上传，否则使用本地缓存。将新版文稿及最终公开 URL 更新到该文章的 `generated`，全新的云端环境才会使用新版。失败保留原发布版本。清理本地缓存不会删除文章中的已发布导读。普通编译和强制命令都不会自行改写 Markdown；只有显式选择 B2 存储时才自动上传文件。

验证这种部署方式时，在没有 `.cache/`、私有环境文件和参考音频的构建环境执行 `hexo generate`：日志应显示“复用已发布导读”，文章播放器清单的 `audio` 应指向已验证的公开地址，生成文稿和音频数量均为 0。总开关、单篇关闭及加密排除规则仍然有效。

## 5. 强制重新生成

即使缓存有效，也重新生成指定文章的文稿和语音：

```bash
hexo ai-reader --force --post "_posts/example.md"
```

省略 `--post`，强制生成全部已开启导读的公开文章：

```bash
hexo ai-reader --force
```

`--post` 接受文章 source 或 slug，不接受浏览器 URL，也不是完整磁盘路径。未匹配到已开启的文章时命令报错，不会静默当作成功。

强制生成保留原缓存，用独立目录生成新文稿和音频，两个阶段都成功后才切换版本；失败保留原来可用的版本。之后的普通编译会复用成功的强制版本。

可选的 `hexo ai-reader --prepare --post "_posts/example.md"` 只补齐指定文章缺失或失效的阶段，仍检查缓存，并非强制更新。日常编译无需运行它。手动准备或强制命令遇到生成失败会以失败状态退出；普通编译按上面的告警和降级规则处理。

## 6. 可选参数

以下均写在 `_config.yml` 的 `ai_reader` 下，只添加需要修改的项。

| 参数 | 默认值 | 用途 |
| --- | --- | --- |
| `auto_generate` | `true` | 设为 `false` 后普通编译仅读取最后成功且正文匹配的缓存；缺缓存时跳过导读 |
| `mode` | `live` | `mock` 使用离线演示，不调用外部 AI |
| `cache_dir` | `.cache/hexo-ai-reader` | 构建缓存目录，相对于博客根目录 |
| `timeout_ms` | `240000` | 文本请求超时，毫秒；显式填写时，未单独配置的 TTS 超时也沿用该值 |
| `llm.stream` | `true` | 文本接口不支持 SSE 时设为 `false` |
| `llm.json_mode` | `false` | 接口支持 `response_format` 时可开启 JSON 模式 |
| `llm.max_input_chars` | `60000` | 提取正文输入的长度上限 |
| `tts.timeout_ms` | 百炼 `90000`，Qwen3 `600000` | 独立的语音请求或推理超时，毫秒 |
| `tts.timestamps` | `false` | 百炼模型支持时开启流式字级时间戳；默认使用估算对齐 |
| `tts.sample_rate` / `tts.rate` | `24000` / `1` | 百炼合成采样率与语速 |
| `tts.instruction` | 内置自然中文讲解指令 | 百炼合成语气，与导读写作风格分别配置 |
| `narration.max_chars` | `800` | 导读文字长度上限 |
| `narration.language` | `zh-CN` | 导读语言 |
| `narration.persona` | 留空 | 人物身份、视角和说话习惯，支持多行文本 |
| `narration.system_prompt` | 留空 | 补充文本模型的任务要求，支持多行文本 |
| `narration.style` | 内置自然讲解风格 | 调整导读稿的写作语气 |
| `player.name` | `海灵` | 角色显示名，用于播放、加载状态和可访问标签 |
| `player.title` | `<显示名>陪你读` | 播放前及暂停时的卡片标题，留空自动按显示名生成 |
| `player.avatar` | 留空使用内置 WebP 头像 | 站内绝对路径或 HTTP(S) 图片 URL |
| `player.auto_scroll` / `player.highlight` | 均为 `true` | 默认正文跟随和高亮 |
| `player.pause_scroll_ms` | `8000` | 用户手动滚动后暂停跟随的时长 |
| `player.click_to_seek` | `true` | 点击支持的正文段落跳转导读 |

人物设定、系统提示词和头像都可以省略。需要自定义时，把下面的字段合并进已有的 `ai_reader` 区块，保留现有 `llm`、`tts` 等配置：

```yaml
ai_reader:
  narration:
    persona: |-
      你是海灵，用“我”和“你”陪读者理解技术文章。
      语气亲切，不把文章作者的开发或实测经历说成自己的经历。
    system_prompt: |-
      先讲用途，再讲关键步骤，最后提醒限制与注意事项。
      直接讲解内容，避免反复使用“本文介绍”等转述。
    style: 自然、简洁，像和朋友聊天。
  player:
    name: 海灵
    title: 海灵 · 文章导读
    avatar: /images/reader-avatar.webp
```

`persona` 定义角色，`system_prompt` 补充任务要求，`style` 控制表达语气；它们共同用于初稿和超长稿压缩。插件统一约束 JSON 输出、字数、真实 source ID 和事实准确性；自定义提示词仍须遵守这些约束。人物设定和系统提示词只在构建端发送给文本模型，不放进 HTML 或播放器清单。

站内头像示例对应博客的 `source/images/reader-avatar.webp`，随 Hexo 编译复制到站点；插件会自动添加站点 `root` 前缀。也可以填写公开的完整图片地址，例如 `https://images.example.com/avatar.webp`。留空使用内置头像。头像设置只控制播放器图片，语音音色仍由 `tts` 配置。

`player.name` 设置界面显示名，`player.title` 设置播放前和暂停时显示的标题。播放和加载时提示使用显示名，例如“海灵正在为你解读”。人物设定仍由 `narration.persona` 控制；界面显示名不会自动改写朗读稿。

留空或省略新增提示词不会让已有文稿缓存失效。修改人物设定、系统提示词或风格后，下次 `hexo generate` 会生成新文稿；文本变化时补齐语音，文本相同则复用音频。只换头像、显示名或标题会复用文稿和音频，无需强制生成。

已有配置仍兼容环境变量回退：文本的 `OPENAI_BASE_URL`、`OPENAI_API_KEY`、`OPENAI_MODEL`；语音的 `DASHSCOPE_API_KEY`、`TTS_MODEL`、`TTS_VOICE_ID`（或 `HAILING_VOICE_ID`）、`DASHSCOPE_TTS_ENDPOINT`、`DASHSCOPE_WORKSPACE_ID`；模式的 `AI_READER_MODE`。新配置优先按 YAML 字段填写。

## 7. 缓存、持久化和并发

发布资源与构建缓存分开：

```text
public/ai-reader/
  reader.js
  reader.css
  avatar.webp
  <文章名-路径哈希>/
    manifest.json
    narration.wav

.cache/hexo-ai-reader/<文章名-路径哈希>/
  ready-live.json
  ready-mock.json
  guides/<文稿版本>/guide.json
  audio/<语音版本>/result.json
  audio/<语音版本>/narration.wav
  storage/<桶及对象哈希>.json  # 可选的 B2 上传和公开地址验证记录
```

百炼音频为 MP3，Qwen3 和 Mock 音频为 WAV。实际时长从音频文件解析，清单只包含导读、时间轴、音频站点路径和公开播放器设置；不会发布接口密钥、文本服务地址、业务空间、音色 ID、脚本路径或完整配置。

文稿与语音分别缓存，并校验音频 SHA-256。正常生成时，已经完成的文稿阶段会保留，语音失败后可只补语音；强制生成重做两个阶段。旧缓存仅在正文和配置精确匹配时迁移，不调用 API。

`hexo clean` 不删除插件缓存。请在本机或 CI 中保留 `.cache/hexo-ai-reader`；CI 每次丢弃缓存会导致重复生成。缓存无效且没有凭据时，普通构建告警并跳过导读，不能据此认定真实生成成功。

缓存和私有配置保持 Git 忽略。在博客根目录的 `.gitignore` 中至少加入：

```gitignore
.env
.env.ai-reader
.cache/hexo-ai-reader/
public/
db.json
voice/
```

不提交真实密钥、参考录音或生成音频缓存。部署发布目录由博客原有部署工具处理。

仅需删除某篇全部缓存版本时：

```bash
hexo ai-reader --clear "_posts/example.md"
```

`--clear` 也接受缓存中的文章目录名。它会删除该篇所有缓存版本，下一次自动编译重新生成；一般更新优先使用 `--force`，可在新版本失败时保留旧版。

自动生成、手动准备、强制生成和清理共享缓存目录的进程锁。另一个进程仍在运行时，命令提示 PID 并退出；等待它结束后重试。正常结束或失败会释放自己的锁，本机已退出进程的残留锁自动清理。锁不因长时间生成而过期；不同主机共享缓存目录时按锁仍有效处理，不假定能远程验证进程是否存活。

## 8. 播放器和时间轴

播放器提供播放/暂停、目录跳转、拖动进度、前后 10 秒、0.75～2 倍速、最小化与关闭。朗读文字随播放进度在卡片内切换，不再显示单独的底部字幕栏，也没有独立字幕开关。旧配置中的 `player.captions` 和浏览器保存的字幕偏好不再生效；清单中的 `captions` 时间轴仍用于卡片文字，不影响文稿与音频缓存。最小化时音频继续；关闭时暂停并清除高亮。正文跟随可在设置中关闭，手动滚动默认暂停跟随 8 秒。

播放进度按文章和音频版本保存在本浏览器，刷新或 PJAX 返回后提示继续播放，不自动播放。进度超过 90 天、音频更新或播放完成后不恢复。浏览器禁用存储仍可使用播放器。用户保存的跟随偏好优先于页面默认设置。

清单请求 12 秒超时，失败后可点击播放键重试；离开文章取消在途请求并停止旧音频。播放器浮层会还原主题处理过的头像懒加载属性。默认头像是约 7 KB 的 WebP，原始设计参考图仅保留在源码中。

正文使用稳定的 source ID 映射导读引用，不通过模糊搜索定位。代码、链接不会被直接朗读，未在正文中出现的引用会被校验拒绝。

默认段落和字幕时间按音频时长估算，不宣称逐字精确对齐。开启字级时间戳且返回数据完整、可对应、时间单调时使用服务商时间戳；缺失或不完整时降级为估算。清单中的 `alignment` 和 `captionAlignment` 标明采用的方法和是否精确。调整时间轴或展示算法无需重做已有音频。

## 9. 离线演示与故障处理

离线预览时，在博客已有 `ai_reader` 配置中设置 `mode: mock`，保留开关和目标文章的 `ai_reader: true`，然后运行 `hexo generate` 和 `hexo server -p 6845`。不需要文本或百炼凭据。

Mock 不调用外部 AI。macOS 可通过系统 `say` 生成完整 WAV；无可用系统音色时使用提示音。二者都不能证明真实 AI 文稿或百炼音色有效。

演示与真实缓存使用不同版本指针，但输出到相同的 `public/ai-reader/` 路径。演示完成后，按真实配置重新运行 `hexo generate` 再发布，避免将 Mock 产物发到线上。

| 现象 | 可能原因 | 处理 |
| --- | --- | --- |
| 页面无播放器，文章正常显示 | 未开启、被保护，或生成失败且没有匹配缓存 | 检查文章和全局开关，再查看跳过警告；修正后重新编译 |
| 报告缺少配置 | 必填字段为空或环境引用未解析 | 按报错的 YAML 字段补齐；检查变量来自当前构建环境 |
| API 返回 401/403 | 密钥或账号权限不匹配 | 核对对应服务的 Key、模型和音色权限 |
| API 返回 400 | 模型、音色、端点或输入不匹配 | 核对配置和音色绑定关系 |
| Qwen3 模块或参考文件不可读取 | 路径不存在或当前构建环境不具备该文件 | 核对 Node 22+、模块文件及 `tts.qwen3` 的参考路径 |
| Qwen3 生成失败、静音或损坏 WAV | 服务、参数或输出校验失败 | 先做环境自检；不要把退出码 0 当成成功，不自动重跑推理 |
| 文本 JSON 错误、引用无效或流被截断 | 模型输出或接口响应未通过校验 | 修正模型或接口设置后重新编译；网络错误不会自动循环重试 |
| 字幕或切段有少量偏差 | 使用估算时间轴 | 查看清单的对齐标记；不要将估算当作字级校准 |
| 显示导读加载失败 | 清单或音频不可访问、超时 | 点击播放键重试，检查部署路径和网络响应 |
| 提示已有准备或清理进程 | 共享缓存目录有活动任务 | 等待日志中的 PID 对应任务结束，勿抢删仍在使用的锁 |
| 出现 Mock 提示音 | 当前系统无可用演示音色 | 只用于交互验证；真实生成使用 live 配置 |
| 修改配置后仍是旧版 | 新版本生成失败并保留旧版，或配置未加载 | 检查日志和 `--config`；环境文件变更后重启服务器 |
| 命中缓存却没有生成数量 | 有效缓存被复用 | 属于正常结果；确需重做时使用 `--force` |

## 10. 开发与验证

在插件仓库根目录运行：

```bash
npm ci
npm test
npm pack --dry-run
git diff --check
```

开发依赖包含 Hexo 和测试用渲染器。测试覆盖配置、API 请求与流式解析、分阶段缓存、失败保留旧版、并发锁、播放恢复和真实 Hexo 构建。

播放器改动还需核对实际页面的播放、目录、字幕、重试、PJAX 进出、移动端及进度恢复。Mock 验证只说明交互可用；真实接口验证须区分新调用成功与既有缓存命中。

| 文件 | 职责 |
| --- | --- |
| `index.js`、`lib/plugin.js` | Hexo 生命周期、静态路由、播放器注入及控制台命令 |
| `lib/config.js`、`lib/environment.js` | YAML 参数、默认值和可选环境文件解析 |
| `lib/source.js` | 正文提取、稳定 ID、文章标识和缓存哈希 |
| `lib/providers.js` | 文本接口、百炼 TTS、响应校验和 Mock |
| `lib/qwen3-tts.mjs` | 内置纯 JS Qwen3 协议、生成、下载与音频检查 |
| `lib/qwen3.js`、`lib/qwen3-worker.cjs` | 渠道适配、独立进程、输入指纹及 WAV 校验 |
| `lib/build.js`、`lib/lock.js` | 分阶段缓存、版本发布、完整性校验和互斥 |
| `lib/timeline.js` | 时间戳对齐、估算段落和字幕时间轴 |
| `assets/reader.js`、`assets/reader.css`、`assets/avatar.webp` | 浏览器交互、样式和头像 |
| `test/*.test.js` | 单元、接口及真实 Hexo 集成验证 |
| [AGENTS.md](AGENTS.md) | 本插件维护约束和交付核对项 |
| [DESIGN_REVIEW.md](DESIGN_REVIEW.md) | 历次实现与验证记录；当前用法以本 README 为准 |

## 接口参考

实际可调用模型和参数以自己的账号、地域及服务接口为准：

- [阿里百炼 Qwen-Audio-TTS HTTP API](https://help.aliyun.com/zh/model-studio/qwen-audio-tts-http-api)
- [阿里百炼语音合成](https://help.aliyun.com/zh/model-studio/qwen-tts)
- [阿里百炼 TTS 模型说明](https://help.aliyun.com/zh/model-studio/tts-model)
- [阿里百炼声音复刻](https://help.aliyun.com/zh/model-studio/voice-cloning-user-guide)
