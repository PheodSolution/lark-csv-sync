const path = require('path');
const { createCsvRowStream, countCsvRows } = require('./csv-stream');
const { saveCheckpoint } = require('./checkpoint');
const { validateCsvRow } = require('./csv-validators');

const CONCURRENCY_WRITE = 25;
const PAGE_TOKEN_REPEAT_RETRY_LIMIT = 5;
const PAGE_TOKEN_REPEAT_RETRY_BASE_MS = 500;
const PAGE_TOKEN_REPEAT_RETRY_MAX_MS = 5000;
const RUNNING_PROGRESS_MIN_ROW_STEP = 100;
const RUNNING_PROGRESS_MIN_INTERVAL_MS = 500;
const MODE_INSERT = 'insert';
const MODE_UPDATE = 'update';
const MODE_UPSERT = 'upsert';
const MODE_EMPTY = 'empty';

// 延迟函数:返回一个在指定毫秒后 resolve 的 Promise
// @param {number} ms - 延迟的毫秒数
// @returns {Promise<void>}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 并发执行任务队列,限制并发数量
// @param {Array<Function>} tasks - 异步任务函数数组
// @param {number} limit - 最大并发数
// @returns {Promise<void>}
async function runConcurrent(tasks, limit) {
  let index = 0; // 当前任务索引
  // 工作线程函数:循环执行任务直到队列为空
  async function worker() {
    while (index < tasks.length) {
      const current = index; // 获取当前任务索引
      index += 1; // 索引递增
      await tasks[current](); // 执行任务
    }
  }
  const workers = []; // 工作线程数组
  // 创建指定数量的工作线程(不超过任务总数)
  for (let i = 0; i < Math.min(limit, tasks.length); i += 1) {
    workers.push(worker());
  }
  // 等待所有工作线程完成
  await Promise.all(workers);
}

// 标准化文本:转为字符串、去除首尾空格、转小写
// @param {any} value - 输入值
// @returns {string} - 标准化后的字符串
function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

// 分割单元格值:按多种分隔符(|;,/换行制表符)分割字符串
// @param {any} raw - 原始值
// @returns {Array<string>} - 分割后的非空字符串数组
function splitCellValues(raw) {
  return String(raw || '')
    .split(/[|;,/\n\r\t]+/) // 按分隔符分割
    .map((item) => item.trim()) // 去除每项的首尾空格
    .filter(Boolean); // 过滤空字符串
}

// 从字符串中提取 Lark 记录 ID(格式:rec 开头 + 字母数字)
// @param {any} raw - 原始值
// @returns {string} - 提取的记录 ID,未找到返回空字符串
function extractRecordId(raw) {
  const matched = String(raw || '').match(/rec[a-z0-9]+/i); // 正则匹配 rec 开头的 ID
  return matched ? matched[0] : ''; // 返回匹配结果或空字符串
}

// 解析数值:移除千分位逗号并转换为数字
// @param {any} raw - 原始值
// @param {string} fieldName - 字段名(用于错误提示)
// @returns {number} - 解析后的数字
// @throws {Error} - 如果无法解析为有效数字
function parseNumberValue(raw, fieldName) {
  const normalized = String(raw).replace(/,/g, '').trim(); // 移除逗号并去空格
  const value = Number(normalized); // 转换为数字
  if (!Number.isFinite(value)) { // 检查是否为有效数字
    throw new Error(`フィールド "${fieldName}" は数値を求めていますが、"${raw}" が入力されました。`);
  }
  return value;
}

// 解析日期时间值:支持多种格式(ISO、紧凑格式 YYYYMMDD、Unix 时间戳)
// @param {any} raw - 原始值
// @param {string} fieldName - 字段名(用于错误提示)
// @returns {number} - Unix 时间戳(毫秒)
// @throws {Error} - 如果无法解析为有效日期
function parseDateTimeValue(raw, fieldName) {
  const source = String(raw).trim();
  if (!source) { // 空值检查
    throw new Error(`フィールド "${fieldName}" は日時を求めていますが、空の値が入力されました。`);
  }

  // 仅允许日期格式,并且要求分隔符前后一致
  const dateMatch = source.match(/^(\d{4})([/-])(\d{1,2})\2(\d{1,2})$/);
  if (!dateMatch) {
    throw new Error(
      `フィールド "${fieldName}" は YYYY/MM/DD または YYYY-MM-DD 形式のみ対応していますが、"${raw}" が入力されました。`
    );
  }

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[3]);
  const day = Number(dateMatch[4]);
  const date = new Date(year, month - 1, day);

  // 验证日期有效性,避免 2026/02/30 这类值被 Date 自动进位
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    throw new Error(
      `フィールド "${fieldName}" は有効な YYYY/MM/DD または YYYY-MM-DD 日付のみ対応していますが、"${raw}" が入力されました。`
    );
  }

  return date.getTime();
}

// 解析布尔值:支持多种真假值表示
// @param {any} raw - 原始值
// @param {string} fieldName - 字段名(用于错误提示)
// @returns {boolean} - 解析后的布尔值
// @throws {Error} - 如果无法识别为布尔值
function parseBooleanValue(raw, fieldName) {
  const normalized = String(raw).trim().toLowerCase(); // 标准化为小写
  const trueSet = new Set(['1', 'true', 'yes', 'y', 'on']); // 真值集合
  const falseSet = new Set(['0', 'false', 'no', 'n', 'off']); // 假值集合
  if (trueSet.has(normalized)) return true; // 匹配真值
  if (falseSet.has(normalized)) return false; // 匹配假值
  throw new Error(`フィールド "${fieldName}" はブール値（真偽）を求めていますが、"${raw}" が入力されました。`);
}

// 判断字段是否为关联字段(Link 类型)
// @param {Object} meta - 字段元数据对象
// @returns {boolean} - 是否为关联字段
function isLinkField(meta) {
  if (!meta || typeof meta !== 'object') return false; // 元数据无效
  const property = meta.property; // 获取字段属性
  if (!property || typeof property !== 'object') return false; // 属性无效
  // 关联字段的 property 包含 table_id 或 tableId
  return Boolean(property.table_id || property.tableId);
}

// 获取关联字段指向的目标表 ID
// @param {Object} meta - 字段元数据对象
// @returns {string} - 目标表 ID,未找到返回空字符串
function getLinkTableId(meta) {
  if (!meta || !meta.property) return ''; // 元数据或属性无效
  return meta.property.table_id || meta.property.tableId || ''; // 返回表 ID
}

/**
 * 处理分页 token 重复问题
 * 当 Lark API 返回重复的 page_token 时,进行重试或抛出错误
 *
 * @param {Object} params - 参数对象
 * @param {string} params.stageLabel - 阶段标签(用于日志)
 * @param {string} params.currentToken - 当前 page_token
 * @param {string} params.nextPageToken - 下一个 page_token
 * @param {boolean} params.hasMore - 是否还有更多数据
 * @param {Set} params.seenPageTokens - 已见过的 token 集合
 * @param {number} params.repeatRetryCount - 当前重试次数
 * @returns {Object} - 决策结果 { retry, nextPageToken, repeatRetryCount, waitMs }
 * @throws {Error} - 如果超过最大重试次数
 *
 * 重试策略:
 * - 指数退避:500ms * 2^(attempt-1)
 * - 最大等待时间:5000ms
 * - 最大重试次数:5 次
 */
function resolveNextPageToken({
  stageLabel,
  currentToken,
  nextPageToken,
  hasMore,
  seenPageTokens,
  repeatRetryCount,
}) {
  // 如果没有更多数据,返回空 token
  if (!hasMore) {
    return {
      retry: false,
      nextPageToken: '',
      repeatRetryCount: 0,
      waitMs: 0,
    };
  }

  // 如果 has_more=true 但 page_token 为空,抛出错误
  if (!nextPageToken) {
    throw new Error(`${stageLabel} aborted: Lark API returned has_more=true but page_token is empty`);
  }

  // 检查 token 是否重复
  const repeated = nextPageToken === currentToken || seenPageTokens.has(nextPageToken);

  if (!repeated) {
    // token 未重复,记录并继续
    seenPageTokens.add(nextPageToken);
    return {
      retry: false,
      nextPageToken,
      repeatRetryCount: 0,
      waitMs: 0,
    };
  }

  // token 重复,准备重试
  const attempt = repeatRetryCount + 1;

  // 检查是否超过最大重试次数
  if (attempt > PAGE_TOKEN_REPEAT_RETRY_LIMIT) {
    throw new Error(
      `${stageLabel} aborted: repeated next page token returned by Lark API (${nextPageToken}) after ${PAGE_TOKEN_REPEAT_RETRY_LIMIT} retries`
    );
  }

  // 计算等待时间(指数退避)
  const waitMs = Math.min(
    PAGE_TOKEN_REPEAT_RETRY_MAX_MS,
    PAGE_TOKEN_REPEAT_RETRY_BASE_MS * 2 ** (attempt - 1)
  );

  // 输出警告日志
  process.stdout.write(
    `[warn] ${stageLabel}: repeated next page token (${nextPageToken}), retry ${attempt}/${PAGE_TOKEN_REPEAT_RETRY_LIMIT}\n`
  );

  return {
    retry: true,              // 需要重试
    nextPageToken: currentToken, // 使用当前 token 重试
    repeatRetryCount: attempt,   // 更新重试次数
    waitMs,                      // 等待时间
  };
}

/**
 * 构建关联字段解析器
 * 扫描关联表,建立"文本值 -> 记录ID"的映射,用于自动解析关联字段
 *
 * @param {LarkApiClient} client - Lark API 客户端
 * @param {string} appToken - Base 应用 token
 * @param {Map} fieldMetaByName - 字段元数据映射表
 * @param {Array} allMappings - 所有字段映射(key + update + insert)
 * @param {Function} onProgress - 进度回调函数
 * @returns {Promise<Map>} - 解析器映射表(字段名 -> resolver)
 *
 * Resolver 结构:
 * {
 *   linkedTableId: 'tbl...',      // 关联表 ID
 *   searchableFields: ['Name'],   // 可搜索字段列表
 *   valueToIds: Map<string, string> // 值 -> 记录ID 映射
 * }
 *
 * 工作流程:
 * 1. 遍历所有映射,找出关联字段
 * 2. 获取关联表的字段列表
 * 3. 筛选可搜索字段(文本、数字、电话、URL、场所)
 * 4. 全量扫描关联表,建立值到记录ID的映射
 * 5. 处理分页和去重
 *
 * 性能优化:
 * - 每个关联表只扫描一次
 * - 使用 Set 去重记录ID
 * - 每 5000 条输出一次进度
 */
async function buildLinkResolvers(client, appToken, fieldMetaByName, allMappings, onProgress) {
  const resolvers = new Map(); // 解析器映射表
  const seen = new Set();      // 已处理的字段名集合

  // 获取所有表格列表以匹配表名
  const allTables = await client.listTables(appToken);

  // 目标系统配置: 特定表名及对应的必须要获取的项目字段
  const TARGET_FIELDS_MAP = {
    '顧客管理': ['需要家コード', '顧客名', '顧客名（カナ）'],
    '事業所マスタ': ['事務所名'],
    '従業員マスタ': ['社員番号', '社員氏名', '社員氏名(かな)'],
    '案件管理': ['案件コード', '案件名'],
  };

  // 遍历所有映射,找出关联字段
  for (const mapping of allMappings) {
    const fieldMeta = fieldMetaByName.get(normalizeText(mapping.fieldName));

    // 跳过非关联字段
    if (!fieldMeta || !isLinkField(fieldMeta)) continue;

    const linkedTableId = getLinkTableId(fieldMeta);

    // 跳过无效或已处理的字段
    if (!linkedTableId || seen.has(normalizeText(mapping.fieldName))) continue;

    // 查找表名
    const linkedTable = allTables.find((t) => t.table_id === linkedTableId);
    if (!linkedTable || !linkedTable.name) {
      throw new Error(`关联表解析失败: 无法找到 table_id 为 ${linkedTableId} 的关联表名称`);
    }

    // 标准化表名用于匹配 (移除空格)
    const normalizedLinkedTableName = String(linkedTable.name).replace(/\s+/g, '');

    // 查找对应的配置项 (也忽略配置字典 key 的空格)
    let requiredFields = null;
    let matchedTableName = '';
    for (const [tableName, fields] of Object.entries(TARGET_FIELDS_MAP)) {
      if (tableName.replace(/\s+/g, '') === normalizedLinkedTableName) {
        requiredFields = fields;
        matchedTableName = tableName;
        break;
      }
    }

    if (!requiredFields) {
      throw new Error(`关联表解析失败: 关联表 "${linkedTable.name}" 不在支持的配置范围内 (支持: ${Object.keys(TARGET_FIELDS_MAP).join(', ')})`);
    }

    seen.add(normalizeText(mapping.fieldName));

    process.stdout.write(
      `[link] resolving link field "${mapping.fieldName}" -> table ${matchedTableName} (${linkedTableId})\n`
    );

    // 获取关联表的字段列表
    const linkedFields = await client.listFields(appToken, linkedTableId);

    // 强制筛选可搜索字段为 requiredFields 中的指定项目
    const searchableFields = linkedFields
      .map((f) => f.field_name)
      .filter((fieldName) => {
        // 忽略大小写和空格进行匹配
        const normalizedName = normalizeText(fieldName).replace(/\s+/g, '');
        return requiredFields.some((reqField) => normalizeText(reqField).replace(/\s+/g, '') === normalizedName);
      });

    // 如果没有能匹配上的必须字段,抛出错误
    if (searchableFields.length === 0) {
      throw new Error(`关联表解析失败: 在关联表 "${matchedTableName}" 中无法找到任何需要的特定字段 (${requiredFields.join(', ')})`);
    }

    process.stdout.write(
      `[link] scanning linked table ${linkedTableId} with fields: ${searchableFields.join(', ')}\n`
    );

    // 建立值到记录ID的映射
    const valueToIds = new Map();
    const seenPageTokens = new Set();  // 已见过的分页 token
    const seenRecordIds = new Set();   // 已见过的记录ID(去重)
    let pageToken = '';
    let hasMore = true;
    let repeatRetryCount = 0;
    let scanned = 0;        // 已扫描的唯一记录数
    let duplicateCount = 0; // 重复记录数

    // 分页扫描关联表
    while (hasMore) {
      const currentToken = String(pageToken || '');

      // 调用 search API 获取记录
      const data = await client.searchRecords(appToken, linkedTableId, {
        pageToken,
        pageSize: 500,
        fieldNames: searchableFields,
      });

      const items = Array.isArray(data.items) ? data.items : [];

      // 处理每条记录
      for (const item of items) {
        const recordId = item.record_id;
        if (!recordId) continue;

        // 去重检查
        if (seenRecordIds.has(recordId)) {
          duplicateCount += 1;
          continue;
        }
        seenRecordIds.add(recordId);

        const fields = item.fields || {};

        // 遍历所有可搜索字段
        for (const sf of searchableFields) {
          const val = fields[sf];
          if (!val) continue;

          // 提取文本值(支持多种数据类型)
          let textVal = '';
          if (typeof val === 'string') {
            textVal = val.trim();
          } else if (typeof val === 'number') {
            textVal = String(val);
          } else if (Array.isArray(val)) {
            textVal = val.map((v) => (v && v.text ? v.text : String(v || ''))).join('').trim();
          } else if (val && typeof val === 'object' && val.text) {
            textVal = String(val.text).trim();
          }

          if (!textVal) continue;

          // 标准化为小写作为 key
          const key = normalizeText(textVal);
          if (!key) continue;

          // 只保存第一次出现的映射(避免一对多冲突)
          const existing = valueToIds.get(key);
          if (!existing) {
            valueToIds.set(key, recordId);
          }
        }

        scanned += 1;
      }

      // 每 5000 条输出一次进度
      if (scanned > 0 && scanned % 5000 === 0) {
        process.stdout.write(
          `[link] scanned ${scanned} unique records in linked table` +
          (duplicateCount > 0 ? ` (deduped ${duplicateCount})` : '') +
          '\n'
        );
      }

      // 处理分页
      hasMore = Boolean(data.has_more);
      const nextPageToken = data.page_token || '';

      const pageDecision = resolveNextPageToken({
        stageLabel: `[link:${mapping.fieldName}]`,
        currentToken,
        nextPageToken,
        hasMore,
        seenPageTokens,
        repeatRetryCount,
      });

      repeatRetryCount = pageDecision.repeatRetryCount;

      if (pageDecision.retry) {
        await sleep(pageDecision.waitMs);
        continue;
      }

      pageToken = pageDecision.nextPageToken;
    }

    // 输出完成日志
    process.stdout.write(
      `[link] built resolver for "${mapping.fieldName}": ${valueToIds.size} unique values from ${scanned} records` +
      (duplicateCount > 0 ? ` (deduped ${duplicateCount})` : '') +
      '\n'
    );

    // 保存解析器
    resolvers.set(normalizeText(mapping.fieldName), {
      linkedTableId,
      searchableFields,
      valueToIds,
    });
  }

  return resolvers;
}

/**
 * 转换原始值为 Lark 字段值
 * 根据字段类型进行智能转换
 *
 * @param {any} raw - 原始值(来自 CSV)
 * @param {Object} fieldMeta - 字段元数据
 * @param {string} fieldName - 字段名(用于错误提示)
 * @param {Map} linkResolvers - 关联字段解析器映射表
 * @returns {any} - 转换后的值
 * @throws {Error} - 如果转换失败
 *
 * 支持的字段类型:
 * - 关联字段(Link): 解析为记录ID数组
 * - 数字(type=2): 解析为数字
 * - 日期时间(type=5): 解析为 Unix 时间戳(毫秒)
 * - 布尔(type=7): 解析为 true/false
 * - 多选(type=4): 分割为字符串数组
 * - 其他: 保持原始文本
 *
 * 关联字段解析策略:
 * 1. 优先尝试提取 rec 开头的记录ID
 * 2. 如果没有记录ID,使用解析器查找文本值对应的记录ID
 * 3. 如果解析器不存在或找不到匹配,抛出错误
 */
function convertRawValue(raw, fieldMeta, fieldName, linkResolvers) {
  // 标准化为文本
  const text = typeof raw === 'string' ? raw.trim() : String(raw || '').trim();
  if (!text) return ''; // 空值返回空字符串

  // 处理关联字段
  if (isLinkField(fieldMeta)) {
    const tokens = splitCellValues(text); // 分割多个值

    // 尝试提取记录ID(rec 开头)
    const recordIds = tokens.map((token) => extractRecordId(token)).filter(Boolean);
    if (recordIds.length > 0) {
      return recordIds; // 直接返回记录ID数组
    }

    // 使用解析器查找记录ID
    const resolver = linkResolvers && linkResolvers.get(normalizeText(fieldName));
    if (resolver) {
      const resolved = [];
      for (const token of tokens) {
        const key = normalizeText(token);
        if (!key) continue;

        const recordId = resolver.valueToIds.get(key);
        if (recordId) {
          resolved.push(recordId);
        }
      }

      if (resolved.length > 0) {
        return resolved; // 返回解析后的记录ID数组
      }

      // 无法解析,抛出错误
      throw new Error(
        `field "${fieldName}" could not resolve "${text}" in linked table ${resolver.linkedTableId} via fields [${resolver.searchableFields.join(', ')}]`
      );
    }

    // 解析器不存在,抛出错误
    throw new Error(
      `フィールド "${fieldName}" はリンクですが、対象のリゾルバがありません。入力値: ${raw}`
    );
  }

  // 根据字段类型转换
  const type = Number(fieldMeta.type);

  if (type === 2) {
    // 数字类型
    return parseNumberValue(text, fieldName);
  }

  if (type === 5) {
    // 日期时间类型
    return parseDateTimeValue(text, fieldName);
  }

  if (type === 7) {
    // 布尔类型
    return parseBooleanValue(text, fieldName);
  }

  if (type === 4) {
    // 多选类型
    return splitCellValues(text);
  }

  // 其他类型,返回原始文本
  return text;
}

/**
 * 构建字段元数据映射表
 * 将字段元数据数组转换为 Map,以字段名(小写)为 key
 *
 * @param {Array<Object>} fieldMetas - 字段元数据数组
 * @returns {Map<string, Object>} - 字段名 -> 元数据的映射表
 *
 * 处理逻辑:
 * - 规范化字段名(转小写)作为 key
 * - 如果字段名重复,保留第一个
 * - 忽略无效的元数据对象
 *
 * @example
 * const metas = [
 *   { field_name: 'Name', type: 1 },
 *   { field_name: 'Age', type: 2 }
 * ];
 * const map = buildFieldMetaByName(metas);
 * map.get('name') // 返回 { field_name: 'Name', type: 1 }
 */
function buildFieldMetaByName(fieldMetas) {
  const map = new Map();
  (fieldMetas || []).forEach((meta) => {
    const name = normalizeText(meta && meta.field_name);
    if (!name || map.has(name)) return; // 跳过空名称或重复字段
    map.set(name, meta);
  });
  return map;
}

/**
 * 将值转换为可比较的字符串
 * 用于构建主键和比较字段值
 *
 * @param {any} value - 要转换的值
 * @returns {string} - 可比较的字符串表示
 *
 * 转换规则:
 * - null/undefined: 返回空字符串
 * - 字符串: 去除首尾空格
 * - 数字/布尔: 转换为字符串
 * - 数组: 递归转换每项,用 | 连接
 * - 对象: 优先提取 text/name/id 属性,否则 JSON 序列化
 *
 * @example
 * toComparable('  hello  ') // 返回 'hello'
 * toComparable([1, 2, 3]) // 返回 '1|2|3'
 * toComparable({ text: 'foo' }) // 返回 'foo'
 */
function toComparable(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => toComparable(item))
      .filter(Boolean)
      .join('|');
  }
  if (typeof value === 'object') {
    if (value.text) return String(value.text).trim();
    if (value.name) return String(value.name).trim();
    if (value.id) return String(value.id).trim();
    return JSON.stringify(value);
  }
  return String(value).trim();
}

/**
 * 连接主键部分为复合键
 * 使用特殊分隔符连接多个主键部分
 *
 * @param {Array<string>} parts - 主键部分数组
 * @returns {string} - 连接后的复合键
 *
 * 分隔符: ||#||
 * - 使用不常见的分隔符,避免与实际数据冲突
 * - 每个部分都会规范化(转小写)
 *
 * @example
 * joinKey(['ABC', '123']) // 返回 'abc||#||123'
 */
function joinKey(parts) {
  return parts.map((item) => normalizeText(item)).join('||#||');
}

/**
 * 从 API 响应中提取创建的记录 ID
 * 支持多种响应格式
 *
 * @param {Object} payload - API 响应对象
 * @returns {Array<string>} - 记录 ID 数组
 *
 * 支持的响应格式:
 * - { records: [{ record_id: '...' }] }
 * - { items: [{ record_id: '...' }] }
 * - { record: { record_id: '...' } }
 *
 * 字段名兼容:
 * - record_id (标准)
 * - recordId (驼峰)
 * - id (简写)
 *
 * @example
 * extractCreatedRecordIds({ records: [{ record_id: 'rec123' }] })
 * // 返回 ['rec123']
 */
function extractCreatedRecordIds(payload) {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.records)) {
    return payload
      .records
      .map((item) => item && (item.record_id || item.recordId || item.id))
      .filter(Boolean);
  }
  if (Array.isArray(payload.items)) {
    return payload
      .items
      .map((item) => item && (item.record_id || item.recordId || item.id))
      .filter(Boolean);
  }
  if (payload.record && payload.record.record_id) {
    return [payload.record.record_id];
  }
  return [];
}

/**
 * 将错误对象转换为错误消息字符串
 *
 * @param {Error|any} error - 错误对象
 * @returns {string} - 错误消息
 *
 * @example
 * toErrorMessage(new Error('test')) // 返回 'test'
 * toErrorMessage('error string') // 返回 'error string'
 */
function toErrorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 触发进度回调
 * 安全地调用进度回调函数,忽略回调中的错误
 *
 * @param {Function} onProgress - 进度回调函数
 * @param {Object} payload - 进度数据
 *
 * 安全处理:
 * - 检查回调是否为函数
 * - 捕获并忽略回调中的所有错误
 * - 确保回调错误不会中断同步流程
 *
 * @example
 * emitProgress(onProgress, {
 *   phase: 'running',
 *   message: 'Processing...',
 *   stats: { processedRows: 100 }
 * });
 */
function emitProgress(onProgress, payload) {
  if (typeof onProgress !== 'function') return;
  try {
    onProgress(payload);
  } catch {
    // 忽略进度回调错误
  }
}

/**
 * 检查主键部分是否包含空值
 *
 * @param {Array<string>} parts - 主键部分数组
 * @returns {boolean} - 是否包含空值
 *
 * 空值定义:
 * - 空字符串
 * - 仅包含空格的字符串
 *
 * @example
 * hasEmptyKeyPart(['abc', '']) // 返回 true
 * hasEmptyKeyPart(['abc', '123']) // 返回 false
 */
function hasEmptyKeyPart(parts) {
  return parts.some((part) => !String(part).trim());
}

/**
 * 从记录对象中提取记录 ID
 * 支持多种字段名格式
 *
 * @param {Object} item - 记录对象
 * @returns {string} - 记录 ID,未找到返回空字符串
 *
 * 支持的字段名:
 * - record_id (标准)
 * - recordId (驼峰)
 * - id (简写)
 *
 * @example
 * getRecordIdFromItem({ record_id: 'rec123' }) // 返回 'rec123'
 * getRecordIdFromItem({ id: 'rec456' }) // 返回 'rec456'
 */
function getRecordIdFromItem(item) {
  if (!item || typeof item !== 'object') return '';
  return item.record_id || item.recordId || item.id || '';
}

/**
 * 判断错误是否为重复分页 token 错误
 *
 * @param {Error|any} error - 错误对象
 * @returns {boolean} - 是否为重复 token 错误
 *
 * 检查逻辑:
 * - 提取错误消息
 * - 检查是否包含 "repeated next page token" 或 "repeated page token"
 *
 * @example
 * isRepeatedPageTokenError(new Error('repeated next page token'))
 * // 返回 true
 */
function isRepeatedPageTokenError(error) {
  const message = toErrorMessage(error);
  return message.includes('repeated next page token') || message.includes('repeated page token');
}

/**
 * 构建统计对象
 * 初始化同步统计信息
 *
 * @param {Object} params - 同步参数
 * @returns {Object} - 统计对象
 *
 * 统计字段:
 * - csvPath: CSV 文件绝对路径
 * - tableId: 目标表格 ID
 * - mode: 同步模式
 * - totalRows: CSV 总行数(不含表头)
 * - skippedRows: 跳过的行数
 * - failedRows: 失败的行数
 * - insertedRows: 插入的行数
 * - updatedRows: 更新的行数
 * - indexedRows: 索引的行数
 * - processedRows: 已处理的行数
 * - estimatedTotalRows: 预估总行数
 * - startedAt: 开始时间(ISO 格式)
 * - endedAt: 结束时间(ISO 格式)
 * - failures: 失败记录数组
 *
 * @example
 * const stats = buildStats({ csvPath: 'data.csv', tableId: 'tbl123', mode: 'upsert' });
 */
function buildStats(params) {
  return {
    csvPath: path.resolve(params.csvPath),
    tableId: params.tableId,
    mode: params.mode,
    totalRows: 0,
    skippedRows: 0,
    failedRows: 0,
    insertedRows: 0,
    updatedRows: 0,
    indexedRows: 0,
    processedRows: 0,
    estimatedTotalRows: 0,
    startedAt: new Date().toISOString(),
    endedAt: '',
    failures: [],
  };
}

/**
 * 添加失败记录
 * 将失败的行记录到统计对象中
 *
 * @param {Object} stats - 统计对象
 * @param {number} rowNumber - 行号
 * @param {string} reason - 失败原因
 * @param {Object} rowData - 行数据(可选)
 *
 * 副作用:
 * - stats.failedRows 递增
 * - 失败记录添加到 stats.failures 数组
 *
 * @example
 * pushFailure(stats, 10, 'キー値が空です', { name: 'test' });
 */
function pushFailure(stats, rowNumber, reason, rowData) {
  stats.failedRows += 1;
  stats.failures.push({ rowNumber, reason, rowData: rowData || null });
}

/**
 * 从更新映射中过滤掉主键字段
 * 防止更新操作修改主键字段
 *
 * @param {Array<Object>} updateMappings - 更新字段映射
 * @param {Array<Object>} keyMappings - 主键字段映射
 * @returns {Object} - { filtered: 过滤后的映射, blocked: 被阻止的字段名 }
 *
 * 过滤逻辑:
 * - 提取所有主键字段名
 * - 从更新映射中移除主键字段
 * - 返回过滤后的映射和被阻止的字段名列表
 *
 * @example
 * const result = filterKeyFieldsFromUpdateMappings(
 *   [{ fieldName: 'Name' }, { fieldName: 'Code' }],
 *   [{ fieldName: 'Code' }]
 * );
 * // result.filtered: [{ fieldName: 'Name' }]
 * // result.blocked: ['Code']
 */
function filterKeyFieldsFromUpdateMappings(updateMappings, keyMappings) {
  const keyFieldNames = new Set(
    (Array.isArray(keyMappings) ? keyMappings : []).map((m) => normalizeText(m.fieldName))
  );
  if (keyFieldNames.size === 0) return { filtered: updateMappings, blocked: [] };

  const filtered = [];
  const blocked = [];

  (Array.isArray(updateMappings) ? updateMappings : []).forEach((mapping) => {
    if (keyFieldNames.has(normalizeText(mapping.fieldName))) {
      blocked.push(mapping.fieldName);
      return;
    }
    filtered.push(mapping);
  });

  return { filtered, blocked };
}

/**
 * 验证字段映射
 * 检查映射中的字段是否都存在于表格中
 *
 * @param {Array<string>} fieldNames - 表格中的字段名列表
 * @param {Array<Object>} keyMappings - 主键映射
 * @param {Array<Object>} updateMappings - 更新映射
 * @param {Array<Object>} insertMappings - 插入映射
 * @throws {Error} - 如果发现不存在的字段
 *
 * 验证逻辑:
 * - 构建字段名映射表(不区分大小写)
 * - 检查主键映射中的字段
 * - 检查更新映射中的字段
 * - 检查插入映射中的字段
 * - 如果发现不存在的字段,抛出错误
 *
 * @example
 * validateMappings(
 *   ['Name', 'Age'],
 *   [{ fieldName: 'Name' }],
 *   [{ fieldName: 'Age' }],
 *   []
 * );
 */
function validateMappings(fieldNames, keyMappings, updateMappings, insertMappings) {
  const normalizedFieldNames = new Map(
    fieldNames.map((name) => [normalizeText(name), name])
  );

  const missingKeyField = keyMappings.find(
    (mapping) => !normalizedFieldNames.has(normalizeText(mapping.fieldName))
  );
  if (missingKeyField) {
    throw new Error(`Key field does not exist in table: ${missingKeyField.fieldName}`);
  }

  const missingUpdateField = updateMappings.find(
    (mapping) => !normalizedFieldNames.has(normalizeText(mapping.fieldName))
  );
  if (missingUpdateField) {
    throw new Error(`Update field does not exist in table: ${missingUpdateField.fieldName}`);
  }

  const missingInsertField = insertMappings.find(
    (mapping) => !normalizedFieldNames.has(normalizeText(mapping.fieldName))
  );
  if (missingInsertField) {
    throw new Error(`Insert field does not exist in table: ${missingInsertField.fieldName}`);
  }
}

/**
 * 从 CSV 行构建字段值对象
 * 根据映射关系提取并转换 CSV 行数据
 *
 * @param {Object} row - CSV 行对象(列名 -> 值)
 * @param {Array<Object>} valueMappings - 字段映射数组
 * @param {boolean} clearEmpty - 是否清空空值字段(设为 null)
 * @param {Map} fieldMetaByName - 字段元数据映射表
 * @param {Map} linkResolvers - 关联字段解析器
 * @returns {Object} - 字段名 -> 转换后的值
 *
 * 处理逻辑:
 * 1. 遍历所有映射
 * 2. 从 CSV 行中提取对应列的值
 * 3. 如果值为空:
 *    - clearEmpty=true: 设为 null(清空字段)
 *    - clearEmpty=false: 跳过该字段
 * 4. 如果值非空:
 *    - 查找字段元数据
 *    - 调用 convertRawValue 进行类型转换
 * 5. 返回字段值对象
 *
 * @example
 * const fields = buildFieldsFromRow(
 *   { Name: 'John', Age: '30' },
 *   [{ fieldName: 'Name', csvColumn: 'Name' }],
 *   false,
 *   fieldMetaByName,
 *   linkResolvers
 * );
 * // 返回: { Name: 'John' }
 */
function buildFieldsFromRow(row, valueMappings, clearEmpty, fieldMetaByName, linkResolvers) {
  const fields = {};
  valueMappings.forEach((mapping) => {
    const raw = row[mapping.csvColumn];
    const trimmed = typeof raw === 'string' ? raw.trim() : String(raw || '').trim();
    if (!trimmed) {
      if (clearEmpty) fields[mapping.fieldName] = null;
      return;
    }
    const fieldMeta = fieldMetaByName.get(normalizeText(mapping.fieldName));
    if (!fieldMeta) {
      fields[mapping.fieldName] = raw;
      return;
    }
    fields[mapping.fieldName] = convertRawValue(raw, fieldMeta, mapping.fieldName, linkResolvers);
  });
  return fields;
}

/**
 * 为 empty 模式构建字段值对象
 * 将所有映射字段设为 null,并记录非空字段
 *
 * @param {Object} row - CSV 行对象
 * @param {Array<Object>} valueMappings - 字段映射数组
 * @returns {Object} - { fields: 字段值对象, nonEmptyFields: 非空字段名数组 }
 *
 * empty 模式说明:
 * - 用于清空字段值
 * - 要求 CSV 中对应列必须为空
 * - 如果列非空,记录为错误
 *
 * @example
 * const result = buildFieldsForEmptyMode(
 *   { Name: '', Age: '30' },
 *   [{ fieldName: 'Name' }, { fieldName: 'Age' }]
 * );
 * // result.fields: { Name: null, Age: null }
 * // result.nonEmptyFields: ['Age']
 */
function buildFieldsForEmptyMode(row, valueMappings) {
  const fields = {};
  const nonEmptyFields = [];

  valueMappings.forEach((mapping) => {
    const raw = row[mapping.csvColumn];
    const trimmed = typeof raw === 'string' ? raw.trim() : String(raw || '').trim();
    if (!trimmed) {
      fields[mapping.fieldName] = null;
      return;
    }
    nonEmptyFields.push(mapping.fieldName);
  });

  return {
    fields,
    nonEmptyFields,
  };
}

/**
 * 从 CSV 行构建主键部分数组
 * 提取并转换主键字段的值
 *
 * @param {Object} row - CSV 行对象
 * @param {Array<Object>} keyMappings - 主键映射数组
 * @param {Map} fieldMetaByName - 字段元数据映射表
 * @param {Map} linkResolvers - 关联字段解析器
 * @returns {Array<string>} - 主键部分数组(可比较的字符串)
 *
 * 处理逻辑:
 * 1. 遍历主键映射
 * 2. 提取 CSV 列值
 * 3. 如果值为空,返回空字符串
 * 4. 如果值非空:
 *    - 查找字段元数据
 *    - 转换为 Lark 字段值
 *    - 转换为可比较的字符串
 * 5. 返回主键部分数组
 *
 * @example
 * const keyParts = buildKeyPartsFromRow(
 *   { Code: 'A001', Name: 'John' },
 *   [{ fieldName: 'Code', csvColumn: 'Code' }],
 *   fieldMetaByName,
 *   linkResolvers
 * );
 * // 返回: ['a001']
 */
function buildKeyPartsFromRow(row, keyMappings, fieldMetaByName, linkResolvers) {
  return keyMappings.map((mapping) => {
    const raw = row[mapping.csvColumn];
    const trimmed =
      typeof raw === 'string' ? raw.trim() : String(raw === undefined ? '' : raw).trim();
    if (!trimmed) return '';
    const fieldMeta = fieldMetaByName.get(normalizeText(mapping.fieldName));
    if (!fieldMeta) return toComparable(raw);
    return toComparable(convertRawValue(raw, fieldMeta, mapping.fieldName, linkResolvers));
  });
}

/**
 * 构建包含主键的插入字段对象
 * 合并当前字段和主键字段
 *
 * @param {Object} row - CSV 行对象
 * @param {Array<Object>} keyMappings - 主键映射数组
 * @param {Object} currentFields - 当前字段值对象
 * @param {Map} fieldMetaByName - 字段元数据映射表
 * @param {Map} linkResolvers - 关联字段解析器
 * @returns {Object} - 合并后的字段值对象
 *
 * 处理逻辑:
 * 1. 复制当前字段对象
 * 2. 遍历主键映射
 * 3. 如果字段已存在,跳过(避免覆盖)
 * 4. 如果字段不存在:
 *    - 提取 CSV 列值
 *    - 转换为 Lark 字段值
 *    - 添加到字段对象
 * 5. 返回合并后的字段对象
 *
 * 使用场景:
 * - upsert 模式下插入新记录
 * - 确保主键字段包含在插入数据中
 *
 * @example
 * const fields = buildInsertFieldsWithKey(
 *   { Code: 'A001', Name: 'John' },
 *   [{ fieldName: 'Code', csvColumn: 'Code' }],
 *   { Name: 'John' },
 *   fieldMetaByName,
 *   linkResolvers
 * );
 * // 返回: { Name: 'John', Code: 'A001' }
 */
function buildInsertFieldsWithKey(row, keyMappings, currentFields, fieldMetaByName, linkResolvers) {
  const fields = { ...currentFields };
  keyMappings.forEach((mapping) => {
    if (fields[mapping.fieldName] !== undefined) return;
    const raw = row[mapping.csvColumn];
    const trimmed = typeof raw === 'string' ? raw.trim() : String(raw || '').trim();
    if (!trimmed) return;
    const fieldMeta = fieldMetaByName.get(normalizeText(mapping.fieldName));
    if (!fieldMeta) {
      fields[mapping.fieldName] = raw;
      return;
    }
    fields[mapping.fieldName] = convertRawValue(raw, fieldMeta, mapping.fieldName, linkResolvers);
  });
  return fields;
}

/**
 * 判断是否因为没有可写字段而跳过
 *
 * @param {Object} fields - 字段值对象
 * @param {boolean} clearEmpty - 是否清空模式
 * @returns {boolean} - 是否应该跳过
 *
 * 跳过条件:
 * - clearEmpty=false 且 fields 为空对象
 * - 表示没有任何字段需要更新
 *
 * 不跳过条件:
 * - clearEmpty=true: 即使 fields 为空,也要执行(清空操作)
 * - fields 非空: 有字段需要更新
 *
 * @example
 * shouldSkipBecauseNoWritableField({}, false) // 返回 true
 * shouldSkipBecauseNoWritableField({}, true) // 返回 false
 * shouldSkipBecauseNoWritableField({ Name: 'John' }, false) // 返回 false
 */
function shouldSkipBecauseNoWritableField(fields, clearEmpty) {
  if (clearEmpty) return false;
  return Object.keys(fields).length === 0;
}

/**
 * 构建记录索引(使用 search API)
 * 扫描表格中的所有记录,建立主键到记录ID的映射
 *
 * @param {LarkApiClient} client - Lark API 客户端
 * @param {string} appToken - Base 应用 token
 * @param {string} tableId - 表格 ID
 * @param {Array<Object>} keyMappings - 主键映射数组
 * @param {Object} stats - 统计对象
 * @param {Function} onProgress - 进度回调函数
 * @returns {Promise<Object>} - { recordIndex, indexedCount, scannedCount, duplicateCount }
 *
 * 工作流程:
 * 1. 使用 search API 分页获取记录
 * 2. 提取主键字段值
 * 3. 构建复合主键
 * 4. 建立主键 -> 记录ID 的映射
 * 5. 处理重复记录和分页 token
 *
 * 返回对象:
 * - recordIndex: Map<主键, 记录ID数组>
 * - indexedCount: 索引的记录数(有效主键)
 * - scannedCount: 扫描的唯一记录数
 * - duplicateCount: 去重的记录数
 *
 * 性能优化:
 * - 每页 500 条记录
 * - 去重处理(避免重复扫描)
 * - 每 5000 条输出进度
 * - 处理分页 token 重复问题
 *
 * @example
 * const result = await buildRecordIndex(
 *   client, appToken, tableId, keyMappings, stats, onProgress
 * );
 * // result.recordIndex: Map { 'abc||#||123' => ['rec001'] }
 */
async function buildRecordIndex(client, appToken, tableId, keyMappings, stats, onProgress) {
  const recordIndex = new Map();      // 主键 -> 记录ID数组
  const seenPageTokens = new Set();   // 已见过的分页 token
  const seenRecordIds = new Set();    // 已见过的记录ID(去重)
  let pageToken = '';                 // 当前分页 token
  let hasMore = true;                 // 是否还有更多数据
  let repeatRetryCount = 0;           // 重复 token 重试次数
  let indexedCount = 0;               // 索引的记录数
  let scannedCount = 0;               // 扫描的唯一记录数
  let duplicateCount = 0;             // 重复记录数

  // 提取主键字段名
  const fieldNames = Array.from(new Set(keyMappings.map((mapping) => mapping.fieldName)));

  // 分页扫描记录
  while (hasMore) {
    const currentToken = String(pageToken || '');

    // 调用 search API 获取记录
    const data = await client.searchRecords(appToken, tableId, {
      pageToken,
      pageSize: 500,
      fieldNames,
    });
    const items = Array.isArray(data.items) ? data.items : [];

    // 处理每条记录
    for (const item of items) {
      const recordId = getRecordIdFromItem(item);
      if (!recordId) continue;

      // 去重检查
      if (seenRecordIds.has(recordId)) {
        duplicateCount += 1;
        continue;
      }
      seenRecordIds.add(recordId);
      scannedCount += 1;

      // 提取主键字段值
      const fields = item.fields || {};
      const keyParts = keyMappings.map((mapping) => toComparable(fields[mapping.fieldName]));

      // 跳过包含空主键的记录
      if (hasEmptyKeyPart(keyParts)) continue;

      // 构建复合主键
      const key = joinKey(keyParts);

      // 添加到索引(支持一对多)
      const current = recordIndex.get(key) || [];
      current.push(recordId);
      recordIndex.set(key, current);
      indexedCount += 1;
    }

    // 更新统计
    if (stats) {
      stats.indexedRows = indexedCount;
    }

    // 每 5000 条输出进度
    if (scannedCount > 0 && scannedCount % 5000 === 0) {
      process.stdout.write(
        `[index] scanned ${scannedCount} unique records, indexed ${indexedCount}` +
        (duplicateCount > 0 ? ` (deduped ${duplicateCount})` : '') +
        '\n'
      );
      emitProgress(onProgress, {
        phase: 'indexing',
        message: `Building key index... scanned ${scannedCount}, indexed ${indexedCount}`,
        stats,
      });
    }

    // 处理分页
    hasMore = Boolean(data.has_more);
    const nextPageToken = data.page_token || '';

    // 处理分页 token 重复问题
    const pageDecision = resolveNextPageToken({
      stageLabel: 'Index scan',
      currentToken,
      nextPageToken,
      hasMore,
      seenPageTokens,
      repeatRetryCount,
    });

    repeatRetryCount = pageDecision.repeatRetryCount;

    // 如果需要重试,等待后继续
    if (pageDecision.retry) {
      await sleep(pageDecision.waitMs);
      continue;
    }

    pageToken = pageDecision.nextPageToken;
  }

  return { recordIndex, indexedCount, scannedCount, duplicateCount };
}

/**
 * 构建记录索引(使用 list API,备用方案)
 * 当 search API 出现分页 token 重复问题时使用
 *
 * @param {LarkApiClient} client - Lark API 客户端
 * @param {string} appToken - Base 应用 token
 * @param {string} tableId - 表格 ID
 * @param {Array<Object>} keyMappings - 主键映射数组
 * @param {Object} stats - 统计对象
 * @param {Function} onProgress - 进度回调函数
 * @returns {Promise<Object>} - { recordIndex, indexedCount, scannedCount, duplicateCount }
 *
 * 与 buildRecordIndex 的区别:
 * - 使用 listRecords API 而非 searchRecords
 * - listRecords 返回所有字段,不能指定字段列表
 * - 作为 search API 失败时的备用方案
 *
 * 工作流程与 buildRecordIndex 相同
 *
 * @example
 * const result = await buildRecordIndexViaListRecords(
 *   client, appToken, tableId, keyMappings, stats, onProgress
 * );
 */
async function buildRecordIndexViaListRecords(client, appToken, tableId, keyMappings, stats, onProgress) {
  const recordIndex = new Map();
  const seenPageTokens = new Set();
  const seenRecordIds = new Set();
  let pageToken = '';
  let hasMore = true;
  let repeatRetryCount = 0;
  let indexedCount = 0;
  let scannedCount = 0;
  let duplicateCount = 0;

  // 分页扫描记录(使用 list API)
  while (hasMore) {
    const currentToken = String(pageToken || '');

    // 调用 list API 获取记录
    const data = await client.listRecords(appToken, tableId, {
      pageToken,
      pageSize: 500,
    });
    const items = Array.isArray(data.items) ? data.items : [];

    // 处理每条记录
    for (const item of items) {
      const recordId = getRecordIdFromItem(item);
      if (!recordId) continue;

      // 去重检查
      if (seenRecordIds.has(recordId)) {
        duplicateCount += 1;
        continue;
      }
      seenRecordIds.add(recordId);
      scannedCount += 1;

      // 提取主键字段值
      const fields = item.fields || {};
      const keyParts = keyMappings.map((mapping) => toComparable(fields[mapping.fieldName]));

      // 跳过包含空主键的记录
      if (hasEmptyKeyPart(keyParts)) continue;

      // 构建复合主键
      const key = joinKey(keyParts);

      // 添加到索引
      const current = recordIndex.get(key) || [];
      current.push(recordId);
      recordIndex.set(key, current);
      indexedCount += 1;
    }

    // 更新统计
    if (stats) {
      stats.indexedRows = indexedCount;
    }

    // 每 5000 条输出进度
    if (scannedCount > 0 && scannedCount % 5000 === 0) {
      process.stdout.write(
        `[index:fallback] scanned ${scannedCount} unique records, indexed ${indexedCount}` +
        (duplicateCount > 0 ? ` (deduped ${duplicateCount})` : '') +
        '\n'
      );
      emitProgress(onProgress, {
        phase: 'indexing',
        message: `Fallback indexing... scanned ${scannedCount}, indexed ${indexedCount}`,
        stats,
      });
    }

    // 处理分页
    hasMore = Boolean(data.has_more);
    const nextPageToken = data.page_token || '';

    // 处理分页 token 重复问题
    const pageDecision = resolveNextPageToken({
      stageLabel: 'Index fallback scan',
      currentToken,
      nextPageToken,
      hasMore,
      seenPageTokens,
      repeatRetryCount,
    });

    repeatRetryCount = pageDecision.repeatRetryCount;

    if (pageDecision.retry) {
      await sleep(pageDecision.waitMs);
      continue;
    }

    pageToken = pageDecision.nextPageToken;
  }

  return { recordIndex, indexedCount, scannedCount, duplicateCount };
}

/**
 * 刷新更新批次
 * 将累积的更新操作批量提交到 Lark API
 *
 * @param {Object} ctx - 客户端上下文对象
 * @param {boolean} forceSingle - 是否强制单条提交(默认 false)
 * @returns {Promise<void>}
 *
 * 上下文对象包含:
 * - client: Lark API 客户端
 * - appToken: Base 应用 token
 * - tableId: 表格 ID
 * - updateBatch: 更新批次数组
 * - stats: 统计对象
 * - saveProgress: 保存进度函数
 * - batchSize: 批次大小
 *
 * 工作流程:
 * 1. 取出所有待更新的记录
 * 2. 如果 forceSingle=true,逐条提交
 * 3. 否则,按 batchSize 分块
 * 4. 并发提交所有分块(最多 25 个并发)
 * 5. 如果批量提交失败,回退到单条提交
 * 6. 更新统计并保存进度
 *
 * 错误处理:
 * - 批量失败时自动回退到单条提交
 * - 单条失败时记录到 failures
 * - 确保部分失败不影响其他记录
 *
 * @example
 * await flushUpdateBatch(ctx, false);
 */
async function flushUpdateBatch(ctx, forceSingle = false) {
  const { client, appToken, tableId, updateBatch, stats, saveProgress, batchSize, logMessage } = ctx;
  if (updateBatch.length === 0) return; // 批次为空,直接返回

  // 取出所有待更新的记录
  const allItems = updateBatch.splice(0, updateBatch.length);

  // 强制单条提交模式
  if (forceSingle) {
    for (const item of allItems) {
      try {
        await client.batchUpdateRecords(appToken, tableId, [
          { record_id: item.recordId, fields: item.fields },
        ]);
        stats.updatedRows += 1;
      } catch (error) {
        pushFailure(stats, item.rowNumber, `更新失敗: ${toErrorMessage(error)}`, item.rowData);
      }
    }
    saveProgress();
    return;
  }

  // 按 batchSize 分块
  const chunks = [];
  for (let i = 0; i < allItems.length; i += batchSize) {
    chunks.push(allItems.slice(i, i + batchSize));
  }

  // 为每个分块创建任务
  const tasks = chunks.map((chunk) => async () => {
    // 构造请求记录数组
    const requestRecords = chunk.map((item) => ({
      record_id: item.recordId,
      fields: item.fields,
    }));

    // 单条记录,直接提交
    if (chunk.length === 1) {
      try {
        await client.batchUpdateRecords(appToken, tableId, requestRecords);
        stats.updatedRows += 1;
      } catch (error) {
        pushFailure(stats, chunk[0].rowNumber, `更新失敗: ${toErrorMessage(error)}`, chunk[0].rowData);
      }
      return;
    }

    // 多条记录,批量提交
    try {
      await client.batchUpdateRecords(appToken, tableId, requestRecords);
      stats.updatedRows += chunk.length;
    } catch (error) {
      // 批量失败,回退到单条提交
      logMessage(
        `[warn] update batch failed (${chunk.length}), fallback to single: ${toErrorMessage(error)}\n`
      );
      for (const item of chunk) {
        try {
          await client.batchUpdateRecords(appToken, tableId, [
            { record_id: item.recordId, fields: item.fields },
          ]);
          stats.updatedRows += 1;
        } catch (singleError) {
          pushFailure(stats, item.rowNumber, `更新失敗: ${toErrorMessage(singleError)}`, item.rowData);
        }
      }
    }
  });

  // 并发执行所有任务(最多 25 个并发)
  await runConcurrent(tasks, CONCURRENCY_WRITE);
  saveProgress();
}

/**
 * 刷新插入批次
 * 将累积的插入操作批量提交到 Lark API
 *
 * @param {Object} ctx - 客户端上下文对象
 * @param {boolean} forceSingle - 是否强制单条提交(默认 false)
 * @returns {Promise<void>}
 *
 * 上下文对象包含:
 * - client: Lark API 客户端
 * - appToken: Base 应用 token
 * - tableId: 表格 ID
 * - insertBatch: 插入批次数组
 * - stats: 统计对象
 * - saveProgress: 保存进度函数
 * - batchSize: 批次大小
 * - mode: 同步模式
 * - recordIndex: 记录索引(upsert 模式需要)
 * - pendingInsertByKey: 待插入记录映射(upsert 模式需要)
 *
 * 工作流程:
 * 1. 取出所有待插入的记录
 * 2. 清理 pendingInsertByKey 映射
 * 3. 如果 forceSingle=true,逐条提交
 * 4. 否则,按 batchSize 分块
 * 5. 并发提交所有分块(最多 25 个并发)
 * 6. 如果批量提交失败,回退到单条提交
 * 7. upsert 模式下,更新 recordIndex(记录新创建的记录ID)
 * 8. 更新统计并保存进度
 *
 * upsert 模式特殊处理:
 * - 提取创建的记录ID
 * - 更新 recordIndex,避免后续重复插入
 *
 * 错误处理:
 * - 批量失败时自动回退到单条提交
 * - 单条失败时记录到 failures
 * - 确保部分失败不影响其他记录
 *
 * @example
 * await flushInsertBatch(ctx, false);
 */
async function flushInsertBatch(ctx, forceSingle = false) {
  const {
    client,
    appToken,
    tableId,
    insertBatch,
    stats,
    saveProgress,
    batchSize,
    mode,
    recordIndex,
    pendingInsertByKey,
    logMessage,
  } = ctx;
  if (insertBatch.length === 0) return; // 批次为空,直接返回

  // 取出所有待插入的记录
  const allItems = insertBatch.splice(0, insertBatch.length);

  // 清理 pendingInsertByKey 映射
  allItems.forEach((item) => {
    if (item.key) pendingInsertByKey.delete(item.key);
  });

  // 强制单条提交模式
  if (forceSingle) {
    for (const item of allItems) {
      try {
        const data = await client.batchCreateRecords(appToken, tableId, [{ fields: item.fields }]);
        stats.insertedRows += 1;

        // upsert 模式:更新 recordIndex
        if (mode === MODE_UPSERT && item.key) {
          const createdIds = extractCreatedRecordIds(data);
          if (createdIds[0]) recordIndex.set(item.key, [createdIds[0]]);
        }
      } catch (error) {
        pushFailure(stats, item.rowNumber, `追加失敗: ${toErrorMessage(error)}`, item.rowData);
      }
    }
    saveProgress();
    return;
  }

  // 按 batchSize 分块
  const chunks = [];
  for (let i = 0; i < allItems.length; i += batchSize) {
    chunks.push(allItems.slice(i, i + batchSize));
  }

  // 为每个分块创建任务
  const tasks = chunks.map((chunk) => async () => {
    // 构造请求记录数组
    const requestRecords = chunk.map((item) => ({
      fields: item.fields,
    }));

    // 单条记录,直接提交
    if (chunk.length === 1) {
      try {
        const data = await client.batchCreateRecords(appToken, tableId, requestRecords);
        stats.insertedRows += 1;

        // upsert 模式:更新 recordIndex
        if (mode === MODE_UPSERT && chunk[0].key) {
          const createdIds = extractCreatedRecordIds(data);
          if (createdIds[0]) recordIndex.set(chunk[0].key, [createdIds[0]]);
        }
      } catch (error) {
        pushFailure(stats, chunk[0].rowNumber, `追加失敗: ${toErrorMessage(error)}`, chunk[0].rowData);
      }
      return;
    }

    // 多条记录,批量提交
    try {
      const data = await client.batchCreateRecords(appToken, tableId, requestRecords);
      stats.insertedRows += chunk.length;

      // upsert 模式:批量更新 recordIndex
      if (mode === MODE_UPSERT) {
        const createdIds = extractCreatedRecordIds(data);
        chunk.forEach((item, index) => {
          if (!item.key) return;
          const createdId = createdIds[index];
          if (createdId) recordIndex.set(item.key, [createdId]);
        });
      }
    } catch (error) {
      // 批量失败,回退到单条提交
      logMessage(
        `[warn] insert batch failed (${chunk.length}), fallback to single: ${toErrorMessage(error)}\n`
      );
      for (const item of chunk) {
        try {
          const data = await client.batchCreateRecords(appToken, tableId, [{ fields: item.fields }]);
          stats.insertedRows += 1;

          // upsert 模式:更新 recordIndex
          if (mode === MODE_UPSERT && item.key) {
            const createdIds = extractCreatedRecordIds(data);
            if (createdIds[0]) recordIndex.set(item.key, [createdIds[0]]);
          }
        } catch (singleError) {
          pushFailure(stats, item.rowNumber, `追加失敗: ${toErrorMessage(singleError)}`, item.rowData);
        }
      }
    }
  });

  // 并发执行所有任务(最多 25 个并发)
  await runConcurrent(tasks, CONCURRENCY_WRITE);
  saveProgress();
}

/**
 * 创建客户端上下文对象
 * 封装同步操作所需的所有上下文信息
 *
 * @param {Object} params - 同步参数
 * @param {Object} stats - 统计对象
 * @param {Map} recordIndex - 记录索引
 * @param {Array} insertBatch - 插入批次数组
 * @param {Array} updateBatch - 更新批次数组
 * @param {Object} rowCounterRef - 行计数器引用对象
 * @returns {Object} - 客户端上下文对象
 *
 * 上下文对象包含:
 * - client: Lark API 客户端
 * - appToken: Base 应用 token
 * - tableId: 表格 ID
 * - mode: 同步模式
 * - batchSize: 批次大小(默认 500)
 * - stats: 统计对象
 * - recordIndex: 记录索引
 * - pendingInsertByKey: 待插入记录映射
 * - insertBatch: 插入批次数组
 * - updateBatch: 更新批次数组
 * - saveProgress: 保存进度函数
 *
 * saveProgress 函数:
 * - 保存检查点到文件
 * - 包含当前进度和统计信息
 * - 用于断点续传
 *
 * @example
 * const ctx = createClientContext(
 *   params, stats, recordIndex, insertBatch, updateBatch, rowCounterRef
 * );
 */
function createClientContext(params, stats, recordIndex, insertBatch, updateBatch, rowCounterRef) {
  // 保存进度函数
  const saveProgress = () => {
    if (!params.checkpointPath) return; // 未配置检查点路径,跳过

    // 保存检查点
    saveCheckpoint(params.checkpointPath, {
      appToken: params.appToken,
      tableId: params.tableId,
      csvPath: path.resolve(params.csvPath),
      mode: params.mode,
      processedRows: rowCounterRef.value,
      stats,
    });
  };

  return {
    client: params.client,
    appToken: params.appToken,
    tableId: params.tableId,
    mode: params.mode,
    batchSize: params.batchSize || 500,
    stats,
    recordIndex,
    pendingInsertByKey: params.pendingInsertByKey,
    insertBatch,
    updateBatch,
    saveProgress,
    logMessage: params.logMessage || ((msg) => process.stdout.write(msg)),
  };
}

/**
 * 运行同步任务(主函数)
 * 将 CSV 文件数据同步到 Lark 多维表格
 *
 * @param {Object} params - 同步参数对象
 * @param {LarkApiClient} params.client - Lark API 客户端
 * @param {string} params.appToken - Base 应用 token
 * @param {string} params.tableId - 表格 ID
 * @param {string} params.csvPath - CSV 文件路径
 * @param {string} params.csvEncoding - CSV 文件编码(默认 'utf8')
 * @param {string} params.mode - 同步模式('insert'|'update'|'upsert'|'empty')
 * @param {Array<Object>} params.keyMappings - 主键字段映射
 * @param {Array<Object>} params.valueMappings - 通用字段映射(已废弃,使用 updateMappings/insertMappings)
 * @param {Array<Object>} params.updateMappings - 更新字段映射
 * @param {Array<Object>} params.insertMappings - 插入字段映射
 * @param {number} params.batchSize - 批次大小(默认 500)
 * @param {string} params.checkpointPath - 检查点文件路径(用于断点续传)
 * @param {number} params.resumeRow - 恢复行号(从检查点恢复)
 * @param {Function} params.onProgress - 进度回调函数
 * @returns {Promise<Object>} - 同步统计对象
 *
 * 同步模式说明:
 * - insert: 仅插入新记录,不更新现有记录
 * - update: 仅更新现有记录,不插入新记录
 * - upsert: 更新现有记录,不存在则插入(默认)
 * - empty: 清空字段值(要求 CSV 对应列为空)
 *
 * 工作流程:
 * 1. 初始化:验证参数,统计 CSV 行数
 * 2. 获取字段元数据:字段类型、名称等
 * 3. 构建关联字段解析器:扫描关联表,建立文本值到记录ID的映射
 * 4. 构建记录索引:扫描目标表,建立主键到记录ID的映射
 * 5. 流式读取 CSV:逐行处理,累积批次
 * 6. 批量提交:达到批次大小时提交更新/插入操作
 * 7. 完成:刷新剩余批次,保存最终统计
 *
 * 进度回调:
 * - phase: 'initializing' | 'resolving-links' | 'indexing' | 'running' | 'finalizing' | 'completed'
 * - message: 进度消息
 * - stats: 统计对象
 *
 * 错误处理:
 * - 字段验证失败:抛出错误
 * - 行处理失败:记录到 stats.failures,继续处理
 * - API 调用失败:批量失败时回退到单条提交
 *
 * 断点续传:
 * - 定期保存检查点(包含已处理行数和统计信息)
 * - 通过 resumeRow 参数恢复
 *
 * @example
 * const stats = await runSync({
 *   client,
 *   appToken: 'bascn...',
 *   tableId: 'tbl...',
 *   csvPath: 'data.csv',
 *   mode: 'upsert',
 *   keyMappings: [{ fieldName: 'Code', csvColumn: 'Code' }],
 *   updateMappings: [{ fieldName: 'Name', csvColumn: 'Name' }],
 *   insertMappings: [{ fieldName: 'Code', csvColumn: 'Code' }, { fieldName: 'Name', csvColumn: 'Name' }],
 *   onProgress: (progress) => console.log(progress.message)
 * });
 * console.log(`完成: 插入 ${stats.insertedRows}, 更新 ${stats.updatedRows}, 失败 ${stats.failedRows}`);
 */
async function runSync(params) {
  const {
    client,
    appToken,
    tableId,
    csvPath,
    csvEncoding = 'utf8',
    mode: modeInput,
    keyMappings,
    valueMappings = [],
    updateMappings = [],
    insertMappings = [],
    batchSize,
    checkpointPath,
    resumeRow = 0,
    onProgress,
    onLog,
  } = params;
  const mode = String(modeInput || MODE_UPSERT).trim().toLowerCase();

  const logMessage = (msg) => {
    if (typeof onLog === 'function') {
      try {
        onLog(msg);
      } catch {
        // ignore callback error
      }
    }
    process.stdout.write(msg);
  };

  const rawUpdateMappings =
    Array.isArray(updateMappings) && updateMappings.length > 0
      ? updateMappings
      : valueMappings;
  const effectiveInsertMappings =
    Array.isArray(insertMappings) && insertMappings.length > 0
      ? insertMappings
      : valueMappings;
  const { filtered: effectiveUpdateMappings, blocked: blockedUpdateFields } =
    filterKeyFieldsFromUpdateMappings(rawUpdateMappings, keyMappings);

  const stats = buildStats({ ...params, mode });
  emitProgress(onProgress, {
    phase: 'initializing',
    message: '初期化中...',
    stats,
  });

  emitProgress(onProgress, {
    phase: 'initializing',
    message: 'CSV行数を集計中...',
    stats,
  });
  stats.estimatedTotalRows = await countCsvRows(csvPath, { encoding: csvEncoding });
  if (resumeRow > 0) {
    stats.processedRows = Math.min(resumeRow, stats.estimatedTotalRows || resumeRow);
  }
  emitProgress(onProgress, {
    phase: 'initializing',
    message: `CSV rows: ${stats.estimatedTotalRows}`,
    stats,
  });

  const fieldMetas = await client.listFields(appToken, tableId);
  const fieldNames = fieldMetas.map((item) => item.field_name).filter(Boolean);
  const fieldMetaByName = buildFieldMetaByName(fieldMetas);
  if (blockedUpdateFields.length > 0) {
    logMessage(
      `[warn] blocked protected update fields: ${Array.from(new Set(blockedUpdateFields)).join(', ')}\n`
    );
  }
  if (mode !== MODE_INSERT && effectiveUpdateMappings.length === 0) {
    throw new Error('Keyフィールドを除外した結果、更新可能なマッピングがありません');
  }
  if ((mode === MODE_INSERT || mode === MODE_UPSERT) && effectiveInsertMappings.length === 0) {
    throw new Error('No insert mappings configured for insert/upsert mode');
  }
  if (mode !== MODE_INSERT && (!Array.isArray(keyMappings) || keyMappings.length === 0)) {
    throw new Error('Key mappings are required for update/upsert/empty mode');
  }
  validateMappings(
    fieldNames,
    keyMappings,
    effectiveUpdateMappings,
    effectiveInsertMappings
  );

  const allMappingsForLink = [
    ...keyMappings,
    ...effectiveUpdateMappings,
    ...effectiveInsertMappings,
  ];
  logMessage('[link] checking for link fields in mappings...\n');
  emitProgress(onProgress, {
    phase: 'resolving-links',
    message: '関連フィールド解析中...',
    stats,
  });
  const linkResolvers = await buildLinkResolvers(
    client, appToken, fieldMetaByName, allMappingsForLink, onProgress, logMessage
  );
  if (linkResolvers.size > 0) {
    logMessage(`[link] ${linkResolvers.size} link resolver(s) ready\n`);
  } else {
    logMessage('[link] no link fields detected in mappings\n');
  }

  let recordIndex = new Map();
  if (mode !== MODE_INSERT) {
    logMessage('[index] building key index from existing records...\n');
    emitProgress(onProgress, {
      phase: 'indexing',
      message: '既存レコードを索引中...',
      stats,
    });
    let indexResult;
    try {
      indexResult = await buildRecordIndex(
        client,
        appToken,
        tableId,
        keyMappings,
        stats,
        onProgress
      );
    } catch (error) {
      if (!isRepeatedPageTokenError(error) || typeof client.listRecords !== 'function') {
        throw error;
      }

      logMessage(
        `[warn] ${toErrorMessage(error)}\n[index] fallback: rebuilding key index via list records API...\n`
      );
      emitProgress(onProgress, {
        phase: 'indexing',
        message: 'ページネーション異常を検知しました。代替のリスト・スキャンに切り替えます...',
        stats,
      });
      indexResult = await buildRecordIndexViaListRecords(
        client,
        appToken,
        tableId,
        keyMappings,
        stats,
        onProgress
      );
    }
    recordIndex = indexResult.recordIndex;
    stats.indexedRows = indexResult.indexedCount;
    logMessage(
      `[index] done, scanned ${indexResult.scannedCount} unique records, indexed ${stats.indexedRows}` +
      (indexResult.duplicateCount > 0 ? ` (deduped ${indexResult.duplicateCount})` : '') +
      '\n'
    );
    emitProgress(onProgress, {
      phase: 'indexing',
      message: `Indexed ${stats.indexedRows} rows`,
      stats,
    });
  }

  const insertBatch = [];
  const updateBatch = [];
  const pendingInsertByKey = new Map();
  const rowCounterRef = { value: 0 };
  const ctx = createClientContext(
    {
      client,
      appToken,
      tableId,
      csvPath,
      mode,
      batchSize,
      checkpointPath,
      pendingInsertByKey,
      logMessage,
    },
    stats,
    recordIndex,
    insertBatch,
    updateBatch,
    rowCounterRef
  );

  let lastProgressRow = stats.processedRows;
  let lastProgressAt = 0;
  let lastProgressLogRow = 0;
  const emitRunningProgress = (force = false) => {
    const currentRow = rowCounterRef.value;
    const now = Date.now();
    if (!force) {
      const rowDelta = currentRow - lastProgressRow;
      const timeDelta = now - lastProgressAt;
      if (
        rowDelta < RUNNING_PROGRESS_MIN_ROW_STEP &&
        timeDelta < RUNNING_PROGRESS_MIN_INTERVAL_MS
      ) {
        return;
      }
    }

    stats.processedRows = currentRow;
    if (stats.totalRows > stats.estimatedTotalRows) {
      stats.estimatedTotalRows = stats.totalRows;
    }

    if (currentRow % 1000 === 0 && currentRow > 0 && currentRow !== lastProgressLogRow) {
      lastProgressLogRow = currentRow;
      logMessage(
        `[progress] csv=${currentRow} inserted=${stats.insertedRows} updated=${stats.updatedRows} failed=${stats.failedRows} skipped=${stats.skippedRows}\n`
      );
    }

    emitProgress(onProgress, {
      phase: 'running',
      message:
        stats.estimatedTotalRows > 0
          ? `Processed ${currentRow}/${stats.estimatedTotalRows} rows`
          : `Processed ${currentRow} rows`,
      stats,
    });

    lastProgressRow = currentRow;
    lastProgressAt = now;
  };

  emitProgress(onProgress, {
    phase: 'running',
    message:
      stats.estimatedTotalRows > 0
        ? `Starting row processing (0/${stats.estimatedTotalRows})`
        : 'Starting row processing...',
    stats,
  });

  const stream = createCsvRowStream(csvPath, { encoding: csvEncoding });
  for await (const row of stream) {
    rowCounterRef.value += 1;

    if (resumeRow > 0 && rowCounterRef.value <= resumeRow) {
      continue;
    }

    stats.totalRows += 1;

    // ビジネスロジック検証
    const validationErrors = validateCsvRow(row);
    if (validationErrors.length > 0) {
      for (const ve of validationErrors) {
        pushFailure(stats, rowCounterRef.value, ve.message, row);
      }
      emitRunningProgress(false);
      continue;
    }

    try {
      if (mode === MODE_INSERT) {
        const insertOnlyFields = buildFieldsFromRow(
          row,
          effectiveInsertMappings,
          false,
          fieldMetaByName,
          linkResolvers
        );
        if (Object.keys(insertOnlyFields).length === 0) {
          stats.skippedRows += 1;
          continue;
        }
        insertBatch.push({
          rowNumber: rowCounterRef.value,
          fields: insertOnlyFields,
          key: '',
          rowData: { ...row },
        });
      } else {
        const keyParts = buildKeyPartsFromRow(
          row,
          keyMappings,
          fieldMetaByName,
          linkResolvers
        );
        if (hasEmptyKeyPart(keyParts)) {
          pushFailure(stats, rowCounterRef.value, 'キー値が空です', row);
          continue;
        }

        const key = joinKey(keyParts);
        const matched = recordIndex.get(key) || [];
        if (matched.length > 1) {
          pushFailure(stats, rowCounterRef.value, '同じキーを持つ複数のレコードがマッチしました', row);
          continue;
        }

        const recordId = matched[0];

        if (mode === MODE_EMPTY) {
          const emptyUpdate = buildFieldsForEmptyMode(row, effectiveUpdateMappings);
          if (emptyUpdate.nonEmptyFields.length > 0) {
            pushFailure(
              stats,
              rowCounterRef.value,
              `emptyモードでは更新フィールドが空である必要があります: ${emptyUpdate.nonEmptyFields.join(', ')}`,
              row
            );
            continue;
          }
          if (Object.keys(emptyUpdate.fields).length === 0) {
            stats.skippedRows += 1;
            continue;
          }
          if (!recordId) {
            stats.skippedRows += 1;
            continue;
          }
          updateBatch.push({
            rowNumber: rowCounterRef.value,
            recordId,
            fields: emptyUpdate.fields,
            rowData: { ...row },
          });
          continue;
        }

        const updateFields = buildFieldsFromRow(
          row,
          effectiveUpdateMappings,
          false,
          fieldMetaByName,
          linkResolvers
        );
        if (shouldSkipBecauseNoWritableField(updateFields, false)) {
          stats.skippedRows += 1;
          continue;
        }
        if (!recordId) {
          if (mode === MODE_UPDATE) {
            pushFailure(stats, rowCounterRef.value, 'updateモードですが、対象レコードが見つかりません', row);
            continue;
          }

          const insertCandidate = buildFieldsFromRow(
            row,
            effectiveInsertMappings,
            false,
            fieldMetaByName,
            linkResolvers
          );
          const insertFields = buildInsertFieldsWithKey(
            row,
            keyMappings,
            insertCandidate,
            fieldMetaByName,
            linkResolvers
          );
          if (Object.keys(insertFields).length === 0) {
            stats.skippedRows += 1;
            continue;
          }
          if (mode === MODE_UPSERT && pendingInsertByKey.has(key)) {
            const pendingInsert = pendingInsertByKey.get(key);
            pendingInsert.fields = {
              ...pendingInsert.fields,
              ...insertFields,
            };
            stats.skippedRows += 1;
            continue;
          }

          const insertItem = {
            rowNumber: rowCounterRef.value,
            fields: insertFields,
            key,
            rowData: { ...row },
          };
          insertBatch.push(insertItem);
          if (mode === MODE_UPSERT) {
            pendingInsertByKey.set(key, insertItem);
          }
        } else {
          updateBatch.push({
            rowNumber: rowCounterRef.value,
            recordId,
            fields: updateFields,
            rowData: { ...row },
          });
        }
      }

      if (updateBatch.length >= batchSize * CONCURRENCY_WRITE) {
        await flushUpdateBatch(ctx, false);
      }
      if (insertBatch.length >= batchSize * CONCURRENCY_WRITE) {
        await flushInsertBatch(ctx, false);
      }
    } catch (error) {
      pushFailure(stats, rowCounterRef.value, toErrorMessage(error), row);
    } finally {
      emitRunningProgress(false);
    }
  }

  emitRunningProgress(true);
  await flushUpdateBatch(ctx, false);
  await flushInsertBatch(ctx, false);

  stats.processedRows = rowCounterRef.value;
  stats.endedAt = new Date().toISOString();
  emitProgress(onProgress, {
    phase: 'finalizing',
    message: '最終処理中...',
    stats,
  });
  if (checkpointPath) {
    saveCheckpoint(checkpointPath, {
      appToken,
      tableId,
      csvPath: path.resolve(csvPath),
      mode,
      processedRows: stats.processedRows,
      completed: true,
      stats,
    });
  }
  emitProgress(onProgress, {
    phase: 'completed',
    message: '完了',
    stats,
  });
  return stats;
}

/**
 * 模块导出
 * 导出同步引擎的主函数
 *
 * 导出函数:
 * - runSync: 运行 CSV 到 Lark 多维表格的同步任务
 *
 * 使用示例:
 * const { runSync } = require('./sync-engine');
 *
 * const stats = await runSync({
 *   client: larkApiClient,
 *   appToken: 'bascn...',
 *   tableId: 'tbl...',
 *   csvPath: 'data.csv',
 *   mode: 'upsert',
 *   keyMappings: [{ fieldName: 'Code', csvColumn: 'Code' }],
 *   updateMappings: [{ fieldName: 'Name', csvColumn: 'Name' }],
 *   insertMappings: [
 *     { fieldName: 'Code', csvColumn: 'Code' },
 *     { fieldName: 'Name', csvColumn: 'Name' }
 *   ],
 *   onProgress: (progress) => {
 *     console.log(`${progress.phase}: ${progress.message}`);
 *   }
 * });
 *
 * console.log('同步完成:', stats);
 */
module.exports = {
  runSync,
};
