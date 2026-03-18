/**
 * CSV フィールドビジネスロジック検証モジュール
 *
 * 各プロジェクト固有のビジネスルールに基づいて CSV のフィールド値を検証します。
 * 検証はフィールド名に基づいて適用されます。
 *
 * 使い方:
 *   const { validateCsvField } = require('./csv-validators');
 *
 *   // フィールド名と値を渡す
 *   const error = validateCsvField('需要家コード', 'ABC123');
 *   if (error) {
 *     console.error(error); // 検証エラーメッセージ
 *   }
 *
 * @module csv-validators
 */

'use strict';

// ============================================================================
// 個別フィールドの検証ルール
// ============================================================================

/**
 * フィールドごとの検証ルール定義
 *
 * 各エントリ:
 *   key   : フィールド名（大文字・小文字・スペースを無視してマッチング）
 *   value : (value: string) => string | null
 *             - 検証OK → null を返す
 *             - 検証NG → エラーメッセージ文字列を返す
 */
const FIELD_VALIDATORS = {
  /**
   * 需要家コード: 文字列長 18 文字以内
   */
  '需要家コード': (value) => {
    if (value.length > 18) {
      return `「需要家コード」は18文字以内で入力してください（現在: ${value.length}文字）。`;
    }
    return null;
  },
  /**
   * 電話番号: 只包含数字和 "-"，其他内容报错
   */
  '電話番号': (value) => {
    const trimmed = String(value).trim();

    // 只允许数字和半角连字符 -
    if (!/^[0-9-]+$/.test(trimmed)) {
      return '「電話番号」は数字と"-"のみで入力してください。';
    }
    return null;
  },

  '大家★電話番号': (value) => {
    const trimmed = String(value).trim();

    // 只允许数字和半角连字符 -
    if (!/^[0-9-]+$/.test(trimmed)) {
      return '「大家★電話番号」は数字と"-"のみで入力してください。';
    }
    return null;
  },
};

// ============================================================================
// 公開 API
// ============================================================================

/**
 * 正規化されたフィールド名マップを 1 回だけ構築（大文字小文字・スペース無視）
 * @type {Map<string, Function>}
 */
const NORMALIZED_VALIDATOR_MAP = (() => {
  const map = new Map();
  for (const [fieldName, fn] of Object.entries(FIELD_VALIDATORS)) {
    const key = fieldName.replace(/\s+/g, '').toLowerCase();
    map.set(key, fn);
  }
  return map;
})();

/**
 * フィールド名と値を受け取り、ビジネスロジックを検証する
 *
 * @param {string} fieldName - フィールド名（CSV ヘッダーまたは Lark フィールド名）
 * @param {any}    rawValue  - CSV セルの生の値
 * @returns {string|null} - エラーメッセージ（問題なければ null）
 *
 * @example
 * validateCsvField('需要家コード', '1234567890123456789');
 * // => '「需要家コード」は18文字以内で入力してください（現在: 19文字）。'
 *
 * validateCsvField('需要家コード', 'ABC123');
 * // => null
 *
 * validateCsvField('未定義フィールド', 'anything');
 * // => null  （ルールが存在しないフィールドはスキップ）
 */
function validateCsvField(fieldName, rawValue) {
  const key = String(fieldName || '').replace(/\s+/g, '').toLowerCase();
  const validator = NORMALIZED_VALIDATOR_MAP.get(key);
  if (!validator) return null; // ルールなし → 問題なし

  const value = typeof rawValue === 'string' ? rawValue : String(rawValue ?? '');
  return validator(value);
}

/**
 * CSV 行オブジェクト全体をまとめて検証する
 *
 * @param {Object} row - CSV 行（フィールド名 → 値 のオブジェクト）
 * @returns {Array<{field: string, message: string}>} - エラー一覧（空なら検証OK）
 *
 * @example
 * const errors = validateCsvRow({ '需要家コード': '1234567890123456789' });
 * // => [{ field: '需要家コード', message: '「需要家コード」は18文字以内...' }]
 */
function validateCsvRow(row) {
  const errors = [];
  for (const [fieldName, value] of Object.entries(row || {})) {
    const message = validateCsvField(fieldName, value);
    if (message) {
      errors.push({ field: fieldName, message });
    }
  }
  return errors;
}

module.exports = {
  validateCsvField,
  validateCsvRow,
};
