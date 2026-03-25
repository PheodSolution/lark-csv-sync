# app.js 前端代码注释文档

## 文件概述

`public/app.js` 是 Lark CSV 同步工具的前端 JavaScript 代码,使用 IIFE(立即执行函数表达式)封装,无框架依赖,纯原生 JavaScript 实现。

## 主要功能

1. **OAuth 认证管理** - 处理 Lark 登录流程
2. **文件上传** - CSV 文件上传和管理
3. **字段映射配置** - Key/更新/新增字段映射的 UI 交互
4. **同步任务管理** - 启动同步、轮询进度、显示结果
5. **进度显示** - 实时进度条和阶段提示
6. **错误处理** - 错误提示和错误日志下载
7. **预设规则支持** - 自动锁定 UI 当预设匹配时

---

## 核心数据结构

### MODE_META - 同步模式元数据

```javascript
const MODE_META = {
  update: {
    label: "更新のみ",           // 显示标签
    tip: "...",                   // 提示文本
    needsKey: true,               // 是否需要 Key 映射
  },
  upsert: { ... },
  insert: { ... },
  empty: { ... }
};
```

### state - 全局状态对象

```javascript
const state = {
  // 状态标志
  busy: false,              // 是否正在处理请求
  running: false,           // 是否正在同步

  // 认证信息
  authSessionId: "",        // 登录会话 ID
  authUserName: "",         // 用户名

  // 文件和任务
  uploadId: "",             // 上传文件 ID
  jobId: "",                // 同步任务 ID
  pollTimer: null,          // 轮询定时器

  // 表和字段信息
  tables: [],               // 表列表
  selectedTableId: "",      // 选中的表 ID
  fieldNames: [],           // 字段名数组
  fieldTypes: {},           // 字段类型映射
  csvHeaders: [],           // CSV 列名数组
  autoMappings: [],         // 自动映射建议

  // 预设和锁定
  preset: null,             // 预设规则对象
  mappingLocked: false,     // 映射是否锁定(预设模式)

  // 配置
  hasSavedConfig: false,    // 是否有已保存的配置
  configModalOpen: false,   // 配置模态框是否打开

  // 默认值
  defaults: {
    encoding: "utf8",       // CSV 编码
    batchSize: 500,         // 批次大小
    clearEmpty: false,      // 是否清空空值
    resumeRow: 0,           // 恢复行号
  },

  // 字段映射
  keyMappings: [...],       // Key 映射数组
  updateMappings: [...],    // 更新映射数组
  insertMappings: [...],    // 新增映射数组
};
```

### el - DOM 元素引用对象

缓存所有需要操作的 DOM 元素引用,避免重复查询。

---

## 核心函数说明

### 1. 映射管理函数

#### createMappingRow(partial)

创建映射行对象

- 生成唯一 ID
- 返回 `{ id, fieldName, csvColumn }`

#### renderMappings()

渲染所有映射列表(Key/更新/新增)

- 生成 HTML 字符串
- 填充下拉选择框
- 处理预设锁定状态

#### addRow(group)

添加新的映射行

- group: 'key' | 'update' | 'insert'

#### removeRow(group, mapId)

删除指定的映射行

#### upsertRowValue(group, mapId, patch)

更新映射行的值

### 2. 模式和视图函数

#### modeInfo()

获取当前模式的元数据

- 返回 MODE_META 中对应的对象

#### refreshModeView()

刷新模式相关的 UI 显示

- 显示/隐藏 Key 映射卡片
- 显示/隐藏更新/新增映射卡片
- 更新提示文本

#### refreshControls()

刷新所有控件的启用/禁用状态

- 根据 state.busy、state.running 等状态
- 处理预设锁定状态

### 3. 进度显示函数

#### setProgressView(input)

设置进度条显示

```javascript
input = {
  phaseText: "同期実行中", // 阶段文本
  percent: 50, // 百分比(0-100)
  detail: "...", // 详细信息
  indeterminate: false, // 是否不确定进度
};
```

#### phaseLabel(phase)

将阶段代码转换为日文标签

- 'queued' => '待機中'
- 'initializing' => '初期化中'
- 'resolving-links' => '関連フィールド解析中'
- 'indexing' => '既存レコード索引中'
- 'running' => '同期実行中'
- 'finalizing' => '最終処理中'
- 'completed' => '完了'
- 'failed' => '失敗'

#### buildProgressFromJob(jobData)

从任务数据构建进度显示对象

- 计算百分比
- 生成阶段文本和详细信息
- 处理不同阶段的进度计算

### 4. 状态显示函数

#### setStatus(type, text)

设置状态徽章

- type: 'idle' | 'running' | 'success' | 'failed'
- 更新徽章样式和文本

#### updateStats(stats)

更新统计数字显示

- 处理数/追加/更新/失败/跳过/索引件数

#### resetStats()

重置所有统计数字为 0

### 5. 提示信息函数

#### showError(text)

显示错误提示

- 红色警告框
- 空字符串则隐藏

#### showInfo(text)

显示信息提示

- 蓝色信息框
- 空字符串则隐藏

### 6. API 调用函数

#### api(path, options)

统一的 API 调用函数

```javascript
const data = await api("/api/endpoint", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});
```

- 自动处理错误
- 解析 JSON 响应
- 提取 data 字段

### 7. OAuth 认证函数

#### startLogin()

启动 OAuth 登录流程

1. 调用 `/api/auth/start` 获取授权 URL
2. 打开弹窗进行登录
3. 监听 postMessage 接收登录结果

#### handleAuthMessage(event)

处理 OAuth 回调消息

- 验证消息来源
- 保存会话信息
- 更新登录状态

### 8. 文件上传函数

#### uploadCsv(file)

上传 CSV 文件

1. 创建 FormData
2. 调用 `/api/upload`
3. 保存 uploadId
4. 显示文件信息
5. 自动加载 Schema

### 9. Schema 加载函数

#### loadSchema(tableId)

加载表结构和 CSV 表头

1. 调用 `/api/bootstrap`
2. 获取表列表、字段列表、CSV 列名
3. 检测预设规则
4. 应用预设或自动映射
5. 渲染 UI

#### tryAutoLoadSchema()

尝试自动加载 Schema

- 检查必要条件(已登录、已上传、有 Base URL)
- 自动调用 loadSchema

### 10. 同步任务函数

#### startSync()

启动同步任务

1. 验证映射配置
2. 收集同步参数
3. 调用 `/api/start`
4. 开始轮询进度

#### pollJob(jobId)

轮询任务状态

- 每 1.8 秒调用一次 `/api/jobs/:id`
- 更新进度显示
- 检测完成或失败状态
- 显示错误日志下载按钮

#### stopPolling()

停止轮询

- 清除定时器

### 11. 映射验证函数

#### validateMappings()

验证映射配置

- 检查必需的映射是否存在
- 检查字段名是否重复
- 根据模式验证不同的映射要求

#### validMappings(rows)

过滤有效的映射行

- 返回 fieldName 和 csvColumn 都不为空的行

#### ensureUniqueFields(rows, label)

确保字段名唯一

- 检查是否有重复的 fieldName
- 抛出错误如果有重复

### 12. 自动映射函数

#### applyAutoMappings()

应用自动映射建议

- 将 state.autoMappings 应用到更新和新增映射
- 重新渲染映射列表

### 13. 配置管理函数

#### openConfigModal()

打开配置模态框

#### closeConfigModal()

关闭配置模态框

#### saveSettings()

保存配置到服务器

- 调用 `/api/settings`
- 更新本地状态

#### collectSettingsPayload()

收集配置表单数据

### 14. 工具函数

#### escapeHtml(input)

转义 HTML 特殊字符

- 防止 XSS 攻击

#### toSafeInteger(value)

安全地转换为整数

- 返回 >= 0 的整数

#### clampPercent(value)

限制百分比在 0-100 之间

#### log(message)

输出带时间戳的日志到控制台

---

## 事件监听器

### 页面加载完成

```javascript
window.addEventListener("DOMContentLoaded", init);
```

- 初始化应用
- 加载默认配置
- 绑定所有事件监听器

### OAuth 消息监听

```javascript
window.addEventListener("message", handleAuthMessage);
```

- 接收 OAuth 登录结果

### 文件选择

```javascript
el.csvFile.addEventListener("change", (e) => {
  uploadCsv(e.target.files[0]);
});
```

### 按钮点击

- 登录按钮 => startLogin()
- 开始同步按钮 => startSync()
- 自动映射按钮 => applyAutoMappings()
- 重载 Schema 按钮 => loadSchema()
- 添加映射按钮 => addRow()
- 配置按钮 => openConfigModal()

### 下拉选择变化

- 表选择 => loadSchema(newTableId)
- 模式选择 => refreshModeView()
- 映射下拉框 => upsertRowValue()

### 映射列表事件委托

```javascript
el.keyMappingsList.addEventListener("change", handleMappingChange);
el.keyMappingsList.addEventListener("click", handleMappingClick);
```

- 处理映射行的选择变化
- 处理删除按钮点击

---

## 进度计算逻辑

### 阶段基础百分比

```javascript
function phaseBasePercent(phase) {
  if (phase === "queued") return 1;
  if (phase === "initializing") return 5;
  if (phase === "resolving-links") return 10;
  if (phase === "indexing") return 45;
  if (phase === "running") return 80;
  if (phase === "finalizing") return 95;
  if (phase === "completed") return 100;
  return 0;
}
```

### 运行阶段进度计算

```javascript
// 如果有总行数,计算实际进度
if (estimatedTotalRows > 0) {
  const runningRatio = processedRows / estimatedTotalRows;
  percent = 35 + runningRatio * 60; // 35% 到 95%
}
```

---

## 预设规则处理

### 预设检测

当 `/api/bootstrap` 返回 preset 对象时:

1. 设置 `state.preset = preset`
2. 设置 `state.mappingLocked = true`
3. 应用预设的映射配置
4. UI 进入只读状态(下拉框和按钮禁用)

### 预设锁定效果

- 表选择下拉框禁用
- 模式选择下拉框禁用
- 所有映射下拉框禁用
- 添加/删除映射按钮禁用
- 自动映射按钮禁用
- 提示文本显示 "[プリセット適用中: 読み取り専用]"

---

## 错误处理

### API 错误

```javascript
try {
  const data = await api("/api/endpoint", options);
} catch (error) {
  showError(error.message);
  // 如果有 hint,也显示在日志中
}
```

### 验证错误

```javascript
try {
  validateMappings();
} catch (error) {
  showError(error.message);
  return;
}
```

---

## 样式类名

### 状态徽章

- `badge-idle` - 灰色(待機中)
- `badge-running` - 蓝色(実行中)
- `badge-success` - 绿色(完了)
- `badge-failed` - 红色(失敗)

### 进度条

- `progress-bar` - 正常进度条
- `progress-bar.indeterminate` - 不确定进度(动画效果)

### 警告框

- `alert.error` - 错误提示(红色)
- `alert.info` - 信息提示(蓝色)
- `alert.hidden` - 隐藏状态

---

## 数据流

### 登录流程

```
用户点击登录
  ↓
startLogin()
  ↓
打开 OAuth 弹窗
  ↓
用户完成授权
  ↓
handleAuthMessage()
  ↓
保存 authSessionId
  ↓
更新登录状态
```

### 同步流程

```
用户上传 CSV
  ↓
uploadCsv()
  ↓
保存 uploadId
  ↓
tryAutoLoadSchema()
  ↓
loadSchema()
  ↓
显示表和字段信息
  ↓
用户配置映射
  ↓
用户点击开始同步
  ↓
startSync()
  ↓
调用 /api/start
  ↓
开始轮询 pollJob()
  ↓
更新进度显示
  ↓
同步完成
  ↓
显示结果和错误日志下载
```

---

## 性能优化

1. **DOM 元素缓存** - 所有元素引用存储在 `el` 对象中
2. **事件委托** - 映射列表使用事件委托处理动态元素
3. **轮询间隔** - 1.8 秒轮询一次,避免过于频繁
4. **条件渲染** - 只在需要时重新渲染映射列表
5. **状态管理** - 集中的 state 对象管理所有状态

---

## 安全措施

1. **HTML 转义** - 使用 escapeHtml() 防止 XSS
2. **消息验证** - OAuth 回调验证消息类型
3. **输入验证** - 映射配置验证
4. **错误处理** - 所有 API 调用都有错误处理

---

## 国际化

所有用户可见文本均为日文:

- 按钮标签
- 状态提示
- 错误消息
- 进度阶段
- 字段类型标签

---

## 总结

`app.js` 是一个功能完整的单页应用前端,使用纯原生 JavaScript 实现,无框架依赖。代码结构清晰,功能模块化,易于维护和扩展。主要特点:

1. **IIFE 封装** - 避免全局变量污染
2. **状态管理** - 集中的 state 对象
3. **事件驱动** - 基于事件监听器的交互
4. **实时反馈** - 进度条和状态更新
5. **错误处理** - 完善的错误提示机制
6. **预设支持** - 自动化业务规则
7. **响应式 UI** - 根据状态动态更新界面
