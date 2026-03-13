/**
 * Lark CSV 同期ツール - ログインターセプター
 * 
 * process.stdout と process.stderr をインターセプトし、
 * 各行の先頭にタイムスタンプを自動付与します。
 * 例：[18:40:03] [info] loading...
 *
 * また、日本語 Windows 環境でのコンソール文字化けを防ぐため、
 * stdout/stderr の encoding を UTF-8 に強制設定します。
 */

// ─── UTF-8 強制設定 (日本語 Windows 対策) ───────────────────────────────────
// Windows の場合、デフォルトの stdout encoding が CP932(Shift-JIS) になることがある。
// Node.js の stream defaultEncoding を utf8 にすることで文字化けを防ぐ。
if (process.platform === 'win32') {
  // stdout/stderr の defaultEncoding を UTF-8 に設定
  if (process.stdout && typeof process.stdout.setDefaultEncoding === 'function') {
    process.stdout.setDefaultEncoding('utf8');
  }
  if (process.stderr && typeof process.stderr.setDefaultEncoding === 'function') {
    process.stderr.setDefaultEncoding('utf8');
  }
}

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
  return originalStdoutWrite(newChunk, 'utf8', callback);
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
  return originalStderrWrite(newChunk, 'utf8', callback);
};

// モジュールエクスポート
module.exports = {
  getTimestamp
};
