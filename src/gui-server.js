#!/usr/bin/env node

/**
 * GUI 服务器模块
 * 
 * 提供基于 Web 的图形界面,用于管理 Lark CSV 同步任务
 * 
 * 主要功能:
 * - OAuth 用户认证
 * - CSV 文件上传和解析
 * - 字段映射配置
 * - 同步任务管理
 * - 进度监控和错误报告
 * 
 * 支持两种运行模式:
 * 1. 独立 Web 服务器模式(node gui-server.js)
 * 2. 嵌入式模式(被 desktop-main.js 调用)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const open = require('open');
const dotenv = require('dotenv');
const { LarkApiClient } = require('./lark-api');
const { readCsvHeaders, normalizeEncoding } = require('./csv-stream');
const { resolveCheckpointPath } = require('./checkpoint');
const { runSync } = require('./sync-engine');
const { detectSyncPreset, findTableByName } = require('./sync-presets');
const { getTimestamp } = require('./logger');

dotenv.config();

// ============================================================================
// 服务器配置常量
// ============================================================================

/** 服务器监听地址(仅本地访问) */
const HOST = '127.0.0.1';

/** 默认端口号(可通过 GUI_PORT 环境变量覆盖) */
const PORT = Number(process.env.GUI_PORT || 3900);

/** 是否严格使用指定端口(如果端口被占用则报错,而不是自动尝试下一个端口) */
const STRICT_PORT = process.env.GUI_PORT_STRICT === '1' || Boolean(process.env.GUI_PORT);

/** 应用根目录(项目根目录) */
const APP_ROOT_DIR = path.resolve(__dirname, '..');

/** 数据根目录(存储上传文件、报告、配置等,可通过 LARK_SYNC_DATA_DIR 环境变量自定义) */
const DATA_ROOT_DIR = path.resolve(process.env.LARK_SYNC_DATA_DIR || APP_ROOT_DIR);

/** 静态文件目录(HTML/CSS/JS 前端资源) */
const PUBLIC_DIR = path.resolve(APP_ROOT_DIR, 'public');

/** 临时上传目录(存储用户上传的 CSV 文件) */
const TEMP_DIR = path.resolve(DATA_ROOT_DIR, '.tmp_uploads');

/** 报告目录(存储同步结果报告和错误 CSV) */
const REPORT_DIR = path.resolve(DATA_ROOT_DIR, 'reports');

/** GUI 配置文件路径(保存用户的 App ID、Secret 等设置) */
const SETTINGS_FILE = path.resolve(DATA_ROOT_DIR, 'gui-settings.json');

// 确保必要的目录存在
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });

// ============================================================================
// 内存状态管理
// ============================================================================

/** 上传文件缓存 Map<uploadId, {id, path, originalName, size, createdAt}> */
const uploads = new Map();

/** 同步任务缓存 Map<jobId, {id, status, phase, message, stats, ...}> */
const jobs = new Map();

/** 待处理的 OAuth 认证请求 Map<state, {state, appId, appSecret, apiBase, createdAt}> */
const pendingAuth = new Map();

/** 已认证的用户会话 Map<sessionId, {id, userAccessToken, refreshToken, ...}> */
const authSessions = new Map();

/** 当前实际使用的端口号 */
let activePort = PORT;

/** 当前运行的 HTTP 服务器实例 */
let runningServer = null;

// ============================================================================
// Express 应用初始化
// ============================================================================

const app = express();

/** Multer 文件上传中间件配置 */
const upload = multer({
  dest: TEMP_DIR,
  limits: {
    fileSize: 1024 * 1024 * 1024, // 1GB 文件大小限制
  },
});

// 禁用 X-Powered-By 响应头(安全考虑)
app.disable('x-powered-by');

// 解析 JSON 请求体(最大 4MB)
app.use(express.json({ limit: '4mb' }));

// 解析 URL 编码的请求体
app.use(express.urlencoded({ extended: true }));

// 提供静态文件服务(前端 HTML/CSS/JS)
app.use(express.static(PUBLIC_DIR));

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 标准化文本:转为字符串、去除首尾空格、转小写
 * @param {any} value - 输入值
 * @returns {string} - 标准化后的字符串
 */
function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * 将错误对象转换为字符串消息
 * @param {Error|any} error - 错误对象
 * @returns {string} - 错误消息字符串
 */
function toErrorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 安全地序列化 JSON 用于嵌入 HTML <script> 标签
 * 转义 < 字符防止 XSS 攻击
 * @param {any} value - 要序列化的值
 * @returns {string} - 安全的 JSON 字符串
 */
function safeJsonForScript(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * 解析 ISO 时间字符串为 Unix 时间戳
 * @param {string} value - ISO 时间字符串
 * @returns {number} - Unix 时间戳(毫秒),解析失败返回 0
 */
function parseIsoTime(value) {
  const t = Date.parse(String(value || ''));
  return Number.isFinite(t) ? t : 0;
}

/**
 * 断言域名为国际版 Lark(larksuite.com)
 * 拒绝中国版飞书(feishu.cn)域名
 * 
 * @param {string} host - 主机名
 * @param {string} label - 标签(用于错误提示)
 * @throws {Error} - 如果域名无效或为中国版
 */
function assertInternationalDomain(host, label) {
  const normalized = normalizeText(host);
  
  // 检查主机名是否为空
  if (!normalized) {
    throw new Error(`${label} が空です`);
  }
  
  // 拒绝中国版飞书域名
  if (normalized.includes('feishu.cn')) {
    throw new Error(`${label} は中国版 feishu.cn です。国際版 larksuite.com を使用してください`);
  }
  
  // 要求使用国际版 Lark 域名
  if (!normalized.includes('larksuite.com')) {
    throw new Error(`${label} は国際版 larksuite.com ドメインを使用してください`);
  }
}

/**
 * 标准化 API 基础地址
 * 验证并格式化 OpenAPI 基础 URL
 * 
 * @param {string} input - 输入的 API 基础地址
 * @returns {string} - 标准化后的 URL(格式:protocol://host)
 * @throws {Error} - 如果 URL 格式无效或域名不符合要求
 */
function normalizeApiBase(input) {
  const raw = String(input || '').trim();
  
  // 检查是否为空
  if (!raw) throw new Error('OpenAPI Base が空です');
  
  let parsed;
  try {
    // 解析 URL
    parsed = new URL(raw);
  } catch (error) {
    throw new Error(`OpenAPI Base の形式が不正です: ${error.message}`);
  }
  
  // 验证域名
  assertInternationalDomain(parsed.hostname, 'OpenAPI Base');
  
  // 返回标准化的 URL(只包含协议和主机)
  return `${parsed.protocol}//${parsed.host}`;
}

/**
 * 构建错误提示信息
 * 根据错误消息内容提供友好的提示
 * 
 * @param {string} message - 错误消息
 * @returns {string} - 提示信息,如果没有匹配的提示则返回空字符串
 */
function buildHint(message) {
  // HTTP 403 或错误码 91403:权限不足
  if (message.includes('HTTP 403') || message.includes('code 91403')) {
    return '権限不足です。ログイン中ユーザーに対象Base閲覧権限があるか、アプリにBitable権限があるかを確認してください。';
  }
  
  // 中国版飞书域名错误
  if (message.includes('feishu.cn')) {
    return '中国版 feishu ではなく、国際版 Lark（larksuite.com）を使用してください。';
  }
  
  // 没有匹配的提示
  return '';
}

/**
 * 将错误转换为 API 响应格式
 * 
 * @param {Error|any} error - 错误对象
 * @returns {Object} - API 错误响应对象 { ok: false, error, hint }
 */
function toApiError(error) {
  const message = toErrorMessage(error);
  const hint = buildHint(message);
  return {
    ok: false,
    error: message,
    hint,
  };
}

/**
 * 从环境变量获取默认配置
 * 
 * @returns {Object} 默认配置对象
 * @returns {string} .appId - Lark 应用 ID
 * @returns {string} .appSecret - Lark 应用密钥
 * @returns {string} .apiBase - OpenAPI 基础地址
 * @returns {string} .baseUrl - Base 表格 URL
 */
function getEnvDefaults() {
  return {
    appId: String(process.env.LARK_APP_ID || '').trim(),
    appSecret: String(process.env.LARK_APP_SECRET || '').trim(),
    apiBase: String(process.env.LARK_OPENAPI_BASE || 'https://open.larksuite.com').trim(),
    baseUrl: String(process.env.LARK_BASE_URL || '').trim(),
  };
}

/**
 * 从磁盘加载已保存的配置
 * 
 * @returns {Object|null} 配置对象,如果文件不存在或解析失败则返回 null
 * @returns {string} .appId - Lark 应用 ID
 * @returns {string} .appSecret - Lark 应用密钥
 * @returns {string} .apiBase - OpenAPI 基础地址
 * @returns {string} .baseUrl - Base 表格 URL
 * @returns {string} .updatedAt - 最后更新时间(ISO 格式)
 */
function loadSavedSettings() {
  if (!fs.existsSync(SETTINGS_FILE)) return null;
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      appId: String(parsed.appId || '').trim(),
      appSecret: String(parsed.appSecret || '').trim(),
      apiBase: String(parsed.apiBase || '').trim(),
      baseUrl: String(parsed.baseUrl || '').trim(),
      updatedAt: String(parsed.updatedAt || '').trim(),
    };
  } catch {
    return null;
  }
}

/**
 * 合并环境变量默认值和已保存的配置
 * 优先使用已保存的配置,如果不存在则使用环境变量
 * 
 * @returns {Object} 合并后的配置
 * @returns {boolean} .hasSavedConfig - 是否存在已保存的配置
 * @returns {Object} .config - 配置对象
 * @returns {string} .config.appId - Lark 应用 ID
 * @returns {string} .config.appSecret - Lark 应用密钥
 * @returns {string} .config.apiBase - OpenAPI 基础地址
 * @returns {string} .config.baseUrl - Base 表格 URL
 */
function mergeDefaultsWithSaved() {
  const envDefaults = getEnvDefaults();
  const saved = loadSavedSettings();
  return {
    hasSavedConfig: Boolean(saved),
    config: {
      appId: saved && saved.appId ? saved.appId : envDefaults.appId,
      appSecret: saved && saved.appSecret ? saved.appSecret : envDefaults.appSecret,
      apiBase: saved && saved.apiBase ? saved.apiBase : envDefaults.apiBase,
      baseUrl: saved && saved.baseUrl ? saved.baseUrl : envDefaults.baseUrl,
    },
  };
}

/**
 * 标准化并验证配置参数
 * 
 * @param {Object} body - 请求体对象
 * @returns {Object} 标准化后的配置对象
 * @returns {string} .appId - Lark 应用 ID
 * @returns {string} .appSecret - Lark 应用密钥
 * @returns {string} .apiBase - OpenAPI 基础地址
 * @returns {string} .baseUrl - Base 表格 URL
 * @returns {string} .updatedAt - 更新时间(ISO 格式)
 * @throws {Error} 如果必填字段缺失或格式无效
 */
function normalizeSettingsPayload(body) {
  const appId = String((body && body.appId) || '').trim();
  const appSecret = String((body && body.appSecret) || '').trim();
  const apiBaseRaw = String((body && body.apiBase) || '').trim();
  const baseUrl = String((body && body.baseUrl) || '').trim();

  if (!appId) throw new Error('App ID is required');
  if (!appSecret) throw new Error('App Secret is required');

  const apiBase = normalizeApiBase(apiBaseRaw || 'https://open.larksuite.com');
  if (baseUrl) {
    parseBaseTableUrl(baseUrl);
  }

  return {
    appId,
    appSecret,
    apiBase,
    baseUrl,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * 将配置保存到磁盘
 * 
 * @param {Object} settings - 配置对象
 */
function saveSettingsToDisk(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
}

/**
 * 解析 Lark Base 表格 URL
 * 从 URL 中提取 appToken 和 tableId
 * 
 * @param {string} input - Base 表格 URL
 * @returns {Object} 解析结果
 * @returns {string} .appToken - Base 应用 token(bas 开头)
 * @returns {string} .tableId - 表格 ID(tbl 开头,可能为空)
 * @returns {string} .sourceUrl - 原始 URL
 * @throws {Error} 如果 URL 格式无效或无法提取 appToken
 * 
 * @example
 * parseBaseTableUrl('https://example.larksuite.com/base/bas123?table=tbl456')
 * // => { appToken: 'bas123', tableId: 'tbl456', sourceUrl: '...' }
 */
function parseBaseTableUrl(input) {
  const value = String(input || '').trim();
  if (!value) {
    throw new Error('Base URL が空です');
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error(`Base URL の形式が不正です: ${error.message}`);
  }

  assertInternationalDomain(parsed.hostname, 'Base URL');

  const pathname = parsed.pathname || '';
  const segments = pathname.split('/').filter(Boolean);
  let appToken = '';
  const baseIndex = segments.findIndex((item) => item.toLowerCase() === 'base');
  if (baseIndex >= 0 && segments[baseIndex + 1]) {
    appToken = segments[baseIndex + 1];
  }
  if (!appToken) {
    const match = pathname.match(/(bas[a-z0-9]+)/i);
    if (match) appToken = match[1];
  }
  if (!appToken) {
    throw new Error('URL から app token (bas...) を取得できません');
  }

  const tableIdFromQuery = parsed.searchParams.get('table') || parsed.searchParams.get('table_id');
  let tableId = tableIdFromQuery || '';
  if (!tableId) {
    const tableMatch = pathname.match(/(tbl[a-z0-9]+)/i);
    if (tableMatch) tableId = tableMatch[1];
  }

  return {
    appToken,
    tableId,
    sourceUrl: value,
  };
}

/**
 * 解析并验证同步模式
 * 
 * @param {string} input - 模式字符串
 * @returns {string} 标准化的模式('insert'|'update'|'upsert'|'empty')
 * @throws {Error} 如果模式无效
 */
function parseMode(input) {
  const mode = String(input || '').trim().toLowerCase();
  if (!['insert', 'update', 'upsert', 'empty'].includes(mode)) {
    throw new Error('mode は insert / update / upsert / empty から選択してください');
  }
  return mode;
}

/**
 * 限制批处理大小在有效范围内
 * 
 * @param {number|string} input - 批处理大小
 * @returns {number} 限制后的值(1-500 之间)
 */
function clampBatchSize(input) {
  const value = Number.parseInt(String(input || '500'), 10);
  if (!Number.isFinite(value)) return 500;
  if (value < 1) return 1;
  if (value > 500) return 500;
  return value;
}

/**
 * 解析字段映射文本
 * 支持多种分隔符: =>, =, :
 * 支持换行符或逗号分隔多个映射
 * 
 * @param {string} input - 映射文本
 * @returns {Array<{csvColumn: string, fieldName: string}>} 映射数组
 * @throws {Error} 如果映射格式无效
 * 
 * @example
 * parseMappingText('名前=>name\nメール=>email')
 * // => [{ csvColumn: '名前', fieldName: 'name' }, { csvColumn: 'メール', fieldName: 'email' }]
 */
function parseMappingText(input) {
  const raw = String(input || '').trim();
  if (!raw) return [];

  return raw
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((pair) => {
      let separator = '';
      if (pair.includes('=>')) separator = '=>';
      else if (pair.includes('=')) separator = '=';
      else if (pair.includes(':')) separator = ':';

      if (!separator) {
        throw new Error(`マッピング形式が不正です: ${pair}`);
      }

      const [left, right] = pair.split(separator);
      const csvColumn = String(left || '').trim();
      const fieldName = String(right || '').trim();
      if (!csvColumn || !fieldName) {
        throw new Error(`マッピング形式が不正です: ${pair}`);
      }

      return { csvColumn, fieldName };
    });
}

/**
 * 构建名称映射表(不区分大小写)
 * 
 * @param {Array<string>} items - 名称数组
 * @returns {Map<string, string>} 标准化名称到原始名称的映射
 */
function buildNameMap(items) {
  const map = new Map();
  items.forEach((item) => {
    const key = normalizeText(item);
    if (!key || map.has(key)) return;
    map.set(key, item);
  });
  return map;
}

/**
 * 统计字符串中的日文字符数量
 * 用于检测文件名编码问题
 * 
 * @param {string} value - 输入字符串
 * @returns {number} 日文字符数量
 */
function countJapaneseChars(value) {
  const source = String(value || '');
  const matched = source.match(/[\u3040-\u30ff\u3400-\u9fff]/g);
  return matched ? matched.length : 0;
}

/**
 * 标准化上传文件名
 * 尝试修复 Latin-1 编码的日文文件名
 * 
 * @param {string} fileName - 原始文件名
 * @returns {string} 标准化后的文件名
 */
function normalizeUploadFileName(fileName) {
  const raw = String(fileName || '').trim();
  if (!raw) return 'uploaded.csv';

  try {
    const decoded = Buffer.from(raw, 'latin1').toString('utf8');
    const rawJapanese = countJapaneseChars(raw);
    const decodedJapanese = countJapaneseChars(decoded);
    if (decodedJapanese > rawJapanese) return decoded;
  } catch {
    // ignore and fallback to raw name
  }

  return raw;
}

/**
 * 标准化并验证字段映射
 * 确保 CSV 列和表格字段都存在,且不重复
 * 
 * @param {Array<{csvColumn: string, fieldName: string}>} mappings - 原始映射数组
 * @param {Array<string>} csvHeaders - CSV 表头数组
 * @param {Array<string>} fieldNames - 表格字段名数组
 * @param {string} label - 标签(用于错误提示)
 * @returns {Array<{csvColumn: string, fieldName: string}>} 标准化后的映射数组
 * @throws {Error} 如果列名不存在或有重复
 */
function normalizeMappings(mappings, csvHeaders, fieldNames, label) {
  const csvByName = buildNameMap(csvHeaders);
  const fieldByName = buildNameMap(fieldNames);
  const seenFields = new Set();
  const normalized = [];

  for (const mapping of mappings) {
    const csvColumn = csvByName.get(normalizeText(mapping.csvColumn));
    const fieldName = fieldByName.get(normalizeText(mapping.fieldName));
    if (!csvColumn) {
      throw new Error(`${label}: CSV列が見つかりません -> ${mapping.csvColumn}`);
    }
    if (!fieldName) {
      throw new Error(`${label}: テーブル列が見つかりません -> ${mapping.fieldName}`);
    }
    const fieldKey = normalizeText(fieldName);
    if (seenFields.has(fieldKey)) {
      throw new Error(`${label}: 重複するテーブル列があります -> ${fieldName}`);
    }
    seenFields.add(fieldKey);
    normalized.push({ csvColumn, fieldName });
  }

  return normalized;
}

/**
 * 判断字段是否可以自动映射
 * 排除只读字段和链接字段
 * 
 * @param {Object} meta - 字段元数据
 * @returns {boolean} 是否可以自动映射
 */
function isAutoMappableFieldMeta(meta) {
  if (!meta || !meta.field_name) return false;
  const type = Number(meta.type);
  const blockedTypes = new Set([
    17, // attachment 附件
    18, // single link 单向链接
    20, // formula 公式
    21, // duplex link 双向链接
    1001, // created time 创建时间
    1002, // modified time 修改时间
    1003, // created user 创建者
    1004, // modified user 修改者
  ]);
  if (blockedTypes.has(type)) return false;

  const property = meta.property;
  if (property && typeof property === 'object') {
    if (property.table_id || property.tableId) return false; // any link-like field 任何链接类字段
  }
  return true;
}

/**
 * 根据 CSV 表头和表格字段自动构建映射
 * 按名称匹配(不区分大小写),每个字段只映射一次
 * 
 * @param {Array<string>} csvHeaders - CSV 表头数组
 * @param {Array<Object>} fieldMetas - 表格字段元数据数组
 * @returns {Array<{csvColumn: string, fieldName: string}>} 自动生成的映射数组
 */
function buildAutoMappings(csvHeaders, fieldMetas) {
  const autoFieldNames = (fieldMetas || [])
    .filter((meta) => isAutoMappableFieldMeta(meta))
    .map((meta) => meta.field_name)
    .filter(Boolean);
  const fieldByName = buildNameMap(autoFieldNames);
  const usedFields = new Set();
  const mappings = [];

  csvHeaders.forEach((csvColumn) => {
    const fieldName = fieldByName.get(normalizeText(csvColumn));
    if (!fieldName) return;
    const fieldKey = normalizeText(fieldName);
    if (usedFields.has(fieldKey)) return;
    usedFields.add(fieldKey);
    mappings.push({ csvColumn, fieldName });
  });

  return mappings;
}

/**
 * 选择要同步的表格
 * 优先使用请求体中的 tableId,其次使用 URL 中的 tableId,最后使用第一个表格
 * 
 * @param {Array<Object>} tables - 表格列表
 * @param {string} tableIdFromBody - 请求体中的表格 ID
 * @param {string} tableIdFromUrl - URL 中的表格 ID
 * @returns {Object} 选中的表格对象
 * @throws {Error} 如果 Base 中没有表格
 */
function selectTable(tables, tableIdFromBody, tableIdFromUrl) {
  if (!Array.isArray(tables) || tables.length === 0) {
    throw new Error('Base 内にテーブルがありません');
  }
  const candidate = tableIdFromBody || tableIdFromUrl || '';
  if (candidate) {
    const matched = tables.find((item) => item.table_id === candidate);
    if (matched) return matched;
  }
  return tables[0];
}

/**
 * 根据预设配置选择表格
 * 
 * @param {Array<Object>} tables - 表格列表
 * @param {Object|null} preset - 预设配置对象
 * @returns {Object|null} 匹配的表格对象,如果没有预设或未找到则返回 null
 * @throws {Error} 如果预设指定的表格不存在
 */
function selectPresetTableOrThrow(tables, preset) {
  if (!preset) return null;
  const matched = findTableByName(tables, preset.tableName);
  if (matched) return matched;
  throw new Error(
    `Preset table not found in Base: ${preset.tableName} (file=${preset.fileName || 'unknown'})`
  );
}

/**
 * 获取上传文件信息
 * 
 * @param {string} uploadId - 上传 ID
 * @returns {Object} 上传文件信息对象
 * @throws {Error} 如果文件未上传或已被删除
 */
function getUpload(uploadId) {
  const item = uploads.get(uploadId);
  if (!item) {
    throw new Error('CSVファイルが未アップロードです');
  }
  if (!fs.existsSync(item.path)) {
    uploads.delete(uploadId);
    throw new Error('アップロード済みCSVが見つかりません。再アップロードしてください');
  }
  return item;
}

/**
 * 创建应用级别的 Lark API 客户端
 * 
 * @param {string} appId - 应用 ID
 * @param {string} appSecret - 应用密钥
 * @param {string} apiBase - API 基础地址
 * @returns {LarkApiClient} API 客户端实例
 * @throws {Error} 如果 appId 或 appSecret 为空
 */
function createAppClient(appId, appSecret, apiBase) {
  const appIdValue = String(appId || '').trim();
  const appSecretValue = String(appSecret || '').trim();
  const base = normalizeApiBase(apiBase || process.env.LARK_OPENAPI_BASE || 'https://open.larksuite.com');
  if (!appIdValue || !appSecretValue) {
    throw new Error('App ID / App Secret は必須です');
  }
  return new LarkApiClient({
    appId: appIdValue,
    appSecret: appSecretValue,
    baseUrl: base,
  });
}

/**
 * 将 OAuth token 响应数据应用到会话对象
 * 更新 access token、refresh token 和过期时间
 * 
 * @param {Object} session - 会话对象
 * @param {Object} tokenData - token 响应数据
 * @throws {Error} 如果无法获取 user_access_token
 */
function applyUserTokenPayload(session, tokenData) {
  const accessToken = tokenData.access_token || tokenData.user_access_token || '';
  const refreshToken = tokenData.refresh_token || '';
  if (!accessToken) {
    throw new Error('user_access_token の取得に失敗しました');
  }
  session.userAccessToken = accessToken;
  if (refreshToken) {
    session.refreshToken = refreshToken;
  }

  const expiresIn = Number(tokenData.expires_in || tokenData.expires || 7200);
  const refreshExpiresIn = Number(
    tokenData.refresh_expires_in || tokenData.refresh_token_expires_in || 2592000
  );
  session.accessExpireAt = Date.now() + expiresIn * 1000;
  session.refreshExpireAt = Date.now() + refreshExpiresIn * 1000;
  session.updatedAt = new Date().toISOString();
}

/**
 * 确保用户 access token 有效
 * 如果 token 即将过期(60秒内),则使用 refresh token 刷新
 * 
 * @param {Object} session - 会话对象
 * @param {boolean} forceRefresh - 是否强制刷新
 * @returns {Promise<string>} 有效的 user access token
 * @throws {Error} 如果会话无效或刷新失败
 */
async function ensureUserAccessToken(session, forceRefresh = false) {
  if (!session) throw new Error('ログインセッションがありません');
  const now = Date.now();
  if (
    !forceRefresh &&
    session.userAccessToken &&
    session.accessExpireAt &&
    now < session.accessExpireAt - 60 * 1000
  ) {
    return session.userAccessToken;
  }

  if (!session.refreshToken) {
    throw new Error('refresh_token がありません。再ログインしてください');
  }

  const appClient = createAppClient(session.appId, session.appSecret, session.apiBase);
  const refreshed = await appClient.refreshUserAccessToken(session.refreshToken);
  applyUserTokenPayload(session, refreshed);
  authSessions.set(session.id, session);
  return session.userAccessToken;
}

/**
 * 获取认证会话
 * 
 * @param {string} sessionId - 会话 ID
 * @returns {Object} 会话对象
 * @throws {Error} 如果会话 ID 为空或会话不存在
 */
function getAuthSession(sessionId) {
  const id = String(sessionId || '').trim();
  if (!id) throw new Error('ログインセッションIDがありません');
  const session = authSessions.get(id);
  if (!session) {
    throw new Error('ログインセッションが無効です。再ログインしてください');
  }
  return session;
}

/**
 * 创建用户级别的 Lark API 客户端
 * 使用用户 access token 进行 API 调用
 * 
 * @param {Object} session - 会话对象
 * @returns {LarkApiClient} API 客户端实例
 */
function createUserClient(session) {
  return new LarkApiClient({
    appId: session.appId,
    appSecret: session.appSecret,
    baseUrl: session.apiBase,
    accessTokenProvider: async (forceRefresh) => ensureUserAccessToken(session, forceRefresh),
  });
}

/**
 * 安全地复制统计信息
 * 只保留必要的字段,避免暴露敏感数据
 * 
 * @param {Object} stats - 统计信息对象
 * @returns {Object|null} 安全的统计信息副本
 */
function safeStats(stats) {
  if (!stats) return null;
  const copy = { ...stats };
  if (copy.failures) {
    copy.failures = copy.failures.map((f) => ({ rowNumber: f.rowNumber, reason: f.reason }));
  }
  return copy;
}

/**
 * 转义 CSV 单元格内容
 * 如果包含特殊字符(引号、逗号、换行),则用双引号包裹并转义内部引号
 * 
 * @param {any} value - 单元格值
 * @returns {string} 转义后的字符串
 */
function escapeCsvCell(value) {
  const str = String(value == null ? '' : value);
  if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

/**
 * 格式化时间戳为文件名友好的字符串
 * 格式: YYYYMMDDHHmmss
 * 
 * @param {Date} date - 日期对象
 * @returns {string} 格式化后的时间戳字符串
 */
function formatTimestamp(date) {
  return (
    date.getFullYear().toString() +
    String(date.getMonth() + 1).padStart(2, '0') +
    String(date.getDate()).padStart(2, '0') +
    String(date.getHours()).padStart(2, '0') +
    String(date.getMinutes()).padStart(2, '0') +
    String(date.getSeconds()).padStart(2, '0')
  );
}

/**
 * 生成错误 CSV 文件
 * 将同步失败的行导出为 CSV 文件,包含原始数据和错误原因
 * 
 * @param {Object} stats - 同步统计信息
 * @param {string} csvOriginalName - 原始 CSV 文件名
 * @returns {Object|null} 错误 CSV 文件信息,如果没有错误则返回 null
 * @returns {string} .filePath - 文件完整路径
 * @returns {string} .fileName - 文件名
 */
function buildErrorCsv(stats, csvOriginalName) {
  if (!stats || !Array.isArray(stats.failures)) return null;
  const failedWithData = stats.failures.filter((f) => f.rowData && typeof f.rowData === 'object');
  if (failedWithData.length === 0) return null;

  const columnSet = new Set();
  failedWithData.forEach((f) => {
    Object.keys(f.rowData).forEach((key) => columnSet.add(key));
  });
  const csvColumns = Array.from(columnSet);
  const allColumns = [...csvColumns, 'error'];

  const headerLine = allColumns.map((col) => escapeCsvCell(col)).join(',');
  const dataLines = failedWithData.map((f) => {
    const cells = csvColumns.map((col) => escapeCsvCell(f.rowData[col]));
    cells.push(escapeCsvCell(f.reason || ''));
    return cells.join(',');
  });

  const csvContent = '\uFEFF' + [headerLine, ...dataLines].join('\r\n');
  const baseName = String(csvOriginalName || 'data').replace(/\.csv$/i, '');
  const timestamp = formatTimestamp(new Date());
  const fileName = `${baseName}_error_${timestamp}.csv`;

  const filePath = path.resolve(REPORT_DIR, fileName);
  fs.writeFileSync(filePath, csvContent, 'utf8');
  return { filePath, fileName };
}

/**
 * 创建新的同步任务
 * 
 * @returns {Object} 新创建的任务对象
 */
function newJob() {
  const id = crypto.randomUUID();
  const job = {
    id,
    status: 'queued',
    phase: 'queued',
    message: '待機中',
    createdAt: new Date().toISOString(),
    startedAt: '',
    endedAt: '',
    stats: null,
    error: '',
    hint: '',
    reportPath: '',
    errorCsvPath: '',
    errorCsvFileName: '',
    logs: [],
  };
  jobs.set(id, job);
  return job;
}

/**
 * 更新任务状态
 * 
 * @param {string} jobId - 任务 ID
 * @param {Object} patch - 要更新的字段
 */
function updateJob(jobId, patch) {
  const current = jobs.get(jobId);
  if (!current) return;
  jobs.set(jobId, { ...current, ...patch });
}

/**
 * 生成 OAuth 回调页面 HTML
 * 用于显示登录结果并通过 postMessage 通知父窗口
 * 
 * @param {Object} payload - 回调数据
 * @param {string} payload.type - 回调类型('lark-auth-success'|'lark-auth-failed')
 * @param {string} [payload.error] - 错误消息(失败时)
 * @param {string} [payload.sessionId] - 会话 ID(成功时)
 * @param {string} [payload.userName] - 用户名(成功时)
 * @returns {string} HTML 字符串
 */
function authCallbackHtml(payload) {
  const title = payload.type === 'lark-auth-success' ? 'ログイン完了' : 'ログイン失敗';
  const detail = payload.error ? String(payload.error) : '';
  const serialized = safeJsonForScript(payload);
  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<title>Lark Login</title>
<style>
body{font-family:system-ui,Segoe UI,sans-serif;padding:24px;background:#f5f7fa;color:#1f2d33}
.box{max-width:520px;margin:20px auto;background:#fff;border-radius:12px;padding:20px;border:1px solid #d9e3ea}
h1{font-size:18px;margin:0 0 8px}p{margin:0;font-size:14px;color:#5a6a73}
code{display:block;margin-top:12px;padding:10px;border-radius:8px;background:#f2f4f7;color:#ad2d2d;font-size:12px;white-space:pre-wrap;word-break:break-word}
</style>
</head>
<body>
<div class="box">
<h1>${title}</h1>
<p>このウィンドウは自動で閉じます。</p>
${detail ? `<code>${detail}</code>` : ''}
</div>
<script>
  const data = ${serialized};
  if (window.opener) {
    window.opener.postMessage(data, '*');
  }
  setTimeout(() => window.close(), 1200);
</script>
</body>
</html>`;
}

/**
 * 解析待处理的 OAuth 认证请求
 * 优先使用 state 参数匹配,如果失败则尝试查找最近的单个请求
 * 
 * @param {string} stateParam - OAuth state 参数
 * @returns {Object|null} 待处理的认证请求对象,如果未找到则返回 null
 */
function resolvePendingAuth(stateParam) {
  const state = String(stateParam || '').trim();
  if (state && pendingAuth.has(state)) {
    return pendingAuth.get(state);
  }

  const now = Date.now();
  const candidates = Array.from(pendingAuth.entries())
    .map(([key, value]) => ({ key, value, createdAt: parseIsoTime(value.createdAt) }))
    .filter((item) => item.createdAt > 0 && now - item.createdAt <= 15 * 60 * 1000)
    .sort((a, b) => b.createdAt - a.createdAt);

  if (candidates.length === 1) {
    return candidates[0].value;
  }
  return null;
}

/**
 * 从待处理列表中移除认证请求
 * 
 * @param {Object} pending - 待处理的认证请求对象
 */
function removePendingAuth(pending) {
  if (!pending) return;
  const key = String(pending.state || '').trim();
  if (key) {
    pendingAuth.delete(key);
    return;
  }
  for (const [stateKey, value] of pendingAuth.entries()) {
    if (value === pending) {
      pendingAuth.delete(stateKey);
      break;
    }
  }
}

// ============================================================================
// API 端点
// ============================================================================

/**
 * GET /api/defaults
 * 获取默认配置
 * 合并环境变量和已保存的配置
 */
app.get('/api/defaults', (req, res) => {
  const merged = mergeDefaultsWithSaved();
  res.json({
    ok: true,
    data: {
      appId: merged.config.appId,
      appSecret: merged.config.appSecret,
      apiBase: merged.config.apiBase,
      baseUrl: merged.config.baseUrl,
      hasSavedConfig: merged.hasSavedConfig,
      mode: 'upsert',
      encoding: 'utf8',
      batchSize: 500,
    },
  });
});

/**
 * POST /api/settings
 * 保存配置
 * 验证并保存 App ID、Secret、API Base、Base URL
 */
app.post('/api/settings', (req, res) => {
  try {
    const settings = normalizeSettingsPayload(req.body || {});
    saveSettingsToDisk(settings);
    res.json({
      ok: true,
      data: {
        appId: settings.appId,
        appSecret: settings.appSecret,
        apiBase: settings.apiBase,
        baseUrl: settings.baseUrl,
        hasSavedConfig: true,
        updatedAt: settings.updatedAt,
      },
    });
  } catch (error) {
    res.status(400).json(toApiError(error));
  }
});

/**
 * POST /api/auth/start
 * 启动 OAuth 认证流程
 * 生成授权 URL 并创建待处理的认证请求
 */
app.post('/api/auth/start', async (req, res) => {
  try {
    const appId = String(req.body.appId || '').trim();
    const appSecret = String(req.body.appSecret || '').trim();
    const apiBase = normalizeApiBase(req.body.apiBase || '');
    const appClient = createAppClient(appId, appSecret, apiBase);
    const state = crypto.randomUUID();
    const redirectUri = `http://${HOST}:${activePort}/api/auth/callback`;
    const authUrl = appClient.getUserAuthorizeUrl(redirectUri, state);

    pendingAuth.set(state, {
      state,
      appId,
      appSecret,
      apiBase,
      createdAt: new Date().toISOString(),
    });

    res.json({
      ok: true,
      data: {
        authUrl,
        state,
        redirectUri,
      },
    });
  } catch (error) {
    res.status(400).json(toApiError(error));
  }
});

/**
 * GET /api/auth/callback
 * OAuth 回调端点
 * 处理 Lark OAuth 重定向,交换 code 获取 user token
 */
app.get('/api/auth/callback', async (req, res) => {
  const state = String(req.query.state || '').trim();
  const code = String(req.query.code || '').trim();
  const errorParam = String(req.query.error || '').trim();
  const errorDesc = String(req.query.error_description || '').trim();
  const pending = resolvePendingAuth(state);

  if (!pending) {
    console.error(
      `[auth] callback failed: state not found. state="${state}", code_len=${code.length}`
    );
    res.status(400).send(
      authCallbackHtml({
        type: 'lark-auth-failed',
        error: 'state が一致しません。ログインをもう一度実行してください。',
      })
    );
    return;
  }

  if (errorParam) {
    removePendingAuth(pending);
    console.error(
      `[auth] oauth error: ${errorParam} ${errorDesc}`.trim()
    );
    res.status(400).send(
      authCallbackHtml({
        type: 'lark-auth-failed',
        error: `OAuth エラー: ${errorParam}${errorDesc ? ` (${errorDesc})` : ''}`,
      })
    );
    return;
  }

  if (!code) {
    removePendingAuth(pending);
    console.error('[auth] callback failed: authorization code missing');
    res.status(400).send(
      authCallbackHtml({
        type: 'lark-auth-failed',
        error: 'authorization code が取得できませんでした。',
      })
    );
    return;
  }

  try {
    const appClient = createAppClient(pending.appId, pending.appSecret, pending.apiBase);
    const tokenData = await appClient.exchangeAuthCodeForUserToken(code);
    const sessionId = crypto.randomUUID();
    const session = {
      id: sessionId,
      appId: pending.appId,
      appSecret: pending.appSecret,
      apiBase: pending.apiBase,
      userAccessToken: '',
      refreshToken: '',
      accessExpireAt: 0,
      refreshExpireAt: 0,
      userName: '',
      openId: '',
      unionId: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    applyUserTokenPayload(session, tokenData);

    try {
      const userInfo = await appClient.getUserInfo(session.userAccessToken);
      session.userName = userInfo.name || userInfo.en_name || '';
      session.openId = userInfo.open_id || '';
      session.unionId = userInfo.union_id || '';
    } catch {
      session.userName = '';
    }

    authSessions.set(session.id, session);
    removePendingAuth(pending);
    console.log(
      `[auth] success user="${session.userName || 'unknown'}" state="${pending.state}"`
    );

    res.send(
      authCallbackHtml({
        type: 'lark-auth-success',
        sessionId: session.id,
        userName: session.userName || 'Lark User',
      })
    );
  } catch (error) {
    removePendingAuth(pending);
    console.error(`[auth] exchange failed: ${toErrorMessage(error)}`);
    res.status(400).send(
      authCallbackHtml({
        type: 'lark-auth-failed',
        error: `ログイン処理失敗: ${toErrorMessage(error)}`,
      })
    );
  }
});

/**
 * GET /api/auth/session/:id
 * 获取会话信息
 * 验证会话是否有效并返回用户信息
 */
app.get('/api/auth/session/:id', (req, res) => {
  try {
    const session = getAuthSession(req.params.id);
    res.json({
      ok: true,
      data: {
        sessionId: session.id,
        userName: session.userName || '',
        expiresAt: session.accessExpireAt || 0,
      },
    });
  } catch (error) {
    res.status(400).json(toApiError(error));
  }
});

/**
 * POST /api/upload
 * 上传 CSV 文件
 * 使用 multer 处理文件上传,保存到临时目录
 */
app.post('/api/upload', upload.single('csvFile'), (req, res) => {
  try {
    if (!req.file) {
      throw new Error('CSVファイルを選択してください');
    }
    const originalName = normalizeUploadFileName(req.file.originalname);
    const uploadId = crypto.randomUUID();
    uploads.set(uploadId, {
      id: uploadId,
      path: req.file.path,
      originalName,
      size: req.file.size,
      createdAt: new Date().toISOString(),
    });

    res.json({
      ok: true,
      data: {
        uploadId,
        originalName,
        size: req.file.size,
      },
    });
  } catch (error) {
    res.status(400).json(toApiError(error));
  }
});

/**
 * POST /api/bootstrap
 * 初始化同步配置
 * 
 * 功能:
 * 1. 解析 Base URL 获取 appToken 和 tableId
 * 2. 获取 Base 中的所有表格
 * 3. 读取 CSV 表头
 * 4. 获取表格字段元数据
 * 5. 检测预设配置(如果文件名匹配)
 * 6. 生成自动字段映射
 * 
 * 请求参数:
 * - authSessionId: 认证会话 ID
 * - baseUrl: Base 表格 URL
 * - uploadId: 上传文件 ID
 * - encoding: CSV 编码(默认 utf8)
 * - mode: 同步模式(默认 upsert)
 * - tableId: 表格 ID(可选)
 * 
 * 返回数据:
 * - appToken: Base 应用 token
 * - tables: 表格列表
 * - selectedTableId: 选中的表格 ID
 * - selectedTableName: 选中的表格名称
 * - csvHeaders: CSV 表头数组
 * - fieldNames: 表格字段名数组
 * - fieldTypes: 字段类型映射(字段名 -> 类型标签)
 * - autoMappings: 自动生成的字段映射
 * - mode: 同步模式
 * - encoding: CSV 编码
 * - preset: 预设配置(如果检测到)
 */
app.post('/api/bootstrap', async (req, res) => {
  try {
    const session = getAuthSession(req.body.authSessionId);
    const client = createUserClient(session);
    const parsed = parseBaseTableUrl(req.body.baseUrl);
    const uploadItem = getUpload(req.body.uploadId);
    const encoding = normalizeEncoding(req.body.encoding || 'utf8');
    const detectedPreset = detectSyncPreset(uploadItem.originalName);

    const tables = await client.listTables(parsed.appToken);
    const selected =
      selectPresetTableOrThrow(tables, detectedPreset) ||
      selectTable(tables, req.body.tableId, parsed.tableId);
    const fieldMetas = await client.listFields(parsed.appToken, selected.table_id);
    const fieldNames = fieldMetas.map((item) => item.field_name).filter(Boolean);
    const fieldTypes = {};
    const TYPE_LABELS = {
      1: 'テキスト',
      2: '数値',
      3: '単一選択',
      4: '複数選択',
      5: '日時',
      7: 'チェックボックス',
      11: 'ユーザー',
      13: '電話番号',
      15: 'URL',
      17: '添付ファイル',
      18: 'リンク',
      20: '数式',
      21: '双方向リンク',
      22: '場所',
      23: '作成日時',
      24: '更新日時',
      1001: '作成者',
      1002: '更新者',
      1003: 'オートナンバー',
      1004: 'バーコード',
      1005: '自動採番',
      99003: '通貨',
      99005: '評価',
    };
    fieldMetas.forEach((item) => {
      if (item.field_name) {
        fieldTypes[item.field_name] = TYPE_LABELS[Number(item.type)] || ('type=' + item.type);
      }
    });
    const csvHeaders = await readCsvHeaders(uploadItem.path, { encoding });
    let mode = parseMode(req.body.mode || 'upsert');
    let preset = null;

    if (detectedPreset) {
      const keyMappings = normalizeMappings(
        detectedPreset.keyMappings,
        csvHeaders,
        fieldNames,
        'Preset Key mapping'
      );
      const updateMappings = normalizeMappings(
        detectedPreset.updateMappings,
        csvHeaders,
        fieldNames,
        'Preset update mapping'
      );
      const insertMappings = normalizeMappings(
        detectedPreset.insertMappings,
        csvHeaders,
        fieldNames,
        'Preset insert mapping'
      );

      mode = parseMode(detectedPreset.mode);
      preset = {
        id: detectedPreset.id,
        name: detectedPreset.name,
        fileName: detectedPreset.fileName,
        tableName: detectedPreset.tableName,
        mode,
        keyMappings,
        updateMappings,
        insertMappings,
      };
    }

    const autoMappings = preset ? preset.updateMappings : buildAutoMappings(csvHeaders, fieldMetas);

    res.json({
      ok: true,
      data: {
        appToken: parsed.appToken,
        tables: tables.map((item) => ({
          tableId: item.table_id,
          name: item.name || item.table_id,
        })),
        selectedTableId: selected.table_id,
        selectedTableName: selected.name || selected.table_id,
        csvHeaders,
        fieldNames,
        fieldTypes,
        autoMappings,
        mode,
        encoding,
        preset,
      },
    });
  } catch (error) {
    res.status(400).json(toApiError(error));
  }
});

/**
 * POST /api/start
 * 启动同步任务
 * 
 * 功能:
 * 1. 验证并解析所有参数
 * 2. 处理预设配置或用户自定义映射
 * 3. 验证映射的完整性
 * 4. 创建同步任务
 * 5. 异步执行同步操作
 * 6. 生成同步报告和错误 CSV
 * 
 * 请求参数:
 * - authSessionId: 认证会话 ID
 * - baseUrl: Base 表格 URL
 * - uploadId: 上传文件 ID
 * - mode: 同步模式(insert/update/upsert/empty)
 * - encoding: CSV 编码
 * - batchSize: 批处理大小(1-500)
 * - resumeRow: 断点续传起始行(可选)
 * - tableId: 表格 ID(可选)
 * - keyMappingText: Key 映射文本(可选)
 * - updateMappingText: 更新映射文本(可选)
 * - insertMappingText: 插入映射文本(可选)
 * - checkpointPath: 断点文件路径(可选)
 * 
 * 返回数据:
 * - jobId: 任务 ID
 * - tableId: 表格 ID
 * - tableName: 表格名称
 * - mode: 同步模式
 * - presetId: 预设 ID(如果使用预设)
 * 
 * 注意:
 * - 响应立即返回,同步操作在后台异步执行
 * - 使用 GET /api/jobs/:id 轮询任务状态
 */
app.post('/api/start', async (req, res) => {
  try {
    const session = getAuthSession(req.body.authSessionId);
    const client = createUserClient(session);
    const parsed = parseBaseTableUrl(req.body.baseUrl);
    const uploadItem = getUpload(req.body.uploadId);
    const detectedPreset = detectSyncPreset(uploadItem.originalName);
    let mode = parseMode(req.body.mode || 'upsert');
    const encoding = normalizeEncoding(req.body.encoding || 'utf8');
    const batchSize = clampBatchSize(req.body.batchSize);
    const resumeRow = Math.max(0, Number.parseInt(String(req.body.resumeRow || '0'), 10) || 0);

    const tables = await client.listTables(parsed.appToken);
    const selected =
      selectPresetTableOrThrow(tables, detectedPreset) ||
      selectTable(tables, req.body.tableId, parsed.tableId);

    const fieldMetas = await client.listFields(parsed.appToken, selected.table_id);
    const fieldNames = fieldMetas.map((item) => item.field_name).filter(Boolean);
    const csvHeaders = await readCsvHeaders(uploadItem.path, { encoding });

    const keyMappingsText = String(req.body.keyMappingText || '').trim();
    const updateMappingsText = String(req.body.updateMappingText || '').trim();
    const insertMappingsText = String(req.body.insertMappingText || '').trim();

    let keyMappings = [];
    let updateMappings = [];
    let insertMappings = [];

    if (detectedPreset) {
      mode = parseMode(detectedPreset.mode);
      keyMappings = normalizeMappings(
        detectedPreset.keyMappings,
        csvHeaders,
        fieldNames,
        'Preset Key mapping'
      );
      updateMappings = normalizeMappings(
        detectedPreset.updateMappings,
        csvHeaders,
        fieldNames,
        'Preset update mapping'
      );
      insertMappings = normalizeMappings(
        detectedPreset.insertMappings,
        csvHeaders,
        fieldNames,
        'Preset insert mapping'
      );
    } else {
      if (updateMappingsText) {
        updateMappings = normalizeMappings(
          parseMappingText(updateMappingsText),
          csvHeaders,
          fieldNames,
          '更新マッピング'
        );
      } else {
        updateMappings = buildAutoMappings(csvHeaders, fieldMetas);
      }

      if (insertMappingsText) {
        insertMappings = normalizeMappings(
          parseMappingText(insertMappingsText),
          csvHeaders,
          fieldNames,
          '追加マッピング'
        );
      } else {
        insertMappings = [...updateMappings];
      }

      if (mode !== 'insert') {
        if (keyMappingsText) {
          keyMappings = normalizeMappings(
            parseMappingText(keyMappingsText),
            csvHeaders,
            fieldNames,
            'Key マッピング'
          );
        } else {
          const fallback = updateMappings[0] || insertMappings[0];
          keyMappings = fallback ? [fallback] : [];
        }
      }
    }

    if (updateMappings.length === 0 && mode !== 'insert') {
      throw new Error('更新マッピングが空です');
    }
    if (insertMappings.length === 0 && (mode === 'insert' || mode === 'upsert')) {
      throw new Error('追加マッピングが空です');
    }
    if (mode !== 'insert') {
      if (keyMappings.length === 0) {
        throw new Error('update/upsert/empty モードでは Key マッピングが必要です');
      }
    }

    const clearEmpty = mode === 'empty';

    const checkpointPath = resolveCheckpointPath(
      req.body.checkpointPath || `.sync-checkpoint-${selected.table_id}.json`,
      DATA_ROOT_DIR
    );

    const job = newJob();
    updateJob(job.id, {
      status: 'running',
      phase: 'starting',
      message: '同期開始',
      startedAt: new Date().toISOString(),
    });

    res.json({
      ok: true,
      data: {
        jobId: job.id,
        tableId: selected.table_id,
        tableName: selected.name || selected.table_id,
        mode,
        presetId: detectedPreset ? detectedPreset.id : '',
      },
    });

    (async () => {
      try {
        const stats = await runSync({
          client,
          appToken: parsed.appToken,
          tableId: selected.table_id,
          csvPath: uploadItem.path,
          csvEncoding: encoding,
          mode,
          keyMappings,
          updateMappings,
          insertMappings,
          batchSize,
          clearEmpty,
          checkpointPath,
          resumeRow,
          onProgress: (payload) => {
            updateJob(job.id, {
              phase: payload.phase,
              message: payload.message,
              stats: safeStats(payload.stats),
            });
          },
          onLog: (msg) => {
            const j = jobs.get(job.id);
            if (j) {
              const lines = String(msg).trimEnd().split('\n');
              for (let i = 0; i < lines.length; i++) {
                j.logs.push(getTimestamp() + lines[i]);
              }
            }
          },
        });

        const reportPath = path.resolve(REPORT_DIR, `sync-report-${job.id}.json`);
        const reportStats = safeStats(stats);
        fs.writeFileSync(reportPath, JSON.stringify(reportStats, null, 2), 'utf8');

        let errorCsvPath = '';
        let errorCsvFileName = '';
        if (stats.failedRows > 0) {
          const errorResult = buildErrorCsv(stats, uploadItem.originalName);
          if (errorResult) {
            errorCsvPath = errorResult.filePath;
            errorCsvFileName = errorResult.fileName;
          }
        }

        updateJob(job.id, {
          status: 'completed',
          phase: 'completed',
          message: '同期が完了しました',
          stats: reportStats,
          endedAt: new Date().toISOString(),
          reportPath,
          errorCsvPath,
          errorCsvFileName,
        });
      } catch (error) {
        const message = toErrorMessage(error);
        updateJob(job.id, {
          status: 'failed',
          phase: 'failed',
          message: '同期に失敗しました',
          error: message,
          hint: buildHint(message),
          endedAt: new Date().toISOString(),
        });
      }
    })();
  } catch (error) {
    res.status(400).json(toApiError(error));
  }
});

/**
 * GET /api/jobs/:id
 * 获取任务状态
 * 返回任务的当前状态、进度和统计信息
 */
app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    res.status(404).json({
      ok: false,
      error: 'ジョブが見つかりません',
    });
    return;
  }
  res.json({
    ok: true,
    data: job,
  });
});

/**
 * GET /api/report/:id
 * 下载同步报告
 * 返回 JSON 格式的详细同步统计信息
 */
app.get('/api/report/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || !job.reportPath || !fs.existsSync(job.reportPath)) {
    res.status(404).json({
      ok: false,
      error: 'レポートがありません',
    });
    return;
  }
  res.download(job.reportPath, path.basename(job.reportPath));
});

/**
 * GET /api/error-csv/:id
 * 下载错误 CSV 文件
 * 包含同步失败的行和错误原因
 */
app.get('/api/error-csv/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || !job.errorCsvPath || !fs.existsSync(job.errorCsvPath)) {
    res.status(404).json({
      ok: false,
      error: 'エラーCSVがありません',
    });
    return;
  }
  res.download(job.errorCsvPath, job.errorCsvFileName || path.basename(job.errorCsvPath));
});

/**
 * GET *
 * 所有其他路由返回前端 HTML
 * 支持前端路由(SPA)
 */
app.get('*', (req, res) => {
  res.sendFile(path.resolve(PUBLIC_DIR, 'index.html'));
});

// ============================================================================
// 定时清理任务
// ============================================================================

/**
 * 每小时清理超过 24 小时的上传文件
 */
setInterval(() => {
  const now = Date.now();
  for (const [uploadId, info] of uploads.entries()) {
    const createdAt = Date.parse(info.createdAt || '');
    if (!Number.isFinite(createdAt)) continue;
    if (now - createdAt < 24 * 60 * 60 * 1000) continue;
    if (fs.existsSync(info.path)) {
      try {
        fs.unlinkSync(info.path);
      } catch {
        // ignore
      }
    }
    uploads.delete(uploadId);
  }
}, 60 * 60 * 1000);

// ============================================================================
// 服务器管理函数
// ============================================================================

/**
 * 输出信息到控制台或日志函数
 * 
 * @param {string} message - 消息内容
 * @param {Function} logger - 日志函数(可选)
 */
function writeInfo(message, logger) {
  if (typeof logger === 'function') {
    logger(message);
    return;
  }
  process.stdout.write(`${message}\n`);
}

/**
 * 关闭服务器
 * 
 * @param {Object} server - HTTP 服务器实例
 * @returns {Promise<void>}
 */
function closeServer(server = runningServer) {
  return new Promise((resolve, reject) => {
    if (!server) {
      resolve();
      return;
    }

    server.close((error) => {
      if (server === runningServer) {
        runningServer = null;
      }
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

/**
 * 启动 GUI 服务器
 * 
 * @param {Object} options - 启动选项
 * @param {number} [options.port] - 端口号
 * @param {boolean} [options.strictPort] - 是否严格使用指定端口
 * @param {boolean} [options.openBrowser] - 是否自动打开浏览器
 * @param {Function} [options.logger] - 日志函数
 * @returns {Promise<Object>} 服务器信息
 * @returns {Object} .server - HTTP 服务器实例
 * @returns {string} .host - 主机地址
 * @returns {number} .port - 实际使用的端口号
 * @returns {string} .url - 服务器 URL
 * @returns {Function} .close - 关闭服务器的函数
 */
function startServer(options = {}) {
  if (runningServer) {
    return Promise.resolve({
      server: runningServer,
      host: HOST,
      port: activePort,
      url: `http://${HOST}:${activePort}`,
      close: () => closeServer(runningServer),
    });
  }

  const preferredPort = Number(options.port || PORT);
  const strictPort =
    options.strictPort !== undefined ? Boolean(options.strictPort) : STRICT_PORT;
  const openBrowser =
    options.openBrowser !== undefined
      ? Boolean(options.openBrowser)
      : process.env.NO_OPEN_BROWSER !== '1';
  const logger = typeof options.logger === 'function' ? options.logger : null;

  return new Promise((resolve, reject) => {
    const server = app.listen(preferredPort, HOST);

    server.once('listening', () => {
      Promise.resolve()
        .then(async () => {
          const address = server.address();
          activePort =
            address && typeof address === 'object' && address.port
              ? address.port
              : preferredPort;
          runningServer = server;

          const url = `http://${HOST}:${activePort}`;
          writeInfo(`GUI server started: ${url}`, logger);

          if (openBrowser) {
            try {
              await open(url);
            } catch {
              writeInfo('Browser auto-open failed. Please open the URL manually.', logger);
            }
          }

          resolve({
            server,
            host: HOST,
            port: activePort,
            url,
            close: () => closeServer(server),
          });
        })
        .catch((error) => {
          closeServer(server).catch(() => {});
          reject(error);
        });
    });

    server.once('error', (error) => {
      if (error && error.code === 'EADDRINUSE') {
        if (strictPort) {
          reject(
            new Error(
              `Port ${preferredPort} is already in use. Close the existing process or change GUI_PORT.`
            )
          );
          return;
        }

        writeInfo(
          `Port ${preferredPort} is already in use. Retrying on ${preferredPort + 1}...`,
          logger
        );
        startServer({
          ...options,
          port: preferredPort + 1,
        }).then(resolve, reject);
        return;
      }

      reject(new Error(`GUI server error: ${toErrorMessage(error)}`));
    });
  });
}

// ============================================================================
// 模块入口
// ============================================================================

/**
 * 如果直接运行此文件,则启动服务器
 */
if (require.main === module) {
  startServer().catch((error) => {
    process.stderr.write(`${toErrorMessage(error)}\n`);
    process.exit(1);
  });
}

/**
 * 导出服务器管理函数
 * 供 desktop-main.js 等其他模块使用
 */
module.exports = {
  startServer,
  closeServer,
};
