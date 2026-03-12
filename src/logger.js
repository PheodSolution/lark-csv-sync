/**
 * Lark CSV 同步工具 - 日志拦截器
 * 
 * 拦截 process.stdout 和 process.stderr，自动在每行开头加上时间戳。
 * 例如：[18:40:03] [info] loading...
 */

const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);

function getTimestamp() {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, '0');
  const m = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `[${h}:${m}:${s}] `;
}

let isStdoutNewLine = true;
process.stdout.write = (chunk, encoding, callback) => {
  if (typeof chunk !== 'string') {
    return originalStdoutWrite(chunk, encoding, callback);
  }
  let newChunk = '';
  for (let i = 0; i < chunk.length; i++) {
    if (isStdoutNewLine) {
      newChunk += getTimestamp();
      isStdoutNewLine = false;
    }
    newChunk += chunk[i];
    if (chunk[i] === '\n') {
      isStdoutNewLine = true;
    }
  }
  return originalStdoutWrite(newChunk, encoding, callback);
};

let isStderrNewLine = true;
process.stderr.write = (chunk, encoding, callback) => {
  if (typeof chunk !== 'string') {
    return originalStderrWrite(chunk, encoding, callback);
  }
  let newChunk = '';
  for (let i = 0; i < chunk.length; i++) {
    if (isStderrNewLine) {
      newChunk += getTimestamp();
      isStderrNewLine = false;
    }
    newChunk += chunk[i];
    if (chunk[i] === '\n') {
      isStderrNewLine = true;
    }
  }
  return originalStderrWrite(newChunk, encoding, callback);
};

// 导出方法以供其他模块使用
module.exports = {
  getTimestamp
};
