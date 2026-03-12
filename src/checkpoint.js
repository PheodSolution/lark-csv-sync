// 引入 Node.js 文件系统模块,用于文件读写操作
const fs = require('fs');
// 引入 Node.js 路径模块,用于处理文件路径
const path = require('path');

/**
 * 解析检查点文件的完整路径
 * 检查点文件用于保存同步进度,支持断点续传功能
 * 
 * @param {string} inputPath - 输入的检查点文件路径(相对或绝对路径)
 * @param {string} baseDir - 基础目录,默认为当前工作目录
 * @returns {string} - 解析后的检查点文件绝对路径
 * 
 * @example
 * // 使用默认文件名
 * resolveCheckpointPath('') // => '/current/dir/.sync-checkpoint.json'
 * 
 * // 使用自定义文件名
 * resolveCheckpointPath('my-checkpoint.json') // => '/current/dir/my-checkpoint.json'
 * 
 * // 使用自定义基础目录
 * resolveCheckpointPath('checkpoint.json', '/data') // => '/data/checkpoint.json'
 */
function resolveCheckpointPath(inputPath, baseDir = process.cwd()) {
  // 解析基础目录为绝对路径,如果 baseDir 为空则使用当前工作目录
  const rootDir = path.resolve(baseDir || process.cwd());
  
  // 如果输入路径为空或只包含空格,返回默认检查点文件路径
  if (!inputPath || !inputPath.trim()) {
    return path.resolve(rootDir, '.sync-checkpoint.json');
  }
  
  // 将输入路径解析为相对于基础目录的绝对路径
  return path.resolve(rootDir, inputPath.trim());
}

/**
 * 加载检查点文件内容
 * 从磁盘读取检查点文件并解析为 JavaScript 对象
 * 
 * @param {string} checkpointPath - 检查点文件的完整路径
 * @returns {Object|null} - 检查点数据对象,如果文件不存在或为空则返回 null
 * @throws {Error} - 如果文件读取或 JSON 解析失败
 * 
 * 检查点数据结构示例:
 * {
 *   appToken: 'bas...',        // Lark Base 应用 token
 *   tableId: 'tbl...',         // 目标表 ID
 *   csvPath: '/path/to/file.csv', // CSV 文件路径
 *   mode: 'upsert',            // 同步模式
 *   processedRows: 1000,       // 已处理的行数
 *   completed: false,          // 是否已完成
 *   stats: {...},              // 统计信息
 *   updatedAt: '2024-01-01T00:00:00.000Z' // 最后更新时间
 * }
 */
function loadCheckpoint(checkpointPath) {
  // 检查文件是否存在,不存在则返回 null
  if (!fs.existsSync(checkpointPath)) return null;
  
  try {
    // 读取文件内容(UTF-8 编码)
    const raw = fs.readFileSync(checkpointPath, 'utf8');
    
    // 如果文件内容为空(去除空格后),返回 null
    if (!raw.trim()) return null;
    
    // 解析 JSON 字符串为 JavaScript 对象并返回
    return JSON.parse(raw);
  } catch (error) {
    // 捕获文件读取或 JSON 解析错误,抛出更友好的错误消息
    throw new Error(`Failed to load checkpoint: ${error.message}`);
  }
}

/**
 * 保存检查点数据到磁盘
 * 将同步进度信息序列化为 JSON 并写入文件,用于断点续传
 * 
 * @param {string} checkpointPath - 检查点文件的完整路径
 * @param {Object} data - 要保存的检查点数据对象
 * @returns {void}
 * 
 * 功能说明:
 * 1. 自动添加 updatedAt 时间戳字段
 * 2. 格式化 JSON 输出(缩进 2 个空格)
 * 3. 使用 UTF-8 编码写入文件
 * 4. 如果文件已存在则覆盖
 * 
 * @example
 * saveCheckpoint('/path/checkpoint.json', {
 *   appToken: 'bas123',
 *   tableId: 'tbl456',
 *   csvPath: '/data/file.csv',
 *   mode: 'upsert',
 *   processedRows: 500,
 *   completed: false
 * });
 */
function saveCheckpoint(checkpointPath, data) {
  // 构造完整的检查点数据对象
  const payload = {
    ...data, // 展开传入的数据对象
    updatedAt: new Date().toISOString(), // 添加当前时间戳(ISO 8601 格式)
  };
  
  // 将对象序列化为格式化的 JSON 字符串(缩进 2 个空格)并写入文件
  // 参数说明: JSON.stringify(value, replacer, space)
  // - value: 要序列化的对象
  // - replacer: null 表示不过滤任何属性
  // - space: 2 表示使用 2 个空格缩进,使输出更易读
  fs.writeFileSync(checkpointPath, JSON.stringify(payload, null, 2), 'utf8');
}

// 导出模块的公共函数
// 这些函数可以被其他模块通过 require('./checkpoint') 引入使用
module.exports = {
  resolveCheckpointPath, // 解析检查点文件路径
  loadCheckpoint,        // 加载检查点数据
  saveCheckpoint,        // 保存检查点数据
};
