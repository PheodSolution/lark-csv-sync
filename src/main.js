#!/usr/bin/env node

/**
 * Lark Base CSV 同步工具 - 主入口文件
 * 
 * 功能:
 * - 将本地 CSV 文件同步到飞书多维表格(Lark Base)
 * - 支持多种同步模式:insert(仅新增)、update(仅更新)、upsert(更新+新增)、empty(清空字段)
 * - 支持字段映射配置(CSV 列名 -> Base 字段名)
 * - 支持断点续传(中断后可从上次位置继续)
 * - 支持配置文件保存(下次同步自动加载配置)
 * - 支持预设配置(基于文件名自动匹配表和映射)
 * - 支持多种字符编码(UTF-8、Shift_JIS、GBK)
 * - 支持交互式和非交互式(CI/CD)两种运行模式
 * 
 * 使用方式:
 * 1. 交互式: npm start
 * 2. 命令行: npm start -- --url "<base_url>" --csv "<file.csv>" --mode upsert
 * 3. 查看帮助: npm start -- --help
 * 
 * 核心流程:
 * 1. 解析命令行参数
 * 2. 加载配置文件
 * 3. 获取 Lark 认证信息
 * 4. 选择目标 Base 和数据表
 * 5. 读取 CSV 表头和 Base 字段列表
 * 6. 配置字段映射(值字段和关键字段)
 * 7. 执行同步(调用 sync-engine.js)
 * 8. 输出结果报告
 * 9. 保存配置文件
 * 
 * @module main
 */

const fs = require('fs');
const path = require('path');
const prompts = require('prompts');
const dotenv = require('dotenv');
const { LarkApiClient } = require('./lark-api');
const { readCsvHeaders, normalizeEncoding } = require('./csv-stream');
const { resolveCheckpointPath, loadCheckpoint } = require('./checkpoint');
const { runSync } = require('./sync-engine');
const { detectSyncPreset, findTableByName } = require('./sync-presets');
require('./logger');

// 加载环境变量(.env 文件)
dotenv.config();

// 支持的同步模式集合
const SUPPORTED_MODES = new Set(['insert', 'update', 'upsert', 'empty']);

// 默认配置文件路径
const DEFAULT_PROFILE_FILE = '.lark-sync-profiles.json';

/**
 * 解析命令行参数
 * 支持多种参数格式:--key=value 或 --key value
 * 
 * @param {Array<string>} argv - 命令行参数数组(process.argv)
 * @returns {Object} - 解析后的参数对象
 * 
 * 支持的参数格式:
 * - --key=value  (等号分隔)
 * - --key value  (空格分隔)
 * - --flag       (布尔标志,值为 'true')
 * 
 * @example
 * parseArgs(['node', 'main.js', '--url=xxx', '--csv', 'file.csv', '--help'])
 * // => { url: 'xxx', csv: 'file.csv', help: 'true' }
 */
function parseArgs(argv) {
  const args = {};
  
  // 从索引 2 开始(跳过 node 和脚本路径)
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    
    // 跳过非参数项
    if (!token.startsWith('--')) continue;

    // 处理 --key=value 格式
    const eqIndex = token.indexOf('=');
    if (eqIndex > 2) {
      const key = token.slice(2, eqIndex);  // 提取 key
      const value = token.slice(eqIndex + 1); // 提取 value
      args[key] = value;
      continue;
    }

    // 处理 --key value 或 --flag 格式
    const key = token.slice(2); // 移除 '--' 前缀
    const next = argv[i + 1];   // 获取下一个参数
    
    if (next && !next.startsWith('--')) {
      // 下一个参数是值
      args[key] = next;
      i += 1; // 跳过下一个参数
    } else {
      // 布尔标志
      args[key] = 'true';
    }
  }
  
  return args;
}

/**
 * 解析布尔值参数
 * 支持多种布尔值表示形式
 * 
 * @param {any} input - 输入值
 * @param {string} keyName - 参数名(用于错误提示)
 * @returns {boolean|undefined} - 解析后的布尔值,无效输入返回 undefined
 * @throws {Error} - 如果输入无法识别为布尔值
 * 
 * 真值: '1', 'true', 'yes', 'y', 'on'
 * 假值: '0', 'false', 'no', 'n', 'off'
 * 
 * @example
 * parseBoolean('true', 'clearEmpty')   // => true
 * parseBoolean('0', 'clearEmpty')      // => false
 * parseBoolean('', 'clearEmpty')       // => undefined
 * parseBoolean('invalid', 'clearEmpty') // => throws Error
 */
function parseBoolean(input, keyName) {
  // 空值返回 undefined
  if (input === undefined || input === null || input === '') return undefined;
  
  const raw = String(input).trim().toLowerCase();
  
  // 真值集合
  if (['1', 'true', 'yes', 'y', 'on'].includes(raw)) return true;
  
  // 假值集合
  if (['0', 'false', 'no', 'n', 'off'].includes(raw)) return false;
  
  // 无法识别,抛出错误
  throw new Error(`Invalid boolean for --${keyName}: ${input}`);
}

/**
 * 标准化文本:转为字符串、去除首尾空格、转小写
 * @param {any} value - 输入值
 * @returns {string} - 标准化后的字符串
 */
function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * 解析同步模式
 * 验证模式是否有效
 * 
 * @param {string} input - 输入的模式字符串
 * @returns {string} - 标准化后的模式(小写)
 * @throws {Error} - 如果模式无效
 * 
 * 支持的模式:
 * - insert: 仅新增
 * - update: 仅更新
 * - upsert: 更新+新增
 * - empty: 空值更新(清空字段)
 */
function parseMode(input) {
  const mode = String(input || '').trim().toLowerCase();
  
  // 验证模式是否有效
  if (!SUPPORTED_MODES.has(mode)) {
    throw new Error(`Invalid mode: ${input}. Allowed: insert, update, upsert, empty`);
  }
  
  return mode;
}

/**
 * 解析整数参数,带默认值
 * @param {any} input - 输入值
 * @param {number} fallback - 默认值
 * @returns {number} - 解析后的整数,解析失败返回默认值
 */
function parseIntOrDefault(input, fallback) {
  if (input === undefined || input === null || input === '') return fallback;
  const value = Number.parseInt(String(input), 10);
  if (!Number.isFinite(value)) return fallback;
  return value;
}

/**
 * 限制批次大小在 1-500 之间
 * Lark API 批量操作最多支持 500 条记录
 * 
 * @param {any} input - 输入的批次大小
 * @returns {number} - 限制后的批次大小(1-500)
 */
function clampBatchSize(input) {
  const value = parseIntOrDefault(input, 500);
  if (value <= 0) return 1;    // 最小值 1
  if (value > 500) return 500; // 最大值 500
  return value;
}

/**
 * 解析 Base URL,提取 appToken 和 tableId
 * 
 * @param {string} input - Lark Base URL
 * @returns {Object} - 解析结果 { appToken, tableId, sourceUrl }
 * @throws {Error} - 如果 URL 格式无效或无法提取 appToken
 * 
 * 支持的 URL 格式:
 * - https://xxx.larksuite.com/base/bas.../
 * - https://xxx.larksuite.com/base/bas...?table=tbl...
 * - https://xxx.larksuite.com/base/bas.../tbl...
 * 
 * @example
 * parseBaseTableUrl('https://xxx.larksuite.com/base/basABC?table=tblXYZ')
 * // => { appToken: 'basABC', tableId: 'tblXYZ', sourceUrl: '...' }
 */
function parseBaseTableUrl(input) {
  const value = String(input || '').trim();
  
  // 检查是否为空
  if (!value) {
    throw new Error('Base URL is empty');
  }

  let parsed;
  try {
    parsed = new URL(value); // 解析 URL
  } catch (error) {
    throw new Error(`Invalid Base URL: ${error.message}`);
  }

  const pathname = parsed.pathname || '';
  const segments = pathname.split('/').filter(Boolean); // 分割路径
  
  let appToken = '';
  
  // 方法1: 从路径中查找 /base/bas... 格式
  const baseIndex = segments.findIndex((item) => item.toLowerCase() === 'base');
  if (baseIndex >= 0 && segments[baseIndex + 1]) {
    appToken = segments[baseIndex + 1];
  }
  
  // 方法2: 使用正则匹配 bas 开头的 token
  if (!appToken) {
    const match = pathname.match(/(bas[a-z0-9]+)/i);
    if (match) appToken = match[1];
  }
  
  // 验证是否成功提取 appToken
  if (!appToken) {
    throw new Error('Could not parse app token (bas...) from Base URL');
  }

  // 提取 tableId(可选)
  // 方法1: 从查询参数中获取
  const tableIdFromQuery = parsed.searchParams.get('table') || parsed.searchParams.get('table_id');
  let tableId = tableIdFromQuery || '';
  
  // 方法2: 从路径中匹配 tbl 开头的 ID
  if (!tableId) {
    const tableMatch = pathname.match(/(tbl[a-z0-9]+)/i);
    if (tableMatch) tableId = tableMatch[1];
  }

  return {
    appToken,    // Base 应用 token(必需)
    tableId,     // 表 ID(可选)
    sourceUrl: value, // 原始 URL
  };
}

/**
 * 解析字段映射文本
 * 支持多种分隔符格式
 * 
 * @param {string} input - 映射文本字符串
 * @returns {Array<Object>} - 映射对象数组 [{ csvColumn, fieldName }, ...]
 * @throws {Error} - 如果映射格式无效
 * 
 * 支持的格式:
 * - CSV列=Base字段
 * - CSV列=>Base字段
 * - CSV列:Base字段
 * - 多个映射用逗号分隔
 * 
 * @example
 * parseMappingText('Name=姓名,Email=邮箱')
 * // => [{ csvColumn: 'Name', fieldName: '姓名' }, { csvColumn: 'Email', fieldName: '邮箱' }]
 * 
 * parseMappingText('ID=>记录ID')
 * // => [{ csvColumn: 'ID', fieldName: '记录ID' }]
 */
function parseMappingText(input) {
  const raw = String(input || '').trim();
  if (!raw) return []; // 空字符串返回空数组

  return raw
    .split(',')                    // 按逗号分割
    .map((item) => item.trim())    // 去除空格
    .filter(Boolean)               // 过滤空项
    .map((pair) => {
      // 检测分隔符类型
      let separator = '';
      if (pair.includes('=>')) separator = '=>';
      else if (pair.includes('=')) separator = '=';
      else if (pair.includes(':')) separator = ':';

      // 如果没有分隔符,抛出错误
      if (!separator) {
        throw new Error(`Invalid mapping pair: ${pair}. Use CSV=FIELD`);
      }

      // 分割为 CSV 列名和 Base 字段名
      const [left, right] = pair.split(separator);
      const csvColumn = String(left || '').trim();
      const fieldName = String(right || '').trim();
      
      // 验证两边都不为空
      if (!csvColumn || !fieldName) {
        throw new Error(`Invalid mapping pair: ${pair}. Use CSV=FIELD`);
      }

      return { csvColumn, fieldName };
    });
}

/**
 * 构建名称映射表(忽略大小写)
 * 用于字段名的模糊匹配
 * 
 * @param {Array<string>} items - 名称数组
 * @returns {Map<string, string>} - 映射表(小写名称 -> 原始名称)
 * 
 * @example
 * buildNameMap(['Name', 'Email', 'AGE'])
 * // => Map { 'name' => 'Name', 'email' => 'Email', 'age' => 'AGE' }
 */
function buildNameMap(items) {
  const map = new Map();
  items.forEach((item) => {
    const key = normalizeText(item); // 转为小写作为 key
    if (!key || map.has(key)) return; // 跳过空值和重复项
    map.set(key, item); // 保存原始名称
  });
  return map;
}

/**
 * 标准化并验证字段映射
 * 确保 CSV 列名和 Base 字段名都存在且唯一
 * 
 * @param {Array<Object>} mappings - 原始映射数组
 * @param {Array<string>} csvHeaders - CSV 列名数组
 * @param {Array<string>} fieldNames - Base 字段名数组
 * @param {string} label - 标签(用于错误提示)
 * @returns {Array<Object>} - 标准化后的映射数组
 * @throws {Error} - 如果列名或字段名不存在,或字段名重复
 */
function normalizeMappings(mappings, csvHeaders, fieldNames, label) {
  const csvByName = buildNameMap(csvHeaders);   // CSV 列名映射表
  const fieldByName = buildNameMap(fieldNames); // Base 字段名映射表
  const seenFields = new Set();                 // 已使用的字段名集合
  const normalized = [];

  for (const mapping of mappings) {
    // 查找实际的列名和字段名(忽略大小写)
    const csvColumn = csvByName.get(normalizeText(mapping.csvColumn));
    const fieldName = fieldByName.get(normalizeText(mapping.fieldName));
    
    // 验证 CSV 列名是否存在
    if (!csvColumn) {
      throw new Error(`${label}: CSV column not found -> ${mapping.csvColumn}`);
    }
    
    // 验证 Base 字段名是否存在
    if (!fieldName) {
      throw new Error(`${label}: table field not found -> ${mapping.fieldName}`);
    }
    
    // 检查字段名是否重复
    const fieldKey = normalizeText(fieldName);
    if (seenFields.has(fieldKey)) {
      throw new Error(`${label}: duplicate table field -> ${fieldName}`);
    }
    seenFields.add(fieldKey);
    
    // 添加到结果数组
    normalized.push({ csvColumn, fieldName });
  }

  return normalized;
}

/**
 * 构建自动映射(基于同名规则)
 * 当 CSV 列名与 Base 字段名相同时自动匹配
 * 
 * @param {Array<string>} csvHeaders - CSV 列名数组
 * @param {Array<string>} fieldNames - Base 字段名数组
 * @returns {Array<Object>} - 自动映射数组
 * 
 * 规则:
 * - 忽略大小写比较
 * - 每个字段只匹配一次
 * - 按 CSV 列顺序返回
 * 
 * @example
 * buildAutoMappings(['Name', 'age', 'Email'], ['name', 'Age', 'Phone'])
 * // => [{ csvColumn: 'Name', fieldName: 'name' }, { csvColumn: 'age', fieldName: 'Age' }]
 */
function buildAutoMappings(csvHeaders, fieldNames) {
  const fieldByName = buildNameMap(fieldNames); // Base 字段名映射表
  const usedFields = new Set();                 // 已使用的字段名集合
  const mappings = [];

  csvHeaders.forEach((csvColumn) => {
    // 查找同名的 Base 字段(忽略大小写)
    const fieldName = fieldByName.get(normalizeText(csvColumn));
    if (!fieldName) return; // 未找到,跳过
    
    // 检查字段是否已使用
    const fieldKey = normalizeText(fieldName);
    if (usedFields.has(fieldKey)) return; // 已使用,跳过
    
    usedFields.add(fieldKey);
    mappings.push({ csvColumn, fieldName });
  });

  return mappings;
}

/**
 * 加载配置文件
 * 从 JSON 文件中读取保存的同步配置
 * 
 * @param {string} profilePath - 配置文件路径
 * @returns {Object} - 配置对象 { version, profiles }
 * @throws {Error} - 如果文件读取或解析失败
 * 
 * 配置文件结构:
 * {
 *   version: 1,
 *   profiles: {
 *     "appToken:tableId": {
 *       csvPath, mode, csvEncoding, clearEmpty, batchSize,
 *       keyMappings, valueMappings, updatedAt
 *     }
 *   }
 * }
 */
function loadProfiles(profilePath) {
  // 文件不存在,返回空配置
  if (!fs.existsSync(profilePath)) {
    return { version: 1, profiles: {} };
  }

  try {
    const raw = fs.readFileSync(profilePath, 'utf8');
    if (!raw.trim()) return { version: 1, profiles: {} }; // 空文件
    
    const parsed = JSON.parse(raw);
    
    // 验证配置对象结构
    if (!parsed || typeof parsed !== 'object') {
      return { version: 1, profiles: {} };
    }
    
    // 确保 profiles 字段存在
    if (!parsed.profiles || typeof parsed.profiles !== 'object') {
      parsed.profiles = {};
    }
    
    return parsed;
  } catch (error) {
    throw new Error(`Failed to load profile file: ${error.message}`);
  }
}

/**
 * 过滤并验证配置文件中的映射
 * 确保映射中的列名和字段名在当前 schema 中存在
 * 
 * @param {Array<Object>} mappings - 配置文件中的映射
 * @param {Array<string>} csvHeaders - CSV 列名数组
 * @param {Array<string>} fieldNames - Base 字段名数组
 * @returns {Array<Object>} - 有效的映射数组,无效则返回空数组
 * 
 * 用途:
 * - 验证保存的配置是否仍然适用于当前的 CSV 和表结构
 * - 如果 CSV 或表结构发生变化,自动过滤掉无效的映射
 */
function filterMappingsBySchema(mappings, csvHeaders, fieldNames) {
  try {
    return normalizeMappings(mappings || [], csvHeaders, fieldNames, 'profile');
  } catch {
    return []; // 验证失败,返回空数组
  }
}

/**
 * 保存配置文件
 * 将配置对象写入 JSON 文件
 * 
 * @param {string} profilePath - 配置文件路径
 * @param {Object} content - 配置对象
 */
function saveProfiles(profilePath, content) {
  fs.writeFileSync(profilePath, JSON.stringify(content, null, 2), 'utf8');
}

/**
 * 检测是否为交互式终端
 * 用于判断是否可以使用 prompts 进行用户交互
 * 
 * @returns {boolean} - true 表示可以交互,false 表示非交互模式(如 CI/CD)
 */
function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * 智能获取参数值
 * 优先级: 命令行参数 > 交互式输入 > 默认值
 * 
 * @param {Object} question - prompts 问题对象
 * @param {any} argsValue - 命令行参数值
 * @param {any} fallbackValue - 默认值
 * @returns {Promise<string>} - 最终参数值
 * @throws {Error} - 如果非交互模式下缺少必需参数
 * 
 * 逻辑:
 * 1. 如果命令行参数存在,直接使用
 * 2. 如果非交互模式,使用默认值或抛出错误
 * 3. 如果交互模式,弹出提示让用户输入
 */
async function askIfNeeded(question, argsValue, fallbackValue) {
  // 优先使用命令行参数
  if (argsValue !== undefined && argsValue !== null && String(argsValue).trim() !== '') {
    return String(argsValue).trim();
  }
  
  // 非交互模式:使用默认值或抛出错误
  if (!isInteractive()) {
    if (fallbackValue) return fallbackValue;
    throw new Error(`Missing required parameter: ${question.message}`);
  }
  
  // 交互模式:弹出提示
  const response = await prompts(question, {
    onCancel: () => {
      throw new Error('Cancelled by user');
    },
  });
  return response[question.name];
}

/**
 * 打印字段映射列表
 * 格式化输出映射关系
 * 
 * @param {string} title - 标题
 * @param {Array<Object>} mappings - 映射数组
 * 
 * 输出格式:
 * Key mappings (2):
 *   1. ID -> 记录ID
 *   2. Name -> 姓名
 */
function printMappings(title, mappings) {
  process.stdout.write(`${title} (${mappings.length}):\n`);
  mappings.forEach((item, index) => {
    process.stdout.write(`  ${index + 1}. ${item.csvColumn} -> ${item.fieldName}\n`);
  });
}

/**
 * 打印帮助信息
 * 显示命令行使用说明和所有可用参数
 */
function printHelp() {
  process.stdout.write(`lark-local-sync

Usage:
  npm start -- --url "<base_url>" --csv "<file.csv>" [options]
  node src/main.js --url "<base_url>" --csv "<file.csv>" [options]

Options:
  --url              Lark Base URL (must include bas token)
  --csv              CSV file path
  --mode             insert | update | upsert | empty (default: upsert)
  --encoding         utf8 | shift_jis | gbk (default: utf8)
  --map              value mapping, e.g. "Name=顧客名,Email=メール"
  --key              key mapping, e.g. "顧客ID=顧客ID"
  --clear-empty      true/false (ignored in update/upsert; empty mode always clears)
  --batch            1..500 (default: 500)
  --checkpoint       checkpoint file path (default: .sync-checkpoint.json)
  --resume           row number to resume from checkpoint
  --app-id           Lark App ID (or set LARK_APP_ID in .env)
  --app-secret       Lark App Secret (or set LARK_APP_SECRET in .env)
  --api-base         OpenAPI base (default: https://open.larksuite.com)
  --profile-file     profile file path (default: .lark-sync-profiles.json)
  --no-profile       disable profile load/save
  --help             show this help
`);
}

/**
 * 选择目标数据表
 * 优先使用 URL 中的 tableId,否则交互式选择
 * 
 * @param {LarkApiClient} client - Lark API 客户端
 * @param {string} appToken - Base 应用 token
 * @param {string} tableIdFromUrl - 从 URL 中提取的 tableId(可选)
 * @returns {Promise<Object>} - { tableId, tableName }
 * @throws {Error} - 如果 Base 中没有表
 * 
 * 逻辑:
 * 1. 获取 Base 中所有表
 * 2. 如果 URL 中有 tableId 且存在,直接使用
 * 3. 如果非交互模式,使用第一个表
 * 4. 如果交互模式,让用户选择
 */
async function selectTableId(client, appToken, tableIdFromUrl) {
  // 获取所有表
  const tables = await client.listTables(appToken);
  if (tables.length === 0) {
    if (tableIdFromUrl) return { tableId: tableIdFromUrl, tableName: tableIdFromUrl };
    throw new Error('No tables found in this Base');
  }

  // 优先使用 URL 中的 tableId
  if (tableIdFromUrl) {
    const target = tables.find((item) => item.table_id === tableIdFromUrl);
    if (target) {
      return { tableId: target.table_id, tableName: target.name || target.table_id };
    }
    process.stdout.write(
      `[warn] table in URL not found, fallback to manual select: ${tableIdFromUrl}\n`
    );
  }

  // 非交互模式:使用第一个表
  if (!isInteractive()) {
    const first = tables[0];
    process.stdout.write(
      `[info] non-interactive mode: using first table ${first.name || first.table_id}\n`
    );
    return { tableId: first.table_id, tableName: first.name || first.table_id };
  }

  // 交互模式:让用户选择
  const response = await prompts(
    {
      type: 'select',
      name: 'tableId',
      message: 'Select table',
      choices: tables.map((item) => ({
        title: `${item.name || item.table_id} (${item.table_id})`,
        value: item.table_id,
      })),
    },
    {
      onCancel: () => {
        throw new Error('Cancelled by user');
      },
    }
  );

  const selected = tables.find((item) => item.table_id === response.tableId);
  return {
    tableId: response.tableId,
    tableName: selected ? selected.name || selected.table_id : response.tableId,
  };
}

/**
 * 生成配置文件的键名
 * 格式: appToken:tableId
 * 
 * @param {string} appToken - Base 应用 token
 * @param {string} tableId - 表 ID
 * @returns {string} - 配置键名
 */
function profileKey(appToken, tableId) {
  return `${appToken}:${tableId}`;
}

function filterMappingsBySchema(mappings, csvHeaders, fieldNames) {
  try {
    return normalizeMappings(mappings || [], csvHeaders, fieldNames, 'profile');
  } catch {
    return [];
  }
}

/**
 * 选择值字段映射
 * 优先级: 命令行参数 > 配置文件 > 自动映射 > 手动输入
 * 
 * @param {Object} args - 命令行参数
 * @param {Object} profile - 配置文件中的配置
 * @param {Array<string>} csvHeaders - CSV 列名数组
 * @param {Array<string>} fieldNames - Base 字段名数组
 * @param {Array<Object>} autoMappings - 自动生成的同名映射
 * @returns {Promise<Array<Object>>} - 最终的值字段映射
 * @throws {Error} - 如果没有选择任何映射
 * 
 * 决策流程:
 * 1. 如果有 --map 参数,直接使用
 * 2. 如果配置文件中有有效映射,询问是否使用
 * 3. 如果有自动映射,询问是否使用并让用户选择字段
 * 4. 否则要求用户手动输入
 */
async function chooseValueMappings(args, profile, csvHeaders, fieldNames, autoMappings) {
  // 1. 优先使用命令行参数
  if (args.map) {
    const parsed = parseMappingText(args.map);
    return normalizeMappings(parsed, csvHeaders, fieldNames, 'value mapping');
  }

  // 2. 尝试使用配置文件中的映射
  const profileMappings = filterMappingsBySchema(profile.valueMappings, csvHeaders, fieldNames);
  if (profileMappings.length > 0) {
    if (!isInteractive()) return profileMappings; // 非交互模式直接使用
    
    // 交互模式:询问是否使用
    const useProfile = await prompts(
      {
        type: 'toggle',
        name: 'ok',
        message: `Use saved value mappings (${profileMappings.length})?`,
        initial: true,
        active: 'yes',
        inactive: 'no',
      },
      {
        onCancel: () => {
          throw new Error('Cancelled by user');
        },
      }
    );
    if (useProfile.ok) return profileMappings;
  }

  // 3. 尝试使用自动映射
  if (autoMappings.length > 0) {
    if (!isInteractive()) return autoMappings; // 非交互模式直接使用

    // 交互模式:询问是否使用自动映射
    const useAuto = await prompts(
      {
        type: 'toggle',
        name: 'ok',
        message: `Use same-name auto mappings (${autoMappings.length})?`,
        initial: true,
        active: 'yes',
        inactive: 'no',
      },
      {
        onCancel: () => {
          throw new Error('Cancelled by user');
        },
      }
    );
    
    if (useAuto.ok) {
      // 让用户选择要同步的字段
      const selected = await prompts(
        {
          type: 'multiselect',
          name: 'ids',
          message: 'Select fields to write',
          instructions: false,
          min: 1,
          choices: autoMappings.map((item, index) => ({
            title: `${item.csvColumn} -> ${item.fieldName}`,
            value: index,
            selected: true, // 默认全选
          })),
        },
        {
          onCancel: () => {
            throw new Error('Cancelled by user');
          },
        }
      );
      return (selected.ids || []).map((index) => autoMappings[index]);
    }
  }

  // 4. 手动输入映射
  const manual = await askIfNeeded(
    {
      type: 'text',
      name: 'mappings',
      message: 'Input value mapping: CSV=FIELD,CSV2=FIELD2',
    },
    undefined,
    ''
  );
  const parsed = parseMappingText(manual);
  const mappings = normalizeMappings(parsed, csvHeaders, fieldNames, 'value mapping');
  if (mappings.length === 0) {
    throw new Error('No value mapping selected');
  }
  return mappings;
}

/**
 * 选择关键字段映射(用于匹配记录)
 * 优先级: 命令行参数 > 配置文件 > 交互式选择
 * 
 * @param {Object} args - 命令行参数
 * @param {Object} profile - 配置文件中的配置
 * @param {string} mode - 同步模式
 * @param {Array<string>} csvHeaders - CSV 列名数组
 * @param {Array<string>} fieldNames - Base 字段名数组
 * @param {Array<Object>} valueMappings - 值字段映射
 * @returns {Promise<Array<Object>>} - 关键字段映射
 * @throws {Error} - 如果 update/upsert 模式下没有选择关键字段
 * 
 * 关键字段用途:
 * - update/upsert 模式:用于匹配 CSV 行与 Base 记录
 * - insert 模式:不需要关键字段,返回空数组
 * 
 * 决策流程:
 * 1. insert 模式直接返回空数组
 * 2. 如果有 --key 参数,直接使用
 * 3. 如果配置文件中有有效映射,询问是否使用
 * 4. 否则从值字段映射中选择(交互模式)或使用第一个(非交互模式)
 */
async function chooseKeyMappings(args, profile, mode, csvHeaders, fieldNames, valueMappings) {
  // insert 模式不需要关键字段
  if (mode === 'insert') return [];

  // 1. 优先使用命令行参数
  if (args.key) {
    const parsed = parseMappingText(args.key);
    const normalized = normalizeMappings(parsed, csvHeaders, fieldNames, 'key mapping');
    if (normalized.length === 0) {
      throw new Error('At least one key mapping is required for update/upsert mode');
    }
    return normalized;
  }

  // 2. 尝试使用配置文件中的映射
  const profileMappings = filterMappingsBySchema(profile.keyMappings, csvHeaders, fieldNames);
  if (profileMappings.length > 0) {
    if (!isInteractive()) return profileMappings; // 非交互模式直接使用
    
    // 交互模式:询问是否使用
    const useProfile = await prompts(
      {
        type: 'toggle',
        name: 'ok',
        message: `Use saved key mappings (${profileMappings.length})?`,
        initial: true,
        active: 'yes',
        inactive: 'no',
      },
      {
        onCancel: () => {
          throw new Error('Cancelled by user');
        },
      }
    );
    if (useProfile.ok) return profileMappings;
  }

  // 3. 从值字段映射或自动映射中选择
  const choices = valueMappings.length > 0 ? valueMappings : buildAutoMappings(csvHeaders, fieldNames);
  if (choices.length === 0) {
    throw new Error('No candidates available for key mappings');
  }

  // 非交互模式:使用第一个字段作为关键字段
  if (!isInteractive()) {
    return [choices[0]];
  }

  // 交互模式:让用户选择关键字段
  const selected = await prompts(
    {
      type: 'multiselect',
      name: 'ids',
      message: 'Select key fields for matching',
      instructions: false,
      min: 1,
      choices: choices.map((item, index) => ({
        title: `${item.csvColumn} -> ${item.fieldName}`,
        value: index,
        selected: index === 0, // 默认选中第一个
      })),
    },
    {
      onCancel: () => {
        throw new Error('Cancelled by user');
      },
    }
  );

  const keyMappings = (selected.ids || []).map((index) => choices[index]);
  if (keyMappings.length === 0) {
    throw new Error('At least one key mapping is required');
  }
  return keyMappings;
}

/**
 * 主函数
 * 协调整个同步流程
 * 
 * 流程概览:
 * 1. 解析命令行参数
 * 2. 加载配置文件
 * 3. 获取 Lark 认证信息(App ID/Secret)
 * 4. 解析 Base URL,提取 appToken 和 tableId
 * 5. 选择目标数据表
 * 6. 检测同步预设(如果文件名匹配)
 * 7. 确定同步模式(insert/update/upsert/empty)
 * 8. 读取 CSV 表头和 Base 字段列表
 * 9. 配置字段映射(值字段和关键字段)
 * 10. 处理断点续传
 * 11. 执行同步
 * 12. 输出结果报告
 * 13. 保存配置文件
 */
async function main() {
  // 1. 解析命令行参数
  const args = parseArgs(process.argv);
  if (args.help) {
    printHelp();
    return;
  }

  // 2. 加载配置文件
  const noProfile = args['no-profile'] !== undefined;
  const profilePath = path.resolve(
    process.cwd(),
    String(args['profile-file'] || DEFAULT_PROFILE_FILE)
  );
  const profiles = noProfile ? { version: 1, profiles: {} } : loadProfiles(profilePath);

  // 3. 获取 Lark 认证信息
  const appId = await askIfNeeded(
    {
      type: 'text',
      name: 'appId',
      message: 'Lark App ID',
    },
    args['app-id'],
    process.env.LARK_APP_ID || process.env.APP_ID || ''
  );
  const appSecret = await askIfNeeded(
    {
      type: 'password',
      name: 'appSecret',
      message: 'Lark App Secret',
    },
    args['app-secret'],
    process.env.LARK_APP_SECRET || process.env.APP_SECRET || ''
  );

  if (!appId || !appSecret) {
    throw new Error('App ID / App Secret is required');
  }

  // 4. 解析 Base URL
  const baseUrlInput = await askIfNeeded(
    {
      type: 'text',
      name: 'baseUrl',
      message: 'Lark Base URL',
    },
    args.url,
    ''
  );
  const { appToken, tableId: tableIdFromUrl } = parseBaseTableUrl(baseUrlInput);

  // 创建 Lark API 客户端
  const client = new LarkApiClient({
    appId,
    appSecret,
    baseUrl: String(
      args['api-base'] || process.env.LARK_OPENAPI_BASE || 'https://open.larksuite.com'
    ),
  });

  // 5. 选择目标数据表
  process.stdout.write('[step] loading table list...\n');
  const tableInfo = await selectTableId(client, appToken, tableIdFromUrl);
  let selectedTableId = tableInfo.tableId;
  let selectedTableName = tableInfo.tableName;

  // 加载该表的配置
  let profileId = profileKey(appToken, selectedTableId);
  let currentProfile = profiles.profiles[profileId] || {};

  const csvPathInput = await askIfNeeded(
    {
      type: 'text',
      name: 'csvPath',
      message: 'CSV file path',
    },
    args.csv,
    currentProfile.csvPath || ''
  );
  const csvPath = path.resolve(process.cwd(), csvPathInput);
  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV file not found: ${csvPath}`);
  }

  const detectedPreset = detectSyncPreset(path.basename(csvPath));
  if (detectedPreset) {
    process.stdout.write(
      `[preset] matched "${detectedPreset.name}" from filename, table=${detectedPreset.tableName}, mode=${detectedPreset.mode}\n`
    );
    const allTables = await client.listTables(appToken);
    const presetTable = findTableByName(allTables, detectedPreset.tableName);
    if (!presetTable) {
      throw new Error(`Preset table not found in Base: ${detectedPreset.tableName}`);
    }
    selectedTableId = presetTable.table_id;
    selectedTableName = presetTable.name || presetTable.table_id;
    profileId = profileKey(appToken, selectedTableId);
    currentProfile = profiles.profiles[profileId] || {};
  }

  // 6. 获取 CSV 文件路径
  const csvPathInput = await askIfNeeded(
    {
      type: 'text',
      name: 'csvPath',
      message: 'CSV file path',
    },
    args.csv,
    currentProfile.csvPath || ''
  );
  const csvPath = path.resolve(process.cwd(), csvPathInput);
  if (!fs.existsSync(csvPath)) {
    throw new Error(`CSV file not found: ${csvPath}`);
  }

  // 7. 检测同步预设(基于文件名)
  const detectedPreset = detectSyncPreset(path.basename(csvPath));
  if (detectedPreset) {
    process.stdout.write(
      `[preset] matched "${detectedPreset.name}" from filename, table=${detectedPreset.tableName}, mode=${detectedPreset.mode}\n`
    );
    // 根据预设切换到指定的表
    const allTables = await client.listTables(appToken);
    const presetTable = findTableByName(allTables, detectedPreset.tableName);
    if (!presetTable) {
      throw new Error(`Preset table not found in Base: ${detectedPreset.tableName}`);
    }
    selectedTableId = presetTable.table_id;
    selectedTableName = presetTable.name || presetTable.table_id;
    profileId = profileKey(appToken, selectedTableId);
    currentProfile = profiles.profiles[profileId] || {};
  }

  // 8. 确定同步模式
  let mode = '';
  if (detectedPreset) {
    mode = parseMode(detectedPreset.mode); // 预设模式
  } else if (args.mode) {
    mode = parseMode(args.mode); // 命令行参数
  } else if (currentProfile.mode) {
    mode = parseMode(currentProfile.mode); // 配置文件
  }
  
  // 交互式选择模式
  if (!mode && isInteractive()) {
    const modeResponse = await prompts(
      {
        type: 'select',
        name: 'mode',
        message: 'Sync mode',
        choices: [
          { title: 'upsert (update existing, insert new)', value: 'upsert' },
          { title: 'update (update existing only)', value: 'update' },
          { title: 'insert (insert new only)', value: 'insert' },
          { title: 'empty (clear mapped fields on matched rows)', value: 'empty' },
        ],
        initial: 0,
      },
      {
        onCancel: () => {
          throw new Error('Cancelled by user');
        },
      }
    );
    mode = modeResponse.mode;
  }
  if (!mode) mode = 'upsert'; // 默认模式

  // 9. 确定 CSV 编码
  let csvEncoding = normalizeEncoding(args.encoding || currentProfile.csvEncoding || 'utf8');
  if (!args.encoding && isInteractive()) {
    const encodingResponse = await prompts(
      {
        type: 'select',
        name: 'encoding',
        message: 'CSV encoding',
        choices: [
          { title: 'utf8', value: 'utf8' },
          { title: 'shift_jis (cp932/sjis)', value: 'shift_jis' },
          { title: 'gbk', value: 'gbk' },
        ],
        initial: csvEncoding === 'shift_jis' ? 1 : csvEncoding === 'gbk' ? 2 : 0,
      },
      {
        onCancel: () => {
          throw new Error('Cancelled by user');
        },
      }
    );
    csvEncoding = encodingResponse.encoding || csvEncoding;
  }

  // 10. 确定是否清空空值字段
  const clearEmptyArg = parseBoolean(args['clear-empty'], 'clear-empty');
  let clearEmpty = false;
  if (mode === 'empty') {
    clearEmpty = true; // empty 模式强制清空
  } else if (mode === 'insert') {
    clearEmpty = false; // insert 模式不清空
  } else if (clearEmptyArg === true) {
    process.stdout.write('[warn] --clear-empty is ignored in update/upsert mode\n');
    clearEmpty = false;
  }

  // 11. 确定批次大小
  const batchSize = clampBatchSize(args.batch || currentProfile.batchSize || 500);

  // 12. 读取 CSV 表头
  process.stdout.write('[step] reading CSV headers...\n');
  const csvHeaders = await readCsvHeaders(csvPath, { encoding: csvEncoding });
  if (csvHeaders.length === 0) {
    throw new Error('CSV header row is empty');
  }

  // 13. 获取 Base 表字段列表
  process.stdout.write('[step] loading table fields...\n');
  const fieldMetas = await client.listFields(appToken, selectedTableId);
  const fieldNames = fieldMetas.map((item) => item.field_name).filter(Boolean);
  if (fieldNames.length === 0) {
    throw new Error('No writable fields found in table');
  }

  // 14. 配置字段映射
  let updateMappings = [];  // 更新时使用的映射
  let insertMappings = [];  // 插入时使用的映射
  let valueMappings = [];   // 值字段映射
  let keyMappings = [];     // 关键字段映射

  if (detectedPreset) {
    // 使用预设配置
    updateMappings = normalizeMappings(
      detectedPreset.updateMappings,
      csvHeaders,
      fieldNames,
      'preset update mapping'
    );
    insertMappings = normalizeMappings(
      detectedPreset.insertMappings,
      csvHeaders,
      fieldNames,
      'preset insert mapping'
    );
    keyMappings =
      mode === 'insert'
        ? []
        : normalizeMappings(
            detectedPreset.keyMappings,
            csvHeaders,
            fieldNames,
            'preset key mapping'
          );
    valueMappings = mode === 'insert' ? insertMappings : updateMappings;
  } else {
    // 交互式配置或使用保存的配置
    const autoMappings = buildAutoMappings(csvHeaders, fieldNames);
    valueMappings = await chooseValueMappings(
      args,
      currentProfile,
      csvHeaders,
      fieldNames,
      autoMappings
    );
    if (valueMappings.length === 0) {
      throw new Error('No value mappings selected');
    }
    keyMappings = await chooseKeyMappings(
      args,
      currentProfile,
      mode,
      csvHeaders,
      fieldNames,
      valueMappings
    );
    updateMappings = valueMappings;
    insertMappings = valueMappings;
  }

  // 15. 处理断点续传
  const checkpointPath = resolveCheckpointPath(args.checkpoint || '.sync-checkpoint.json');
  let resumeRow = parseIntOrDefault(args.resume, 0);
  if (resumeRow < 0) resumeRow = 0;

  // 检查是否有可用的断点
  if (resumeRow === 0 && fs.existsSync(checkpointPath)) {
    const checkpoint = loadCheckpoint(checkpointPath);
    const canResume =
      checkpoint &&
      checkpoint.appToken === appToken &&
      checkpoint.tableId === selectedTableId &&
      path.resolve(checkpoint.csvPath || '') === csvPath &&
      checkpoint.mode === mode &&
      Number(checkpoint.processedRows) > 0 &&
      !checkpoint.completed;

    if (canResume) {
      if (isInteractive()) {
        // 交互模式:询问是否续传
        const useResume = await prompts(
          {
            type: 'toggle',
            name: 'ok',
            message: `Resume from checkpoint row ${checkpoint.processedRows}?`,
            initial: true,
            active: 'yes',
            inactive: 'no',
          },
          {
            onCancel: () => {
              throw new Error('Cancelled by user');
            },
          }
        );
        if (useResume.ok) {
          resumeRow = Number(checkpoint.processedRows);
        }
      } else {
        // 非交互模式:自动续传
        resumeRow = Number(checkpoint.processedRows);
      }
    }
  }

  // 16. 打印同步计划
  process.stdout.write('\n=== Sync Plan ===\n');
  process.stdout.write(`Table: ${selectedTableName} (${selectedTableId})\n`);
  process.stdout.write(`CSV: ${csvPath}\n`);
  process.stdout.write(`Mode: ${mode}\n`);
  process.stdout.write(`Encoding: ${csvEncoding}\n`);
  process.stdout.write(`Batch size: ${batchSize}\n`);
  process.stdout.write(`Clear empty: ${clearEmpty}\n`);
  process.stdout.write(`Resume row: ${resumeRow}\n`);
  if (detectedPreset) {
    process.stdout.write(
      `Preset: ${detectedPreset.name} (${detectedPreset.fileName || path.basename(csvPath)})\n`
    );
  }
  printMappings('Key mappings', keyMappings);
  printMappings('Update mappings', updateMappings);
  if (mode === 'insert' || mode === 'upsert') {
    printMappings('Insert mappings', insertMappings);
  }
  process.stdout.write('\n');

  // 17. 执行同步
  const stats = await runSync({
    client,
    appToken,
    tableId: selectedTableId,
    csvPath,
    csvEncoding,
    mode,
    keyMappings,
    valueMappings,
    updateMappings,
    insertMappings,
    batchSize,
    clearEmpty,
    checkpointPath,
    resumeRow,
  });

  // 18. 输出同步结果
  process.stdout.write('\n=== Result ===\n');
  process.stdout.write(`Processed rows: ${stats.totalRows}\n`);
  process.stdout.write(`Inserted: ${stats.insertedRows}\n`);
  process.stdout.write(`Updated: ${stats.updatedRows}\n`);
  process.stdout.write(`Skipped: ${stats.skippedRows}\n`);
  process.stdout.write(`Failed: ${stats.failedRows}\n`);
  process.stdout.write(`Started: ${stats.startedAt}\n`);
  process.stdout.write(`Ended: ${stats.endedAt}\n`);

  // 输出失败记录(最多 50 条)
  if (stats.failures.length > 0) {
    process.stdout.write('\nTop failures (max 50 shown):\n');
    stats.failures.slice(0, 50).forEach((item) => {
      process.stdout.write(`  row ${item.rowNumber}: ${item.reason}\n`);
    });
  }

  // 19. 保存同步报告
  const reportPath = path.resolve(
    process.cwd(),
    `sync-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
  );
  fs.writeFileSync(reportPath, JSON.stringify(stats, null, 2), 'utf8');
  process.stdout.write(`\nReport: ${reportPath}\n`);
  process.stdout.write(`Checkpoint: ${checkpointPath}\n`);

  // 20. 保存配置文件(用于下次同步)
  if (!noProfile) {
    profiles.profiles[profileId] = {
      csvPath,
      mode,
      csvEncoding,
      clearEmpty,
      batchSize,
      keyMappings,
      valueMappings,
      updatedAt: new Date().toISOString(),
    };
    saveProfiles(profilePath, profiles);
    process.stdout.write(`Profile saved: ${profilePath}\n`);
  }
}

// 执行主函数并捕获错误
main().catch((error) => {
  process.stderr.write(`\n[error] ${error.message}\n`);
  process.exitCode = 1;
});
