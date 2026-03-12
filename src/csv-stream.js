// 引入 Node.js 文件系统模块,用于创建文件读取流
const fs = require('fs');
// 引入 iconv-lite 库,用于字符编码转换(支持 Shift_JIS、GBK 等非 UTF-8 编码)
const iconv = require('iconv-lite');
// 引入 csv-parse 库的 parse 函数,用于解析 CSV 文件
const { parse } = require('csv-parse');

/**
 * 标准化字符编码名称
 * 将各种编码名称的变体统一为标准格式
 * 
 * @param {string} input - 输入的编码名称(可能是各种大小写或别名)
 * @returns {string} - 标准化后的编码名称
 * 
 * 支持的编码映射:
 * - 'utf-8' / 'UTF-8' => 'utf8'
 * - 'sjis' / 'SJIS' => 'shift_jis'
 * - 'cp932' / 'CP932' => 'shift_jis'
 * - 其他编码保持原样(转为小写)
 * 
 * @example
 * normalizeEncoding('UTF-8')  // => 'utf8'
 * normalizeEncoding('SJIS')   // => 'shift_jis'
 * normalizeEncoding('GBK')    // => 'gbk'
 */
function normalizeEncoding(input) {
  // 转为字符串、去除首尾空格、转小写
  const raw = String(input || 'utf8').trim().toLowerCase();
  
  // 如果为空,返回默认编码 utf8
  if (!raw) return 'utf8';
  
  // 将 'utf-8' 统一为 'utf8'
  if (raw === 'utf-8') return 'utf8';
  
  // 将 'sjis' 统一为 'shift_jis'
  if (raw === 'sjis') return 'shift_jis';
  
  // 将 'cp932'(Windows 日文代码页)统一为 'shift_jis'
  if (raw === 'cp932') return 'shift_jis';
  
  // 其他编码保持原样返回
  return raw;
}

/**
 * 标准化表头列名
 * 去除列名首尾空格,如果为空则生成默认列名
 * 
 * @param {string} name - 原始列名
 * @returns {string} - 标准化后的列名
 * 
 * @example
 * normalizeHeaderName('  Name  ')  // => 'Name'
 * normalizeHeaderName('')          // => ''
 */
function normalizeHeaderName(name) {
  // 转为字符串并去除首尾空格
  return String(name || '').trim();
}

/**
 * 去重表头列名
 * 处理 CSV 文件中重复的列名,为重复列添加数字后缀
 * 
 * @param {Array<string>} headers - 原始表头数组
 * @returns {Array<string>} - 去重后的表头数组
 * 
 * 去重规则:
 * - 第一次出现的列名保持不变
 * - 第二次出现添加 '_2' 后缀
 * - 第三次出现添加 '_3' 后缀
 * - 以此类推
 * - 空列名生成为 'column_1', 'column_2' 等
 * 
 * @example
 * dedupeHeaders(['Name', 'Age', 'Name', ''])
 * // => ['Name', 'Age', 'Name_2', 'column_4']
 * 
 * dedupeHeaders(['', '', 'ID'])
 * // => ['column_1', 'column_2', 'ID']
 */
function dedupeHeaders(headers) {
  // 使用 Map 记录每个列名出现的次数
  const seen = new Map();
  
  // 遍历所有表头,为每个列名生成唯一名称
  return headers.map((rawHeader, index) => {
    // 标准化列名,如果为空则使用 'column_N' 格式
    const base = normalizeHeaderName(rawHeader) || `column_${index + 1}`;
    
    // 获取该列名已出现的次数(首次出现为 0)
    const count = seen.get(base) || 0;
    
    // 更新出现次数
    seen.set(base, count + 1);
    
    // 如果是首次出现,直接返回列名
    if (count === 0) return base;
    
    // 如果是重复列名,添加数字后缀 '_N'
    return `${base}_${count + 1}`;
  });
}

/**
 * 创建 CSV 输入流
 * 根据指定编码创建文件读取流,支持多种字符编码
 * 
 * @param {string} csvPath - CSV 文件的完整路径
 * @param {string} encoding - 字符编码(默认 'utf8')
 * @returns {ReadableStream} - 可读流对象
 * 
 * 支持的编码:
 * - utf8: UTF-8 编码(默认)
 * - shift_jis: 日文 Shift_JIS 编码
 * - gbk: 中文 GBK 编码
 * - 其他 iconv-lite 支持的编码
 * 
 * @example
 * // UTF-8 文件(直接读取)
 * const stream = createCsvInputStream('data.csv', 'utf8');
 * 
 * // Shift_JIS 日文文件(需要转码)
 * const stream = createCsvInputStream('data_jp.csv', 'shift_jis');
 */
function createCsvInputStream(csvPath, encoding = 'utf8') {
  // 标准化编码名称
  const normalized = normalizeEncoding(encoding);
  
  // 创建文件读取流
  const source = fs.createReadStream(csvPath);
  
  // 如果是 UTF-8 编码,直接返回原始流(无需转码)
  if (normalized === 'utf8') return source;
  
  // 如果是其他编码,使用 iconv-lite 进行解码转换
  // pipe 方法将文件流连接到解码流,实现流式转码
  return source.pipe(iconv.decodeStream(normalized));
}

/**
 * 创建 CSV 行流
 * 创建一个可以逐行读取 CSV 文件的流对象
 * 
 * @param {string} csvPath - CSV 文件的完整路径
 * @param {Object} options - 配置选项
 * @param {string} options.encoding - 字符编码(默认 'utf8')
 * @returns {ReadableStream} - CSV 行流,每次读取返回一个解析后的行对象
 * 
 * 解析配置:
 * - columns: 使用 dedupeHeaders 函数处理表头,自动去重
 * - bom: true - 自动处理 UTF-8 BOM 标记(字节顺序标记)
 * - skip_empty_lines: true - 跳过空行
 * - relax_quotes: true - 宽松引号模式(允许不规范的引号使用)
 * - relax_column_count: true - 宽松列数模式(允许行列数不一致)
 * - trim: false - 不自动去除字段首尾空格(保留原始数据)
 * 
 * @example
 * const stream = createCsvRowStream('data.csv', { encoding: 'utf8' });
 * for await (const row of stream) {
 *   console.log(row); // { Name: 'John', Age: '30', ... }
 * }
 */
function createCsvRowStream(csvPath, options = {}) {
  // 创建 CSV 解析器,配置解析选项
  const parser = parse({
    // columns 回调函数:处理表头行,自动去重列名
    columns: (headers) => dedupeHeaders(headers),
    
    // 自动处理 UTF-8 BOM(Byte Order Mark)标记
    // BOM 是文件开头的特殊字节序列,用于标识编码类型
    bom: true,
    
    // 跳过空行(不解析为记录)
    skip_empty_lines: true,
    
    // 宽松引号模式:允许字段中出现不配对的引号
    relax_quotes: true,
    
    // 宽松列数模式:允许某些行的列数与表头不一致
    relax_column_count: true,
    
    // 不自动去除字段首尾空格,保留原始数据
    trim: false,
  });

  // 创建输入流并连接到解析器
  // 流程: 文件 -> 编码转换(如需要) -> CSV 解析 -> 行对象
  const stream = createCsvInputStream(csvPath, options.encoding).pipe(parser);
  
  return stream;
}

/**
 * 读取 CSV 文件的表头行
 * 只读取第一行数据(表头),不解析整个文件
 * 
 * @param {string} csvPath - CSV 文件的完整路径
 * @param {Object} options - 配置选项
 * @param {string} options.encoding - 字符编码(默认 'utf8')
 * @returns {Promise<Array<string>>} - Promise,resolve 为去重后的表头数组
 * 
 * 功能说明:
 * 1. 只读取文件的第一行(表头行)
 * 2. 自动处理 UTF-8 BOM 标记
 * 3. 自动去重重复的列名
 * 4. 读取完成后立即销毁流,节省资源
 * 
 * @example
 * const headers = await readCsvHeaders('data.csv', { encoding: 'utf8' });
 * console.log(headers); // ['Name', 'Age', 'Email']
 * 
 * // 处理重复列名
 * const headers2 = await readCsvHeaders('dup.csv');
 * console.log(headers2); // ['ID', 'Name', 'Name_2', 'Name_3']
 */
function readCsvHeaders(csvPath, options = {}) {
  return new Promise((resolve, reject) => {
    // 创建 CSV 解析器,配置为只读取第一行
    const parser = parse({
      to_line: 1, // 只读取到第 1 行(表头行)
      bom: true,  // 处理 BOM 标记
      relax_quotes: true,        // 宽松引号模式
      relax_column_count: true,  // 宽松列数模式
      trim: false,               // 不去除空格
    });

    // 创建输入流
    const input = createCsvInputStream(csvPath, options.encoding);
    
    // 标记是否已经 resolve(防止重复调用)
    let resolved = false;

    // 监听 'readable' 事件:当有数据可读时触发
    parser.on('readable', () => {
      // 读取一行数据
      const row = parser.read();
      
      // 如果没有数据或已经 resolve,直接返回
      if (!row || resolved) return;
      
      // 标记为已 resolve
      resolved = true;
      
      // 对表头进行去重处理并返回
      resolve(dedupeHeaders(row));
      
      // 销毁解析器和输入流,释放资源
      parser.destroy();
      input.destroy();
    });

    // 监听解析错误
    parser.on('error', (error) => reject(error));
    
    // 监听解析结束事件
    parser.on('end', () => {
      // 如果解析结束时还没有 resolve,说明文件为空
      if (!resolved) resolve([]);
    });

    // 监听输入流错误
    input.on('error', (error) => reject(error));
    
    // 将输入流连接到解析器
    input.pipe(parser);
  });
}

/**
 * 统计 CSV 文件的总行数(不包括表头)
 * 流式读取整个文件,统计数据行数量
 * 
 * @param {string} csvPath - CSV 文件的完整路径
 * @param {Object} options - 配置选项
 * @param {string} options.encoding - 字符编码(默认 'utf8')
 * @returns {Promise<number>} - Promise,resolve 为数据行总数(不包括表头)
 * 
 * 性能说明:
 * - 使用流式读取,内存占用低
 * - 适合大文件(几十万行)的行数统计
 * - 会读取整个文件,对于大文件可能需要一定时间
 * 
 * @example
 * const rowCount = await countCsvRows('data.csv', { encoding: 'utf8' });
 * console.log(`文件共有 ${rowCount} 行数据`);
 * 
 * // 统计 Shift_JIS 编码的日文 CSV 文件
 * const count = await countCsvRows('data_jp.csv', { encoding: 'shift_jis' });
 */
async function countCsvRows(csvPath, options = {}) {
  let total = 0; // 行数计数器
  
  // 创建 CSV 行流
  const stream = createCsvRowStream(csvPath, options);
  
  // 使用 for await...of 循环遍历所有行
  // 每读取一行,计数器加 1
  for await (const _row of stream) {
    total += 1;
  }
  
  // 返回总行数
  return total;
}

// 导出模块的公共函数
// 这些函数可以被其他模块通过 require('./csv-stream') 引入使用
module.exports = {
  createCsvRowStream,  // 创建 CSV 行流(用于逐行读取)
  readCsvHeaders,      // 读取 CSV 表头
  countCsvRows,        // 统计 CSV 行数
  normalizeEncoding,   // 标准化编码名称(工具函数)
  dedupeHeaders,       // 去重表头列名(工具函数)
};
