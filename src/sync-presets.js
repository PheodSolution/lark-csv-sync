// ============================================================================
// 业务预设规则模块
// ============================================================================
// 本模块提供基于文件名的自动同步规则匹配功能
// 
// 功能说明:
// 1. 根据 CSV 文件名关键词自动匹配预设规则
// 2. 预设包含:目标表名、同步模式、字段映射配置
// 3. 匹配成功后,GUI 前端会进入只读锁定状态
// 4. 支持的预设:使用量、料金、所有器具、购入履歴
// 
// 使用场景:
// - 业务人员上传特定格式的 CSV 文件
// - 系统自动识别文件类型并应用对应的同步规则
// - 减少手工配置,降低操作错误
// ============================================================================

const path = require('path');

/**
 * 标准化文本:转为字符串、去除首尾空格、转小写
 * @param {any} value - 输入值
 * @returns {string} - 标准化后的字符串
 */
function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

/**
 * 标准化名称:移除所有空格
 * 用于表名的模糊匹配
 * 
 * @param {any} value - 输入值
 * @returns {string} - 标准化后的字符串(小写、无空格)
 * 
 * @example
 * normalizeName('顧客 管理')  // => '顧客管理'
 * normalizeName('  ABC  ')   // => 'abc'
 */
function normalizeName(value) {
  return normalizeText(value).replace(/\s+/g, ''); // 移除所有空格
}

/**
 * 克隆映射数组
 * 深拷贝映射配置,避免修改原始预设数据
 * 
 * @param {Array} mappings - 原始映射数组
 * @returns {Array} - 克隆后的映射数组
 * 
 * @example
 * cloneMappings([{ fieldName: 'Name', csvColumn: '姓名' }])
 * // => [{ fieldName: 'Name', csvColumn: '姓名' }]
 */
function cloneMappings(mappings) {
  return (Array.isArray(mappings) ? mappings : []).map((item) => ({
    fieldName: item.fieldName,
    csvColumn: item.csvColumn,
  }));
}

// ============================================================================
// 预设规则定义
// ============================================================================
// 每个预设包含:
// - id: 唯一标识符
// - name: 预设名称(日文)
// - keyword: 文件名匹配关键词
// - mode: 同步模式(insert/update/upsert/empty)
// - tableName: 目标表名
// - keyMappings: Key 字段映射(用于匹配已有记录)
// - updateMappings: 更新字段映射(update/upsert 模式使用)
// - insertMappings: 新增字段映射(insert/upsert 模式使用)
// ============================================================================

const PRESETS = [
  // 预设1: 使用量数据同步
  {
    id: 'usage',                    // 预设ID
    name: '使用量',                 // 预设名称
    keyword: '使用量',              // 文件名关键词
    mode: 'update',                 // 同步模式:仅更新
    tableName: '顧客管理',          // 目标表名
    
    // Key 字段映射:用于匹配已有记录
    keyMappings: [
      { fieldName: '需要家コード', csvColumn: '需要家コード' }
    ],
    
    // 更新字段映射:更新时写入的字段
    updateMappings: [
      { fieldName: '今年度使用量平均', csvColumn: '今年度使用量平均' }
    ],
    
    // 新增字段映射:空数组(update 模式不新增记录)
    insertMappings: [],
  },
  
  // 预设2: 料金(费用)数据同步
  {
    id: 'price',
    name: '料金',
    keyword: '料金',
    mode: 'update',
    tableName: '顧客管理',
    
    keyMappings: [
      { fieldName: '需要家コード', csvColumn: '需要家コード' }
    ],
    
    updateMappings: [
      { fieldName: '今年度料金平均', csvColumn: '今年度使用料金平均' }
    ],
    
    insertMappings: [],
  },
  
  // 预设3: 所有器具(设备)数据同步
  {
    id: 'all-devices',
    name: '所有器具',
    keyword: '所有器具',
    mode: 'upsert',                 // 同步模式:更新+新增
    tableName: '所有器具',
    
    // 复合 Key:需要家コード + 連番
    keyMappings: [
      { fieldName: '需要家コード', csvColumn: '需要家コード' },
      { fieldName: '連番', csvColumn: '連番' },
    ],
    
    // 更新字段映射:更新时写入的字段(不包含 Key 字段)
    updateMappings: [
      { fieldName: 'メーカー', csvColumn: 'メーカー' },
      { fieldName: '型式', csvColumn: '型式' },
      { fieldName: '消費量ＫＷ', csvColumn: '消費量ＫＷ' },
      { fieldName: '台数', csvColumn: '台数' },
      { fieldName: '製造年月', csvColumn: '製造年月' },
      { fieldName: '購入年月', csvColumn: '購入年月' },
      { fieldName: '機器分類', csvColumn: '機器分類' },
      { fieldName: '分類短縮名', csvColumn: '分類短縮名' },
      { fieldName: '機器名称', csvColumn: '機器名称' },
    ],
    
    // 新增字段映射:新增时写入的字段(包含 Key 字段和关联字段)
    insertMappings: [
      { fieldName: '顧客関連', csvColumn: '顧客名' },      // 关联字段
      { fieldName: '需要家コード', csvColumn: '需要家コード' },
      { fieldName: '連番', csvColumn: '連番' },
      { fieldName: 'メーカー', csvColumn: 'メーカー' },
      { fieldName: '型式', csvColumn: '型式' },
      { fieldName: '消費量ＫＷ', csvColumn: '消費量ＫＷ' },
      { fieldName: '台数', csvColumn: '台数' },
      { fieldName: '製造年月', csvColumn: '製造年月' },
      { fieldName: '購入年月', csvColumn: '購入年月' },
      { fieldName: '機器分類', csvColumn: '機器分類' },
      { fieldName: '分類短縮名', csvColumn: '分類短縮名' },
      { fieldName: '機器名称', csvColumn: '機器名称' },
    ],
  },
  
  // 预设4: 购入履歴(购买历史)数据同步
  {
    id: 'purchase-history',
    name: '購入履歴',
    keyword: '購入履歴',
    mode: 'upsert',
    tableName: '購入履歴',
    
    // 复合 Key:需要家コード + 購入日 + 分類コード
    keyMappings: [
      { fieldName: '需要家コード', csvColumn: '需要家コード' },
      { fieldName: '購入日', csvColumn: '購入日_文字型' },
      { fieldName: '分類コード', csvColumn: '分類コード' },
    ],
    
    updateMappings: [
      { fieldName: '購入機器名', csvColumn: '購入機器名' },
      { fieldName: '品番', csvColumn: '品番' },
      { fieldName: '数量', csvColumn: '数量' },
      { fieldName: '販売金額', csvColumn: '販売金額' },
    ],
    
    insertMappings: [
      { fieldName: '顧客関連', csvColumn: '顧客名' },      // 关联字段
      { fieldName: '需要家コード', csvColumn: '需要家コード' },
      { fieldName: '購入日', csvColumn: '購入日_文字型' },
      { fieldName: '分類コード', csvColumn: '分類コード' },
      { fieldName: '購入機器名', csvColumn: '購入機器名' },
      { fieldName: '品番', csvColumn: '品番' },
      { fieldName: '数量', csvColumn: '数量' },
      { fieldName: '販売金額', csvColumn: '販売金額' },
    ],
  },
];

/**
 * 检测同步预设规则
 * 根据 CSV 文件名关键词自动匹配预设规则
 * 
 * @param {string} fileName - CSV 文件名(可以是完整路径或文件名)
 * @returns {Object|null} - 匹配的预设对象,未匹配返回 null
 * 
 * 匹配规则:
 * - 提取文件名(去除路径)
 * - 转为小写进行模糊匹配
 * - 检查文件名是否包含预设的 keyword
 * - 返回第一个匹配的预设
 * 
 * 返回的预设对象结构:
 * {
 *   id: 'usage',                    // 预设ID
 *   name: '使用量',                 // 预设名称
 *   keyword: '使用量',              // 匹配关键词
 *   mode: 'update',                 // 同步模式
 *   tableName: '顧客管理',          // 目标表名
 *   keyMappings: [...],             // Key 字段映射(克隆)
 *   updateMappings: [...],          // 更新字段映射(克隆)
 *   insertMappings: [...],          // 新增字段映射(克隆)
 *   fileName: 'data_使用量.csv'    // 原始文件名
 * }
 * 
 * @example
 * detectSyncPreset('data_使用量_20240101.csv')
 * // => { id: 'usage', name: '使用量', mode: 'update', ... }
 * 
 * detectSyncPreset('/path/to/購入履歴.csv')
 * // => { id: 'purchase-history', name: '購入履歴', mode: 'upsert', ... }
 * 
 * detectSyncPreset('unknown.csv')
 * // => null
 */
function detectSyncPreset(fileName) {
  // 提取文件名(去除路径)
  const baseName = path.basename(String(fileName || '')).trim();
  
  // 如果文件名为空,返回 null
  if (!baseName) return null;

  // 标准化文件名(转小写)
  const normalizedFileName = normalizeText(baseName);
  
  // 遍历所有预设,查找匹配项
  const matched = PRESETS.find((item) =>
    normalizedFileName.includes(normalizeText(item.keyword))
  );
  
  // 如果未匹配,返回 null
  if (!matched) return null;

  // 返回克隆的预设对象(避免修改原始数据)
  return {
    id: matched.id,
    name: matched.name,
    keyword: matched.keyword,
    mode: matched.mode,
    tableName: matched.tableName,
    keyMappings: cloneMappings(matched.keyMappings),       // 深拷贝
    updateMappings: cloneMappings(matched.updateMappings), // 深拷贝
    insertMappings: cloneMappings(matched.insertMappings), // 深拷贝
    fileName: baseName, // 保存原始文件名
  };
}

/**
 * 根据表名查找表对象
 * 从表列表中查找指定名称的表(忽略大小写和空格)
 * 
 * @param {Array} tables - 表对象数组
 * @param {string} tableName - 要查找的表名
 * @returns {Object|null} - 匹配的表对象,未找到返回 null
 * 
 * 匹配规则:
 * - 标准化表名(小写、去空格)
 * - 遍历表列表,比较 name 或 table_id
 * - 返回第一个匹配的表对象
 * 
 * @example
 * const tables = [
 *   { table_id: 'tbl123', name: '顧客管理' },
 *   { table_id: 'tbl456', name: '所有器具' }
 * ];
 * 
 * findTableByName(tables, '顧客 管理')
 * // => { table_id: 'tbl123', name: '顧客管理' }
 * 
 * findTableByName(tables, 'unknown')
 * // => null
 */
function findTableByName(tables, tableName) {
  // 标准化目标表名(小写、去空格)
  const target = normalizeName(tableName);
  
  // 如果目标表名为空,返回 null
  if (!target) return null;
  
  // 确保 tables 是数组
  const items = Array.isArray(tables) ? tables : [];
  
  // 查找匹配的表
  return (
    items.find((item) => normalizeName(item.name || item.table_id || '') === target) || null
  );
}

// 导出模块的公共函数
module.exports = {
  detectSyncPreset,  // 检测同步预设规则
  findTableByName,   // 根据表名查找表对象
};
