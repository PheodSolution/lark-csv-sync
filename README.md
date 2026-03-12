# Lark CSV Sync — 本地桌面同步工具

> 面向国际版 Lark（`larksuite.com`）的本地桌面 CSV 同步工具。  
> 采用 `user_access_token` 登录方式，**不支持飞书（feishu.cn）**。

## 功能特性

- **四种同步模式**：`insert`（仅新增）/ `update`（仅更新）/ `upsert`（更新 + 新增）/ `empty`（空插：按 Key 匹配后将映射字段清空）
- **字段映射配置**：
  - Key 字段映射 — 用于匹配已有记录（支持多字段复合 Key）
  - 更新字段映射 — 同步时写入的字段
  - 新增字段映射 — 新增记录时写入的字段
  - 同名自动匹配 — CSV 列名与 Base 字段名相同时自动映射（自动排除附件、关联、公式、自动系统字段）
  - 字段类型显示 — 下拉选择时显示字段类型标签（共 21 种类型标签：テキスト、数値、単一選択、複数選択、日時、チェックボックス、ユーザー、電話番号、URL、添付ファイル、リンク、数式、双方向リンク、場所、作成日時、更新日時、作成者、更新者、オートナンバー、バーコード、自動採番、通貨、評価）
- **大规模数据同步**：支持 25 万行级别 CSV 文件（流式读取 + 批量写入，默认 500 条/批次）
- **断点续传**：自动保存进度检查点（`.sync-checkpoint-*.json`），中断后可从上次位置继续
- **执行报告**：每次同步生成 JSON 格式详细报告，记录成功/失败/跳过行数及失败原因
- **错误日志 CSV 导出**：同步完成后如有失败行，自动生成错误日志 CSV 文件（原始行数据 + error 列），文件名格式：`{CSV文件名}_error_YYYYMMDDHHMMSS.csv`，支持一键下载
- **关联字段自动解析**：自动扫描关联表，通过文本值反查关联记录 ID，支持直接写入记录 ID（`rec` 开头）
- **多编码支持**：UTF-8 / Shift_JIS (CP932) / GBK
- **双运行模式**：桌面窗口（Electron）和浏览器模式
- **命令行模式**：支持通过 CLI 直接运行，适合自动化脚本，附带配置存档（Profile）功能
- **OAuth 登录**：通过 Lark OAuth 2.0 获取 `user_access_token`，支持 OIDC + 旧版双通道自动刷新令牌
- **CSV 表头智能处理**：重复列名自动去重（`column_2`），支持 BOM 头文件
- **业务预设同步规则**：上传文件名包含 `使用量` / `料金` / `所有器具` / `購入履歴` 时，自动锁定对应表、模式和字段映射（前端 UI 进入只读模式）
- **Key 字段更新保护**：作为匹配 Key 的字段自动从更新映射中排除，防止 Key 字段被覆盖写入
- **索引扫描 Fallback 机制**：当 search API 分页游标异常（重复 page_token）时，自动切换到 list records API 重建索引
- **前端完全日语化**：所有用户可见文本均为日语（状态徽章、进度阶段、错误消息、操作提示等）

### 文件名预设（自动套用）

| 文件名包含 | 模式 | 目标表 | Key 字段 |
|------|------|------|------|
| `使用量` | `update` | `顧客管理` | 需要家コード |
| `料金` | `update` | `顧客管理` | 需要家コード |
| `所有器具` | `upsert` | `所有器具` | 需要家コード + 連番 |
| `購入履歴` | `upsert` | `購入履歴` | 需要家コード + 購入日 + 分類コード |

> 预设命中后，GUI 后端会以预设映射为准执行同步（覆盖页面手工模式与表选择），前端进入只读锁定状态。

---

## 1. 环境要求

| 项目 | 要求 |
|------|------|
| 操作系统 | Windows 10 / 11 |
| Node.js | 20 或以上版本 |
| Lark 应用 | 需在 [Lark 开发者平台](https://open.larksuite.com/) 创建应用 |
| 应用权限 | 启用 **Bitable / Base** 相关权限范围 |
| OAuth 回调地址 | 在 Lark 开发者平台添加：`http://127.0.0.1:3904/api/auth/callback` |

---

## 2. 安装配置

### 2.1 安装依赖

在 `new` 文件夹中，双击 `install.bat`，脚本会自动：

1. 检查 Node.js 是否已安装
2. 执行 `npm install` 安装依赖
3. 若 `.env` 文件不存在，从 `.env.example` 自动创建

### 2.2 配置环境变量

编辑项目根目录下的 `.env` 文件：

```env
LARK_APP_ID=cli_xxxxxxxxxxxxxxxxx
LARK_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
LARK_OPENAPI_BASE=https://open.larksuite.com
```

| 变量 | 说明 | 必填 |
|------|------|------|
| `LARK_APP_ID` | Lark 应用的 App ID | ✅ |
| `LARK_APP_SECRET` | Lark 应用的 App Secret | ✅ |
| `LARK_OPENAPI_BASE` | OpenAPI 基础地址（默认 `https://open.larksuite.com`） | ❌ |
| `GUI_PORT` | GUI 服务端口（默认 `3904`，启动脚本中设置） | ❌ |
| `GUI_PORT_STRICT` | 端口占用时是否禁止自动递增（`1` = 严格模式） | ❌ |
| `LARK_SYNC_DATA_DIR` | 数据文件存储目录（仅桌面模式，默认 Electron `userData/runtime`） | ❌ |

---

## 3. 启动方式

### 推荐：桌面窗口模式（Electron）

操作界面在本地 Electron 窗口中运行，无需使用外部浏览器。OAuth 登录弹窗自动在应用内管理。

| 启动文件 | 说明 |
|----------|------|
| `start.bat` | **默认启动**（推荐） |
| `start-gui.bat` | 桌面窗口别名（功能相同） |
| `start-desktop.bat` | 桌面窗口别名（功能相同） |

### 备用：浏览器模式

- 双击 `start-web.bat`
- 启动后自动打开浏览器访问 `http://127.0.0.1:3904`
- 仅用于调试或兼容性测试

### 命令行模式（CLI）

```bash
node src/main.js --url "<Base URL>" --csv "<CSV 文件路径>" [选项]
```

CLI 可用选项：

| 选项 | 说明 | 默认值 |
|------|------|--------|
| `--url` | Lark Base URL（需包含 `bas` token） | — |
| `--csv` | CSV 文件路径 | — |
| `--mode` | `insert` / `update` / `upsert` / `empty` | `upsert` |
| `--encoding` | `utf8` / `shift_jis` / `gbk` | `utf8` |
| `--map` | 字段映射，如 `"Name=姓名,Email=邮箱"` | — |
| `--key` | Key 映射，如 `"ID=记录ID"` | — |
| `--clear-empty` | CSV 空值是否清空目标字段（update/upsert 模式中忽略） | `false` |
| `--batch` | 批次大小（1〜500） | `500` |
| `--checkpoint` | 检查点文件路径 | `.sync-checkpoint.json` |
| `--resume` | 从指定行号恢复同步 | — |
| `--app-id` | Lark App ID（也可在 `.env` 设置） | — |
| `--app-secret` | Lark App Secret（也可在 `.env` 设置） | — |
| `--api-base` | OpenAPI 基础地址 | `https://open.larksuite.com` |
| `--profile-file` | 配置存档文件路径 | `.lark-sync-profiles.json` |
| `--no-profile` | 禁用配置存档的加载/保存 | — |
| `--help` | 显示帮助信息 | — |

#### CLI 配置存档（Profile）功能

CLI 模式下，每次成功执行后会自动将映射配置保存到 `.lark-sync-profiles.json` 文件中，以 `appToken:tableId` 为键。下次对同一张表执行时，会自动复用已保存的映射配置（交互模式下会提示确认）。使用 `--no-profile` 可禁用此功能。

---

## 4. 使用流程（GUI 界面）

1. **Lark 登录** — 点击「Lark ログイン」按钮，通过 OAuth 登录获取 `user_access_token`
2. **选择 CSV 文件** — 选择需要同步的 CSV 文件（支持最大 1GB）
3. **加载 Schema** — 自动读取目标 Base 表结构和 CSV 列名，也可点击「スキーマ再読込」手动刷新
4. **配置映射**：
   - **Key 字段映射**：指定用于匹配已有记录的字段（`update` / `upsert` 模式必填）
   - **更新/新增字段映射**：指定同步时写入的字段（字段名旁显示类型标签）
   - 或点击「自動マッピング」自动匹配同名字段
5. **开始同步** — 点击「同期開始」按钮启动同步
6. **查看结果** — 实时查看处理数/追加/更新/失败/跳过/索引件数，含进度条（百分比）和阶段提示，同步完成后可下载 JSON 报告
7. **错误日志下载** — 如有失败行，同步完成后自动显示「エラーCSVをダウンロード」按钮，点击下载包含失败行原始数据和错误原因的 CSV 文件

---

## 5. 端口与 OAuth 说明

- **默认端口**：桌面/浏览器模式均使用 `3904`（启动脚本中 `set GUI_PORT=3904`）
- `gui-server.js` 代码默认端口为 `3900`，但启动脚本会覆盖为 `3904`
- 启动脚本会**自动终止**占用 `127.0.0.1:3904` 端口的进程
- 非严格端口模式下（未设`GUI_PORT_STRICT=1`），如端口被占用会自动尝试 `端口+1`
- Lark 开发者平台的 OAuth 回调地址必须**精确匹配**：
  - `http://127.0.0.1:3904/api/auth/callback`
- 桌面模式使用**单实例锁**，防止重复启动

---

## 6. 常见错误排查

### HTTP 403 / 错误码 91403

出现此错误的可能原因：

- 当前登录用户**没有权限**访问目标 Base
- 应用未启用 **Bitable / Base** 相关权限范围
- 应用未安装到正确的**租户/工作空间**
- 使用了错误的域名（必须使用 `larksuite.com` 和 `open.larksuite.com`，不支持 `feishu.cn`）

### 其他常见问题

| 错误 | 解决方案 |
|------|----------|
| `state が一致しません` | OAuth 状态校验失败，请重新登录 |
| `user_access_token の取得に失敗` | 令牌获取失败，检查 App ID / Secret 是否正确 |
| `refresh_token がありません` | 刷新令牌失效，请重新登录 |
| `CSVファイルが未アップロード` | 请先选择 CSV 文件 |
| `Base URL が空です` | 请输入正确的 Lark Base URL |
| `matched multiple records with same key` | Key 字段匹配到多条记录，请使用唯一性更强的 Key |
| `missing key value` | CSV 行中 Key 字段为空，该行会被标记为失败 |
| `record not found in update mode` | update 模式下未匹配到已有记录，该行被标记为失败 |

---

## 7. 项目结构

```
new/
├── .env                          # 环境变量配置（App ID / Secret）
├── .env.example                  # 环境变量模板
├── .gitignore                    # Git 忽略规则
├── package.json                  # 项目依赖与脚本
├── install.bat                   # 一键安装脚本
├── start.bat                     # 默认启动（桌面窗口）
├── start-gui.bat                 # 桌面启动别名
├── start-desktop.bat             # 桌面启动别名
├── start-web.bat                 # 浏览器模式启动
├── build-exe.bat                 # 构建 Electron 便携版 EXE（无黑窗）
├── build-installer.bat           # 构建 Electron 安装版 EXE
├── public/                       # 前端 UI 资源
│   ├── index.html                #   HTML 页面（日文界面）
│   ├── app.js                    #   前端交互逻辑（IIFE，无框架依赖）
│   └── styles.css                #   样式表（响应式布局）
├── src/                          # 后端源码
│   ├── desktop-main.js           #   Electron 主进程（桌面窗口壳）
│   ├── gui-server.js             #   Express 本地服务（API + OAuth + 同步）
│   ├── lark-api.js               #   Lark OpenAPI 封装（认证、表操作、记录CRUD）
│   ├── sync-engine.js            #   同步引擎核心（批量读写、断点续传）
│   ├── sync-presets.js           #   业务预设规则（文件名→表/模式/映射 自动匹配）
│   ├── csv-stream.js             #   CSV 流式解析（多编码支持 + 表头去重）
│   ├── checkpoint.js             #   检查点存储/加载
│   └── main.js                   #   CLI 命令行入口（含 Profile 存档机制）
├── reports/                      # 同步执行报告与错误日志
│   ├── sync-report-*.json        #   同步报告（JSON 格式）
│   └── *_error_*.csv             #   错误日志（失败行原始数据 + error 列）
└── .sync-checkpoint-*.json       # 断点续传检查点文件
```

---

## 8. 技术栈与依赖

### 运行时依赖

| 依赖包 | 版本 | 用途 |
|--------|------|------|
| `csv-parse` | ^5.5.6 | CSV 文件流式解析 |
| `dotenv` | ^16.6.1 | 环境变量加载（`.env` 文件） |
| `express` | ^4.21.2 | 本地 HTTP 服务端（API 和静态文件） |
| `iconv-lite` | ^0.6.3 | 字符编码转换（Shift_JIS / GBK 等） |
| `multer` | ^2.0.2 | 文件上传处理（CSV 文件接收，限制 1GB） |
| `open` | ^10.1.0 | 自动打开浏览器（浏览器模式） |
| `prompts` | ^2.4.2 | CLI 交互式提示 |

### 开发依赖

| 依赖包 | 版本 | 用途 |
|--------|------|------|
| `electron` | ^37.6.0 | 桌面窗口运行环境 |
| `electron-builder` | ^24.13.3 | 将 Electron 桌面程序打包为 Windows EXE |
| `pkg` | ^5.8.1 | 将 CLI 命令行工具打包为独立 EXE |

### NPM 脚本

| 命令 | 说明 |
|------|------|
| `npm start` | 启动桌面窗口模式（Electron） |
| `npm run gui` | 启动浏览器模式（Express 服务端） |
| `npm run cli` | 启动 CLI 命令行模式 |
| `npm run desktop` | 启动桌面窗口模式（别名） |
| `npm run build:exe` | 构建 Electron 便携版 EXE（默认，无黑窗） |
| `npm run build:installer` | 构建 Electron 安装版 EXE |
| `npm run build:cli` | 构建 CLI 独立 EXE |

---

## 9. 核心架构说明

### 同步引擎（sync-engine.js）

- **流式读取**：逐行读取 CSV 文件，避免一次性加载到内存，支持大文件
- **批量写入**：累积到设定批次大小后，调用 Lark API 批量创建/更新记录
- **并发写入**：使用 **25 并发**（`CONCURRENCY_WRITE = 25`）并行执行批量操作
- **失败降级**：批量操作失败时，自动降级为单条写入，最大化成功率
- **字段类型智能转换**：根据 Lark 表字段元数据（field_meta），自动将 CSV 文本值转为对应类型
  - 数字（type=2）、日期时间（type=5）、布尔（type=7）、多选（type=4）
  - 日期时间支持 ISO 格式、紧凑格式（`YYYYMMDD`）、Unix 时间戳（秒/毫秒）
  - 关联字段：支持直接 `rec` 记录 ID 和通过文本反查两种方式
- **关联字段解析**：自动扫描关联表的文本/数字/电话/URL/场所类字段，建立 `值→记录ID` 索引，实现文本值自动解析为关联记录
- **键值索引**：在 `update` / `upsert` / `empty` 模式下，先全量扫描目标表建立内存索引，再逐行匹配
- **索引 Fallback**：若 search API 分页出现重复游标异常（最多重试 5 次，指数退避 500ms~5s），自动切换到 list records API 重建索引
- **重复 Key 处理**：同一批次中相同 Key 的新增行会合并字段后只插入一次
- **分页安全检查**：检测并中止 Lark API 返回重复 page_token 的异常情况，并对重复 record_id 进行去重
- **Key 字段更新保护**：作为匹配 Key 的字段自动从更新映射中排除，即使用户在更新映射中配置了 Key 字段，引擎也会自动过滤掉并在控制台输出警告
- **进度上报**：每 100 行或 500ms 上报一次进度，每 1000 行输出一次日志
- **错误行数据保存**：每个失败行保存完整的原始 CSV 行数据（`rowData`），用于同步完成后生成错误日志 CSV

### 业务预设模块（sync-presets.js）

- 根据上传 CSV 文件名关键词自动匹配预设规则
- 预设包含目标表名、同步模式、Key/更新/新增字段映射的完整配置
- 匹配时使用忽略大小写的关键词包含检测
- 提供 `detectSyncPreset()` 和 `findTableByName()` 两个导出函数
- GUI 和 CLI 两端均调用此模块实现预设检测

### Lark API 客户端（lark-api.js）

- 封装所有 Lark OpenAPI 调用（认证、表管理、记录 CRUD）
- 使用原生 `fetch` API（Node.js 20+ 内置），无额外 HTTP 客户端依赖
- 内置自动重试机制（最多 6 次），支持指数退避（基础间隔 500ms，最大 30s，随机抖动 200ms）
- 可重试错误码：`1254290`（频率限制）、`1254291`（写冲突）、`1254607`（数据未就绪）、`1255040`（请求超时）
- HTTP 429（Too Many Requests）和 504（Gateway Timeout）也会触发重试
- 401 自动刷新令牌
- **OIDC 双通道**：Token 交换和刷新优先使用 OIDC 端点，失败后自动回退旧版端点

### GUI 服务端（gui-server.js）

- Express 本地服务，绑定 `127.0.0.1`，默认端口 `3900`（启动脚本覆盖为 `3904`）
- API 端点：
  - `GET /api/defaults` — 读取默认配置（App ID/Secret、模式、编码等）
  - `POST /api/auth/start` — 发起 OAuth 登录
  - `GET /api/auth/callback` — OAuth 回调处理
  - `GET /api/auth/session/:id` — 查询登录会话状态
  - `POST /api/upload` — CSV 文件上传
  - `POST /api/bootstrap` — 加载表结构和 CSV 表头（含字段类型信息、自动映射候选和预设检测）
  - `POST /api/start` — 启动同步任务（含预设检测，预设命中时覆盖手工配置）
  - `GET /api/jobs/:id` — 查询任务状态
  - `GET /api/report/:id` — 下载同步报告
  - `GET /api/error-csv/:id` — 下载错误日志 CSV（失败行原始数据 + error 列）
- 同步完成后自动生成错误日志 CSV 文件（如有失败行），文件名：`{CSV文件名}_error_YYYYMMDDHHMMSS.csv`
- 国际版域名强校验：拒绝 `feishu.cn`，仅允许 `larksuite.com`
- 上传文件自动清理：24 小时后自动删除临时文件
- 日文文件名智能解码：处理 `Content-Disposition` 中的编码问题
- OAuth state 宽松匹配：当只有一个 15 分钟内的待定 auth 记录时，即使 state 不完全匹配也可完成回调

### 桌面主进程（desktop-main.js）

- Electron 应用壳，自动启动嵌入式 Express 服务端
- 内置 OAuth 登录弹窗管理（使用 `setWindowOpenHandler` 在应用内打开）
- 单实例锁（`requestSingleInstanceLock`），防止重复启动
- 窗口配置：1320×900 默认大小，1024×720 最小大小
- 启动前检测服务是否已存活，若已运行则复用已有服务
- 数据目录：桌面模式自动设置 `LARK_SYNC_DATA_DIR` 为 `app.getPath('userData')/runtime`
- 安全沙箱配置：`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`

### CSV 流式解析（csv-stream.js）

- 基于 `csv-parse` 库的流式解析器
- 支持 UTF-8 BOM 标记自动处理
- 编码标准化：`sjis`、`cp932` 统一映射为 `shift_jis`，`utf-8` 映射为 `utf8`
- 重复表头自动去重：`column` → `column`、`column_2`、`column_3`
- 宽容解析模式：`relax_quotes`（宽松引号）、`relax_column_count`（宽松列数）、自动跳过空行
- 提供 `countCsvRows()` 函数用于同步前预估总行数

### 检查点管理（checkpoint.js）

- 提供 `resolveCheckpointPath()`、`loadCheckpoint()`、`saveCheckpoint()` 三个函数
- 检查点文件记录 `appToken`、`tableId`、`csvPath`、`mode`、`processedRows`、`completed` 状态和时间戳
- 恢复时校验 appToken、tableId、csvPath、mode 是否匹配，且未标记 completed

### 前端 UI（public/）

- 纯原生 JavaScript（IIFE 封装），无框架依赖
- 日文界面（`lang="ja"`）
- 响应式布局，支持移动端自适应
- 实时状态轮询（1.8 秒间隔）
- 字段下拉框显示类型标签（テキスト、数値、チェックボックス 等 21 种类型）
- 进度条显示：包含阶段提示（待機中 → 初期化中 → 関連フィールド解析中 → 既存レコード索引中 → 同期実行中 → 最終処理中 → 完了）和百分比
- 预设锁定模式：预设命中时 UI 自动进入只读状态，表选择和映射配置不可修改
- 错误日志下载按钮：同步完成且有失败行时自动显示「エラーCSVをダウンロード」红色按钮

---

## 10. Lark API 接口清单与速率限制

本项目共调用了 **14 个 Lark API 接口**，分为三大类：

### 10.1 认证相关 API（4 个接口）

| API 接口 | 方法 | 路径 | 用途 |
|----------|------|------|------|
| 获取 app_access_token | POST | `/open-apis/auth/v3/app_access_token/internal` | 获取应用访问令牌（用于后续换取 user_access_token） |
| 获取 tenant_access_token | POST | `/open-apis/auth/v3/tenant_access_token/internal` | 获取租户访问令牌（CLI 模式备用） |
| 用户授权页面 | GET | `/open-apis/authen/v1/index` | 构造 OAuth 登录 URL，引导用户授权 |
| 获取用户信息 | GET | `/open-apis/authen/v1/user_info` | 获取当前登录用户的名称、open_id 等信息 |

### 10.2 OAuth Token 交换（4 个接口，含兼容旧版）

| API 接口 | 方法 | 路径 | 用途 |
|----------|------|------|------|
| 授权码换 Token（OIDC） | POST | `/open-apis/authen/v1/oidc/access_token` | 用授权码换取 user_access_token（优先使用） |
| 授权码换 Token（旧版） | POST | `/open-apis/authen/v1/access_token` | OIDC 失败时的 fallback |
| 刷新 Token（OIDC） | POST | `/open-apis/authen/v1/oidc/refresh_access_token` | 刷新 user_access_token（优先使用） |
| 刷新 Token（旧版） | POST | `/open-apis/authen/v1/refresh_access_token` | OIDC 失败时的 fallback |

### 10.3 多维表格 API（6 个接口）

| API 接口 | 方法 | 路径 | 用途 | 每次最大条数 |
|----------|------|------|------|-------------|
| 列出数据表 | GET | `/open-apis/bitable/v1/apps/{app_token}/tables` | 获取 Base 下所有数据表 | `page_size=100` |
| 列出字段 | GET | `/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/fields` | 获取表的所有字段元数据 | `page_size=500` |
| **检索记录** | POST | `/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records/search` | 搜索/检索表内记录（建立键值索引 + 关联字段解析） | `page_size=500` |
| **列出记录** | GET | `/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records` | 列出表内记录（search API 分页异常时的 fallback 索引扫描） | `page_size=500` |
| **批量新增** | POST | `/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records/batch_create` | 批量创建记录 | 最大 **500 条/批** |
| **批量更新** | POST | `/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records/batch_update` | 批量更新记录 | 最大 **500 条/批** |

### 10.4 多维表格核心 API 速率限制（QPS）

根据 Lark 官方文档，三个核心操作的速率限制如下：

| 操作 | API | 官方 QPS 限制 | 每次最大条数 | 理论最大吞吐量 |
|------|-----|--------------|-------------|---------------|
| **检索记录** (search) | `records/search` | **20 次/秒** | 500 条/页 | 10,000 条/秒 |
| **批量新增** (batch_create) | `records/batch_create` | **50 次/秒** | 500 条/批 | 25,000 条/秒 |
| **批量更新** (batch_update) | `records/batch_update` | **50 次/秒** | 500 条/批 | 25,000 条/秒 |

### 10.5 项目实测性能

本项目写入操作采用 **25 并发**（`CONCURRENCY_WRITE = 25`），检索因游标分页限制为**串行**。

| 操作 | 项目实测速度 | 并发数 | 说明 |
|------|------------|--------|------|
| **检索记录** | ~1,500~2,500 条/秒 | 串行（无法并发） | 游标分页（`page_token`）必须串行，无法并行化 |
| **批量新增** | ~1,800 条/秒 | 25 并发 | 实测 50,000 条 / 28 秒 |
| **批量更新** | ~1,800 条/秒 | 25 并发 | 与新增使用相同并发逻辑 |

> **为什么检索达不到理论值 10,000 条/秒？**
>
> 理论值需要同时发送 20 个请求，但 Lark search API 采用游标分页（`page_token`），每页的请求必须等上一页返回后才能发出，因此只能串行执行。实际速度取决于单次 API 往返时间（~200~500ms），即 `500 条 ÷ 0.3 秒 ≈ 1,600 条/秒`。

### 10.6 大规模数据同步耗时参考

以 **25 万条数据**为例（upsert 模式）：

| 阶段 | 速度 | 预计耗时 |
|------|------|---------| 
| 检索建索引（全表扫描） | ~1,500~2,500 条/秒 | 约 1.5~3 分钟 |
| 关联字段解析（如有） | ~1,500~2,500 条/秒 | 约 1~2 分钟 |
| 批量写入（25 并发） | ~1,800 条/秒 | 约 2.5 分钟 |
| **合计** | — | **约 4~7 分钟** |

> **注意事项**：
>
> - 项目代码中批次大小上限硬编码为 **500 条**（`clampBatchSize` 函数限制 1–500）
> - 超过 QPS 限制时，Lark 返回 HTTP **429** 或错误码 `1254290`，项目内置了**自动重试 + 指数退避**机制（最多 6 次重试，基础间隔 500ms，最大 30s）
> - 写冲突（`1254291`）、数据未就绪（`1254607`）、请求超时（`1255040`）也会触发自动重试
> - 实际耗时受网络延迟、Lark 服务端负载、字段复杂度等因素影响

---

## 11. GUI API 端点一览

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/api/defaults` | 返回 `.env` 中的默认配置 |
| `POST` | `/api/auth/start` | 发起 OAuth 登录，返回授权 URL |
| `GET` | `/api/auth/callback` | OAuth 回调处理，完成 Token 交换 |
| `GET` | `/api/auth/session/:id` | 查询登录会话状态 |
| `POST` | `/api/upload` | 上传 CSV 文件（单文件，限 1GB） |
| `POST` | `/api/bootstrap` | 加载表结构、CSV 列名、字段类型、自动映射候选及预设检测 |
| `POST` | `/api/start` | 启动同步任务（异步执行，含预设自动检测） |
| `GET` | `/api/jobs/:id` | 查询同步任务状态和统计 |
| `GET` | `/api/report/:id` | 下载同步报告（JSON 文件） |
| `GET` | `/api/error-csv/:id` | 下载错误日志 CSV（失败行原始数据 + error 列） |

---

## 12. 许可证

本项目为私有项目（`"private": true`），仅供授权用户使用。
