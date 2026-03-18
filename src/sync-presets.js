// ============================================================================
// 业务预设规则模块
// ============================================================================
// 本模块提供基于文件名的自动同步规则匹配功能
//
// 功能说明:
// 1. 根据 CSV 文件名关键词自动匹配预设规则
// 2. 预设包含:目标表名、同步模式、字段映射配置
// 3. 匹配成功后,GUI 前端会进入只读锁定状态
// 4. 支持的预设:使用量、料金、所有器具、购入履歴、新設/器具、(内)給湯器、給湯器、重点商品、リフォーム予算、予算、中止防止受付、イベント目標、大家顧客登録、物件情報、中止インポート、大家管理会社情報、空インポート_TGL、TGL、マイページ情報、イベント来場履歴_需要家コード、イベント来場履歴_統合ID、空インポート_TLC情報、TLC情報、空インポート_他社グループ顧客、他社グループ顧客、空インポート_在宅見込情報、在宅見込情報、ゼンリン顧客データ、DM履歴、自社担当者、営利評価、案件、新設他社情報更新、顧客情報更新、空インポート_安心補償付き対象リスト、安心補償付き対象リスト、部署情報、社員情報
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
    name: '使用量・料金',                 // 预设名称
    keyword: '使用量・料金',              // 文件名关键词
    mode: 'update',                 // 同步模式:仅更新
    tableName: '顧客管理',          // 目标表名

    // Key 字段映射:用于匹配已有记录
    keyMappings: [
      { fieldName: '需要家コード', csvColumn: '需要家コード' }
    ],

    // 更新字段映射:更新时写入的字段
    updateMappings: [
      { fieldName: '今年度使用量平均', csvColumn: '今年度使用量平均' },
      { fieldName: '今年度料金平均', csvColumn: '今年度使用料金平均' }
    ],

    // 新增字段映射:空数组(update 模式不新增记录)
    insertMappings: [],
  },

  // 预设2: 料金(费用)数据同步
  // {
  //   id: 'price',
  //   name: '料金',
  //   keyword: '料金',
  //   mode: 'update',
  //   tableName: '顧客管理',

  //   keyMappings: [
  //     { fieldName: '需要家コード', csvColumn: '需要家コード' }
  //   ],

  //   updateMappings: [
  //     { fieldName: '今年度料金平均', csvColumn: '今年度使用料金平均' }
  //   ],

  //   insertMappings: [],
  // },

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
      { fieldName: '消費量KW', csvColumn: '消費量ＫＷ' },
      { fieldName: '台数', csvColumn: '台数' },
      { fieldName: '製造年月', csvColumn: '製造年月' },
      { fieldName: '購入年月', csvColumn: '購入年月' },
      { fieldName: '機器分類', csvColumn: '機器分類' },
      { fieldName: '分類短縮名', csvColumn: '分類短縮名' },
      { fieldName: '機器名称', csvColumn: '機器名称' }
    ],

    // 新增字段映射:新增时写入的字段(包含 Key 字段和关联字段)
    insertMappings: [
      { fieldName: '顧客関連', csvColumn: '顧客名' },      // 关联字段
      { fieldName: '需要家コード', csvColumn: '需要家コード' },
      { fieldName: '連番', csvColumn: '連番' },
      { fieldName: 'メーカー', csvColumn: 'メーカー' },
      { fieldName: '型式', csvColumn: '型式' },
      { fieldName: '消費量KW', csvColumn: '消費量ＫＷ' },
      { fieldName: '台数', csvColumn: '台数' },
      { fieldName: '製造年月', csvColumn: '製造年月' },
      { fieldName: '購入年月', csvColumn: '購入年月' },
      { fieldName: '機器分類', csvColumn: '機器分類' },
      { fieldName: '分類短縮名', csvColumn: '分類短縮名' },
      { fieldName: '機器名称', csvColumn: '機器名称' }
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

  // 预设5: 新設/器具(月別予算)数据同步
  {
    id: 'new-install-devices-budget',
    name: '新設/器具',
    keyword: '新設/器具',
    mode: 'upsert',
    tableName: '月別予算',

    // Key: ID(文本字段) <- CSV ID
    keyMappings: [
      { fieldName: 'ID', csvColumn: 'ID' },
    ],

    // 更新字段映射:更新时写入预算相关字段
    updateMappings: [
      { fieldName: '予算日付', csvColumn: '予算日付' },
      { fieldName: '事業所', csvColumn: '事業所コード' },
      { fieldName: '従業員', csvColumn: '従業員コード' },
      { fieldName: '器具売上高_予算', csvColumn: '器具売上高' },
      { fieldName: '器具利益_予算', csvColumn: '器具利益' },
      { fieldName: '新設件数', csvColumn: '新設件数' },
    ],

    // 新增字段映射:ID 会在 upsert 插入分支中由 keyMappings 自动补齐
    insertMappings: [
      { fieldName: '予算日付', csvColumn: '予算日付' },
      { fieldName: '事業所', csvColumn: '事業所コード' },
      { fieldName: '従業員', csvColumn: '従業員コード' },
      { fieldName: '器具売上高_予算', csvColumn: '器具売上高' },
      { fieldName: '器具利益_予算', csvColumn: '器具利益' },
      { fieldName: '新設件数', csvColumn: '新設件数' },
    ],
  },

  // 预设6: (内)給湯器(月別予算)数据同步
  // 注意: 该关键词比 "給湯器" 更具体,必须放在前面以避免被先匹配
  {
    id: 'inner-water-heater-budget',
    name: '(内)給湯器',
    keyword: '(内)給湯器',
    mode: 'upsert',
    tableName: '月別予算',

    // Key: ID(文本字段) <- CSV ID
    keyMappings: [
      { fieldName: 'ID', csvColumn: 'ID' },
    ],

    // 更新字段映射:更新时写入预算相关字段
    updateMappings: [
      { fieldName: '予算日付', csvColumn: '予算日付' },
      { fieldName: '事業所', csvColumn: '事業所コード' },
      { fieldName: '従業員', csvColumn: '従業員コード' },
      { fieldName: 'ハイブリッド_予算（台）', csvColumn: 'ハイブリッド_予算' },
      { fieldName: '高・2缶3水_予算（台）', csvColumn: '高効率2缶3水_予算' },
      { fieldName: '高効率_予算（台）', csvColumn: '高効率_予算' },
      { fieldName: 'エアバブル_予算（台）', csvColumn: '(内)エアバブル_予算' },
    ],

    // 新增字段映射:ID 会在 upsert 插入分支中由 keyMappings 自动补齐
    insertMappings: [
      { fieldName: '予算日付', csvColumn: '予算日付' },
      { fieldName: '事業所', csvColumn: '事業所コード' },
      { fieldName: '従業員', csvColumn: '従業員コード' },
      { fieldName: 'ハイブリッド_予算（台）', csvColumn: 'ハイブリッド_予算' },
      { fieldName: '高・2缶3水_予算（台）', csvColumn: '高効率2缶3水_予算' },
      { fieldName: '高効率_予算（台）', csvColumn: '高効率_予算' },
      { fieldName: 'エアバブル_予算（台）', csvColumn: '(内)エアバブル_予算' },
    ],
  },

  // 预设7: 給湯器(月別予算)数据同步
  {
    id: 'water-heater-budget',
    name: '給湯器',
    keyword: '給湯器',
    mode: 'upsert',
    tableName: '月別予算',

    // Key: ID(文本字段) <- CSV ID
    keyMappings: [
      { fieldName: 'ID', csvColumn: 'ID' },
    ],

    // 更新字段映射:更新时写入预算相关字段
    updateMappings: [
      { fieldName: '予算日付', csvColumn: '予算日付' },
      { fieldName: '事業所', csvColumn: '事業所コード' },
      { fieldName: '従業員', csvColumn: '従業員コード' },
      { fieldName: '燃転_予算（台）', csvColumn: '燃転_予算' },
      { fieldName: '買替_予算（台）', csvColumn: '買替_予算' },
      { fieldName: '風呂切替_予算（台）', csvColumn: '風呂切替_予算' },
      { fieldName: '新設_予算（台）', csvColumn: '新設_予算' },
      { fieldName: 'その他_予算（台）', csvColumn: 'その他_予算' },
    ],

    // 新增字段映射:ID 会在 upsert 插入分支中由 keyMappings 自动补齐
    insertMappings: [
      { fieldName: '予算日付', csvColumn: '予算日付' },
      { fieldName: '事業所', csvColumn: '事業所コード' },
      { fieldName: '従業員', csvColumn: '従業員コード' },
      { fieldName: '燃転_予算（台）', csvColumn: '燃転_予算' },
      { fieldName: '買替_予算（台）', csvColumn: '買替_予算' },
      { fieldName: '風呂切替_予算（台）', csvColumn: '風呂切替_予算' },
      { fieldName: '新設_予算（台）', csvColumn: '新設_予算' },
      { fieldName: 'その他_予算（台）', csvColumn: 'その他_予算' },
    ],
  },

  // 预设8: 重点商品(月別予算)数据同步
  {
    id: 'featured-products-budget',
    name: '重点商品',
    keyword: '重点商品',
    mode: 'upsert',
    tableName: '月別予算',

    // Key: ID(文本字段) <- CSV ID
    keyMappings: [
      { fieldName: 'ID', csvColumn: 'ID' },
    ],

    // 更新字段映射:更新时写入预算相关字段
    updateMappings: [
      { fieldName: '予算日付', csvColumn: '予算日付' },
      { fieldName: '事業所', csvColumn: '事業所コード' },
      { fieldName: '従業員', csvColumn: '従業員コード' },
      { fieldName: '浴暖_予算（台）', csvColumn: '浴室暖房_予算' },
      { fieldName: 'レンジフード_予算（台）', csvColumn: 'レンジフード_予算' },
      { fieldName: 'ビルトイン_予算（台）', csvColumn: 'GTビルトインコンロ_予算' },
      { fieldName: '卓上_予算（台）', csvColumn: 'GT卓上_予算' },
      { fieldName: '暖房機_予算（台）', csvColumn: '暖房機_予算' },
      { fieldName: 'GHP_予算（台）', csvColumn: 'GHP_予算' },
      { fieldName: '蓄電池_予算（台）', csvColumn: '蓄電池_予算' },
      { fieldName: '衣類乾燥機_予算（台）', csvColumn: '衣類乾燥機_予算' },
      { fieldName: '床暖_予算（台）', csvColumn: '床暖房_予算' },
      { fieldName: 'リフォーム_予算（台）', csvColumn: 'リフォーム情報_予算' },
      { fieldName: 'PPA_予算', csvColumn: 'PPA_予算' },
      { fieldName: 'リターナブル_予算', csvColumn: 'リターナブル_予算' },
      { fieldName: 'ワンウェイ_予算', csvColumn: 'ワンウェイ_予算' },
      { fieldName: '電力_予算', csvColumn: '電力_予算' },
      { fieldName: 'サポテン_予算', csvColumn: 'サポテン_予算' },
      { fieldName: 'マイページ_予算', csvColumn: 'マイページ_予算' },
      { fieldName: 'ハウスクリーニング_予算', csvColumn: 'ハウスクリーニング_予算' },
      { fieldName: '太陽光_予算（台）', csvColumn: '太陽光発電_予算' },
      { fieldName: 'エネファーム_予算（台）', csvColumn: 'エネファーム_予算' },
      { fieldName: '新都市ガス_予算', csvColumn: '新都市ガス_予算' },
    ],

    // 新增字段映射:ID 会在 upsert 插入分支中由 keyMappings 自动补齐
    insertMappings: [
      { fieldName: '予算日付', csvColumn: '予算日付' },
      { fieldName: '事業所', csvColumn: '事業所コード' },
      { fieldName: '従業員', csvColumn: '従業員コード' },
      { fieldName: '浴暖_予算（台）', csvColumn: '浴室暖房_予算' },
      { fieldName: 'レンジフード_予算（台）', csvColumn: 'レンジフード_予算' },
      { fieldName: 'ビルトイン_予算（台）', csvColumn: 'GTビルトインコンロ_予算' },
      { fieldName: '卓上_予算（台）', csvColumn: 'GT卓上_予算' },
      { fieldName: '暖房機_予算（台）', csvColumn: '暖房機_予算' },
      { fieldName: 'GHP_予算（台）', csvColumn: 'GHP_予算' },
      { fieldName: '蓄電池_予算（台）', csvColumn: '蓄電池_予算' },
      { fieldName: '衣類乾燥機_予算（台）', csvColumn: '衣類乾燥機_予算' },
      { fieldName: '床暖_予算（台）', csvColumn: '床暖房_予算' },
      { fieldName: 'リフォーム_予算（台）', csvColumn: 'リフォーム情報_予算' },
      { fieldName: 'PPA_予算', csvColumn: 'PPA_予算' },
      { fieldName: 'リターナブル_予算', csvColumn: 'リターナブル_予算' },
      { fieldName: 'ワンウェイ_予算', csvColumn: 'ワンウェイ_予算' },
      { fieldName: '電力_予算', csvColumn: '電力_予算' },
      { fieldName: 'サポテン_予算', csvColumn: 'サポテン_予算' },
      { fieldName: 'マイページ_予算', csvColumn: 'マイページ_予算' },
      { fieldName: 'ハウスクリーニング_予算', csvColumn: 'ハウスクリーニング_予算' },
      { fieldName: '太陽光_予算（台）', csvColumn: '太陽光発電_予算' },
      { fieldName: 'エネファーム_予算（台）', csvColumn: 'エネファーム_予算' },
      { fieldName: '新都市ガス_予算', csvColumn: '新都市ガス_予算' },
    ],
  },



  // 预设9: リフォーム予算(リフォーム担当者予算)数据同步
  // 注意: 该关键词比 "予算" 更具体,必须放在前面以避免被先匹配
  {
    id: 'reform-budget',
    name: 'リフォーム予算',
    keyword: 'リフォーム予算',
    mode: 'upsert',
    tableName: 'リフォーム担当者予算',

    // Key: ID(文本字段) <- CSV ID
    keyMappings: [
      { fieldName: 'ID', csvColumn: 'ID' },
    ],

    // 更新字段映射:更新时写入リフォーム担当者予算字段
    updateMappings: [
      { fieldName: '予算日付', csvColumn: '予算日付' },
      // { fieldName: '事業所', csvColumn: '事業所コード' },
      { fieldName: '従業員', csvColumn: '従業員コード' },
      { fieldName: '売上_高', csvColumn: '売上_高' },
      { fieldName: '売上_高アクア', csvColumn: '売上_高アクア' },
      { fieldName: '売上_高ガス', csvColumn: '売上_高ガス' },
      { fieldName: '売上_高合計', csvColumn: '売上_高合計' },
      { fieldName: '売上_利益', csvColumn: '売上_利益' },
      { fieldName: '売上_利益アクア', csvColumn: '売上_利益アクア' },
      { fieldName: '売上_利益ガス', csvColumn: '売上_利益ガス' },
      { fieldName: '売上_利益合計', csvColumn: '売上_利益合計' },
      { fieldName: '成約_高', csvColumn: '成約_高' },
      { fieldName: '成約_高アクア', csvColumn: '成約_高アクア' },
      { fieldName: '成約_高ガス', csvColumn: '成約_高ガス' },
      { fieldName: '成約_高合計', csvColumn: '成約_高合計' },
      { fieldName: '成約_利益', csvColumn: '成約_利益' },
      { fieldName: '成約_利益アクア', csvColumn: '成約_利益アクア' },
      { fieldName: '成約_利益ガス', csvColumn: '成約_利益ガス' },
      { fieldName: '成約_利益合計', csvColumn: '成約_利益合計' },
      { fieldName: 'PPA件数', csvColumn: 'PPA件数' },
      { fieldName: '太陽光件数', csvColumn: '太陽光件数' },
      { fieldName: '太陽光金額', csvColumn: '太陽光金額' },
      { fieldName: '蓄電池件数', csvColumn: '蓄電池件数' },
      { fieldName: '蓄電池金額', csvColumn: '蓄電池金額' },
      { fieldName: 'その他件数', csvColumn: 'その他件数' },
      { fieldName: 'その他金額', csvColumn: 'その他金額' },
      { fieldName: '販売件数計', csvColumn: '販売件数計' },
      { fieldName: '販売金額計', csvColumn: '販売金額計' },
    ],

    // 新增字段映射:ID 会在 upsert 插入分支中由 keyMappings 自动补齐
    insertMappings: [
      { fieldName: '予算日付', csvColumn: '予算日付' },
      // { fieldName: '事業所', csvColumn: '事業所コード' },
      { fieldName: '従業員', csvColumn: '従業員コード' },
      { fieldName: '売上_高', csvColumn: '売上_高' },
      { fieldName: '売上_高アクア', csvColumn: '売上_高アクア' },
      { fieldName: '売上_高ガス', csvColumn: '売上_高ガス' },
      { fieldName: '売上_高合計', csvColumn: '売上_高合計' },
      { fieldName: '売上_利益', csvColumn: '売上_利益' },
      { fieldName: '売上_利益アクア', csvColumn: '売上_利益アクア' },
      { fieldName: '売上_利益ガス', csvColumn: '売上_利益ガス' },
      { fieldName: '売上_利益合計', csvColumn: '売上_利益合計' },
      { fieldName: '成約_高', csvColumn: '成約_高' },
      { fieldName: '成約_高アクア', csvColumn: '成約_高アクア' },
      { fieldName: '成約_高ガス', csvColumn: '成約_高ガス' },
      { fieldName: '成約_高合計', csvColumn: '成約_高合計' },
      { fieldName: '成約_利益', csvColumn: '成約_利益' },
      { fieldName: '成約_利益アクア', csvColumn: '成約_利益アクア' },
      { fieldName: '成約_利益ガス', csvColumn: '成約_利益ガス' },
      { fieldName: '成約_利益合計', csvColumn: '成約_利益合計' },
      { fieldName: 'PPA件数', csvColumn: 'PPA件数' },
      { fieldName: '太陽光件数', csvColumn: '太陽光件数' },
      { fieldName: '太陽光金額', csvColumn: '太陽光金額' },
      { fieldName: '蓄電池件数', csvColumn: '蓄電池件数' },
      { fieldName: '蓄電池金額', csvColumn: '蓄電池金額' },
      { fieldName: 'その他件数', csvColumn: 'その他件数' },
      { fieldName: 'その他金額', csvColumn: 'その他金額' },
      { fieldName: '販売件数計', csvColumn: '販売件数計' },
      { fieldName: '販売金額計', csvColumn: '販売金額計' },
    ],
  },

  // 预设10: 予算(月別予算)数据同步
  // 注意: 该关键词比较宽泛,必须放在更具体的月別予算预设后面以避免被先匹配
  // {
  //   id: 'monthly-budget',
  //   name: '予算',
  //   keyword: '予算',
  //   mode: 'upsert',
  //   tableName: '月別予算',

  //   // Key: ID(文本字段) <- CSV ID
  //   keyMappings: [
  //     { fieldName: 'ID', csvColumn: 'ID' },
  //   ],

  //   // 更新字段映射:更新时写入整套月別予算字段
  //   updateMappings: [
  //     { fieldName: '予算日付', csvColumn: '予算日付' },
  //     { fieldName: '事業所', csvColumn: '事業所コード' },
  //     { fieldName: '従業員', csvColumn: '従業員コード' },
  //     { fieldName: '器具売上高_予算', csvColumn: '器具売上高' },
  //     { fieldName: '器具利益_予算', csvColumn: '器具利益' },
  //     { fieldName: '新設件数', csvColumn: '新設件数' },
  //     { fieldName: '燃転_予算（台）', csvColumn: '燃転_予算' },
  //     { fieldName: '買替_予算（台）', csvColumn: '買替_予算' },
  //     { fieldName: '風呂切替_予算（台）', csvColumn: '風呂切替_予算' },
  //     { fieldName: '新設_予算（台）', csvColumn: '新設_予算' },
  //     { fieldName: 'その他_予算（台）', csvColumn: 'その他_予算' },
  //     { fieldName: 'ハイブリッド_予算（台）', csvColumn: 'ハイブリッド_予算' },
  //     { fieldName: '高・2缶3水_予算（台）', csvColumn: '高効率2缶3水_予算' },
  //     { fieldName: '高効率_予算（台）', csvColumn: '高効率_予算' },
  //     { fieldName: 'エアバブル_予算（台）', csvColumn: '（内）エアバブル_予算' },
  //     { fieldName: '浴暖_予算（台）', csvColumn: '浴室暖房_予算' },
  //     { fieldName: 'レンジフード_予算（台）', csvColumn: 'レンジフード_予算' },
  //     { fieldName: 'ビルトイン_予算（台）', csvColumn: 'GTビルトインコンロ_予算' },
  //     { fieldName: '卓上_予算（台）', csvColumn: 'GT卓上_予算' },
  //     { fieldName: '暖房機_予算（台）', csvColumn: '暖房機_予算' },
  //     { fieldName: 'GHP_予算（台）', csvColumn: 'GHP_予算' },
  //     { fieldName: '蓄電池_予算（台）', csvColumn: '蓄電池_予算' },
  //     { fieldName: '衣類乾燥機_予算（台）', csvColumn: '衣類乾燥機_予算' },
  //     { fieldName: '床暖_予算（台）', csvColumn: '床暖房_予算' },
  //     { fieldName: 'リフォーム_予算（台）', csvColumn: 'リフォーム情報_予算' },
  //     { fieldName: 'PPA_予算', csvColumn: 'PPA_予算' },
  //     { fieldName: 'リターナブル_予算', csvColumn: 'リターナブル_予算' },
  //     { fieldName: 'ワンウェイ_予算', csvColumn: 'ワンウェイ_予算' },
  //     { fieldName: '電力_予算', csvColumn: '電力_予算' },
  //     { fieldName: 'サポテン_予算', csvColumn: 'サポテン_予算' },
  //     { fieldName: 'マイページ_予算', csvColumn: 'マイページ_予算' },
  //     { fieldName: 'ハウスクリーニング_予算', csvColumn: 'ハウスクリーニング_予算' },
  //     { fieldName: '太陽光_予算（台）', csvColumn: '太陽光発電_予算' },
  //     { fieldName: 'エネファーム_予算（台）', csvColumn: 'エネファーム_予算' },
  //     { fieldName: '新都市ガス_予算', csvColumn: '新都市ガス_予算' },
  //   ],

  //   // 新增字段映射:ID 会在 upsert 插入分支中由 keyMappings 自动补齐
  //   insertMappings: [
  //     { fieldName: '予算日付', csvColumn: '予算日付' },
  //     { fieldName: '事業所', csvColumn: '事業所コード' },
  //     { fieldName: '従業員', csvColumn: '従業員コード' },
  //     { fieldName: '器具売上高_予算', csvColumn: '器具売上高' },
  //     { fieldName: '器具利益_予算', csvColumn: '器具利益' },
  //     { fieldName: '新設件数', csvColumn: '新設件数' },
  //     { fieldName: '燃転_予算（台）', csvColumn: '燃転_予算' },
  //     { fieldName: '買替_予算（台）', csvColumn: '買替_予算' },
  //     { fieldName: '風呂切替_予算（台）', csvColumn: '風呂切替_予算' },
  //     { fieldName: '新設_予算（台）', csvColumn: '新設_予算' },
  //     { fieldName: 'その他_予算（台）', csvColumn: 'その他_予算' },
  //     { fieldName: 'ハイブリッド_予算（台）', csvColumn: 'ハイブリッド_予算' },
  //     { fieldName: '高・2缶3水_予算（台）', csvColumn: '高効率2缶3水_予算' },
  //     { fieldName: '高効率_予算（台）', csvColumn: '高効率_予算' },
  //     { fieldName: 'エアバブル_予算（台）', csvColumn: '（内）エアバブル_予算' },
  //     { fieldName: '浴暖_予算（台）', csvColumn: '浴室暖房_予算' },
  //     { fieldName: 'レンジフード_予算（台）', csvColumn: 'レンジフード_予算' },
  //     { fieldName: 'ビルトイン_予算（台）', csvColumn: 'GTビルトインコンロ_予算' },
  //     { fieldName: '卓上_予算（台）', csvColumn: 'GT卓上_予算' },
  //     { fieldName: '暖房機_予算（台）', csvColumn: '暖房機_予算' },
  //     { fieldName: 'GHP_予算（台）', csvColumn: 'GHP_予算' },
  //     { fieldName: '蓄電池_予算（台）', csvColumn: '蓄電池_予算' },
  //     { fieldName: '衣類乾燥機_予算（台）', csvColumn: '衣類乾燥機_予算' },
  //     { fieldName: '床暖_予算（台）', csvColumn: '床暖房_予算' },
  //     { fieldName: 'リフォーム_予算（台）', csvColumn: 'リフォーム情報_予算' },
  //     { fieldName: 'PPA_予算', csvColumn: 'PPA_予算' },
  //     { fieldName: 'リターナブル_予算', csvColumn: 'リターナブル_予算' },
  //     { fieldName: 'ワンウェイ_予算', csvColumn: 'ワンウェイ_予算' },
  //     { fieldName: '電力_予算', csvColumn: '電力_予算' },
  //     { fieldName: 'サポテン_予算', csvColumn: 'サポテン_予算' },
  //     { fieldName: 'マイページ_予算', csvColumn: 'マイページ_予算' },
  //     { fieldName: 'ハウスクリーニング_予算', csvColumn: 'ハウスクリーニング_予算' },
  //     { fieldName: '太陽光_予算（台）', csvColumn: '太陽光発電_予算' },
  //     { fieldName: 'エネファーム_予算（台）', csvColumn: 'エネファーム_予算' },
  //     { fieldName: '新都市ガス_予算', csvColumn: '新都市ガス_予算' },
  //   ],
  // },

  // 预设11: 中止防止受付(中止受付情報)数据同步
  {
    id: 'service-stop-prevention',
    name: '中止防止受付',
    keyword: '中止防止受付',
    mode: 'upsert',
    tableName: '中止受付情報',

    // Key: 需要家コード(文本字段) <- CSV 需要家コード
    keyMappings: [
      { fieldName: '需要家コード', csvColumn: '需要家コード' },
    ],

    // 更新字段映射:更新时写入受付信息字段
    updateMappings: [
      { fieldName: '事業所名', csvColumn: '事業所名' },
      { fieldName: '通告到着日', csvColumn: '通告到着日' },
      { fieldName: '情報更新日', csvColumn: '情報更新日' },
    ],

    // 新增字段映射:新增时写入 Key 字段和关联字段
    insertMappings: [
      { fieldName: '需要家コード', csvColumn: '需要家コード' },
      { fieldName: '顧客名関連', csvColumn: '顧客名' },
      { fieldName: '事業所名', csvColumn: '事業所名' },
      { fieldName: '通告到着日', csvColumn: '通告到着日' },
      { fieldName: '情報更新日', csvColumn: '情報更新日' },
    ],
  },

  // 预设12: イベント目標(イベント目標)数据同步
  {
    id: 'event-target',
    name: 'イベント目標',
    keyword: 'イベント目標',
    mode: 'upsert',
    tableName: 'イベント目標',

    // Key: ID(文本字段) <- CSV ID
    keyMappings: [
      { fieldName: 'ID', csvColumn: 'ID' },
    ],

    // 更新字段映射:更新时写入イベント目標字段
    updateMappings: [
      { fieldName: '事業所', csvColumn: '事業所コード' },
      { fieldName: '事前目標_高', csvColumn: '事前目標_高' },
      { fieldName: '事前目標_利益', csvColumn: '事前目標_利益' },
      { fieldName: '当日目標_高', csvColumn: '当日目標_高' },
      { fieldName: '当日目標_利益', csvColumn: '当日目標_利益' },
      { fieldName: 'フォロー目標_高', csvColumn: 'フォロー目標_高' },
      { fieldName: 'フォロー目標_利益', csvColumn: 'フォロー目標_利益' },
      { fieldName: '当日報告_高', csvColumn: '当日報告_高' },
      { fieldName: '当日報告_利益', csvColumn: '当日報告_利益' },
      { fieldName: '会場名', csvColumn: '会場名' }, // 特殊处理，包含会場名【イベントにより変動】
      { fieldName: '開催時期', csvColumn: '開催時期' },
      { fieldName: 'きっかけ', csvColumn: 'きっかけ' },
    ],

    // 新增字段映射:ID 会在 upsert 插入分支中由 keyMappings 自动补齐
    insertMappings: [
      { fieldName: '事業所', csvColumn: '事業所コード' },
      { fieldName: '事前目標_高', csvColumn: '事前目標_高' },
      { fieldName: '事前目標_利益', csvColumn: '事前目標_利益' },
      { fieldName: '当日目標_高', csvColumn: '当日目標_高' },
      { fieldName: '当日目標_利益', csvColumn: '当日目標_利益' },
      { fieldName: 'フォロー目標_高', csvColumn: 'フォロー目標_高' },
      { fieldName: 'フォロー目標_利益', csvColumn: 'フォロー目標_利益' },
      { fieldName: '当日報告_高', csvColumn: '当日報告_高' },
      { fieldName: '当日報告_利益', csvColumn: '当日報告_利益' },
      { fieldName: '会場名', csvColumn: '会場名' }, // 特殊处理，包含会場名【イベントにより変動】
      { fieldName: '開催時期', csvColumn: '開催時期' },
      { fieldName: 'きっかけ', csvColumn: 'きっかけ' },
    ],
  },

  // 预设13: 大家顧客登録(顧客管理)数据同步
  {
    id: 'landlord-customer-registration',
    name: '大家顧客登録',
    keyword: '大家顧客登録',
    mode: 'upsert',
    tableName: '顧客管理',

    // Key: 大家コード★(文本字段) <- CSV 大家コード★
    keyMappings: [
      { fieldName: '大家コード★', csvColumn: '大家コード★' },
    ],

    // 更新字段映射:更新时写入大家/顧客基础信息
    updateMappings: [
      { fieldName: '大家★電話番号', csvColumn: '大家★電話番号' }, // CSV 原列名末尾可能带全角空格
      { fieldName: '顧客名', csvColumn: '顧客名' },
      { fieldName: '自社担当部署1(主担当)', csvColumn: '主担当（自社担当部署）' }, // 该列填写的是事業所名
      { fieldName: '郵便番号', csvColumn: '郵便番号' },
      { fieldName: '住所', csvColumn: '住所' },
    ],

    // 新增字段映射:新增时写入 Key 字段和基础信息
    insertMappings: [
      { fieldName: '大家コード★', csvColumn: '大家コード★' },
      { fieldName: '大家★電話番号', csvColumn: '大家★電話番号' }, // CSV 原列名末尾可能带全角空格
      { fieldName: '顧客名', csvColumn: '顧客名' },
      { fieldName: '自社担当部署1(主担当)', csvColumn: '主担当（自社担当部署）' }, // 该列填写的是事業所名
      { fieldName: '郵便番号', csvColumn: '郵便番号' },
      { fieldName: '住所', csvColumn: '住所' },
    ],
  },

  // 预设14: 物件情報(集合物件情報)数据同步
  {
    id: 'property-information',
    name: '物件情報',
    keyword: '物件情報',
    mode: 'upsert',
    tableName: '集合物件情報',

    // 复合 Key: 需要家コード + 大家★電話番号
    keyMappings: [
      { fieldName: '需要家コード', csvColumn: '需要家コード' },
      { fieldName: '大家★電話番号', csvColumn: '大家★電話番号' },
    ],

    // 更新字段映射:更新时写入物件基础信息
    updateMappings: [
      { fieldName: '物件名', csvColumn: '物件名' },
      { fieldName: '物件住所', csvColumn: '物件住所' },
    ],

    // 新增字段映射:新增时写入 Key 字段、关联字段和物件基础信息
    insertMappings: [
      { fieldName: '需要家コード', csvColumn: '需要家コード' },
      { fieldName: '大家★電話番号', csvColumn: '大家★電話番号' }, // CSV 原列名末尾可能带全角空格
      { fieldName: '顧客関連', csvColumn: '顧客名' },
      { fieldName: '物件名', csvColumn: '物件名' },
      { fieldName: '物件住所', csvColumn: '物件住所' },
    ],
  },

  // 预设15: 中止インポート(顧客管理)数据同步
  {
    id: 'cancellation-import',
    name: '中止インポート',
    keyword: '中止インポート',
    mode: 'update',
    tableName: '顧客管理',

    // Key: 大家コード★(文本字段) <- CSV 大家コード★
    keyMappings: [
      { fieldName: '大家コード★', csvColumn: '大家コード★' },
    ],

    // 更新字段映射:更新时写入顧客基础信息
    updateMappings: [
      { fieldName: '顧客名', csvColumn: '顧客名' },
      { fieldName: '取引区分', csvColumn: '取引区分' },
    ],

    // 新增字段映射:空数组(update 模式不新增记录)
    insertMappings: [],
  },

  // 预设16: 大家管理会社情報(大家・管理会社情報)数据同步
  {
    id: 'landlord-management-company-information',
    name: '大家管理会社情報',
    keyword: '大家管理会社情報',
    mode: 'upsert',
    tableName: '大家・管理会社情報',

    // Key: 需要家コード(文本字段) <- CSV 需要家コード
    keyMappings: [
      { fieldName: '需要家コード', csvColumn: '需要家コード' },
    ],

    // 更新字段映射:更新时写入大家/管理会社基础信息
    updateMappings: [
      { fieldName: '大家需要家コード', csvColumn: '大家需要家コード' },
      { fieldName: '大家氏名', csvColumn: '大家氏名' },
      { fieldName: '大家住所', csvColumn: '大家住所' },
      { fieldName: '管理会社名', csvColumn: '管理会社名' },
      { fieldName: '管理会社住所', csvColumn: '管理会社住所' },
    ],

    // 新增字段映射:新增时写入 Key 字段、关联字段和基础信息
    insertMappings: [
      { fieldName: '需要家コード', csvColumn: '需要家コード' },
      { fieldName: '顧客関連', csvColumn: '顧客名' },
      { fieldName: '大家需要家コード', csvColumn: '大家需要家コード' },
      { fieldName: '大家氏名', csvColumn: '大家氏名' },
      { fieldName: '大家住所', csvColumn: '大家住所' },
      { fieldName: '管理会社名', csvColumn: '管理会社名' },
      { fieldName: '管理会社住所', csvColumn: '管理会社住所' },
    ],
  },

  // 预设17: 空インポート_TGL(顧客管理)数据同步
  // 注意: 该关键词比 "TGL" 更具体,必须放在前面以避免被先匹配
  {
    id: 'empty-import-tgl',
    name: '空インポート_TGL',
    keyword: '空インポート_TGL',
    mode: 'empty',
    tableName: '顧客管理',

    // Key: 需要家コード(文本字段) <- CSV 需要家コード
    keyMappings: [
      { fieldName: '需要家コード', csvColumn: '需要家コード' },
    ],

    // 更新字段映射:empty 模式下这些字段会在匹配成功后被清空
    updateMappings: [
      // { fieldName: '顧客名', csvColumn: '顧客名' },
      { fieldName: 'コンロスコア', csvColumn: 'コンロスコア' },
      { fieldName: '給湯器スコア', csvColumn: '給湯器スコア' },
      { fieldName: '年齢', csvColumn: '年齢' },
      { fieldName: 'スコア内訳', csvColumn: 'スコア内訳' },
      { fieldName: 'TGL更新日', csvColumn: 'TGL更新日' },
    ],

    // 新增字段映射:空数组(empty 模式不新增记录)
    insertMappings: [],
  },

  // 预设18: TGL(顧客管理)数据同步
  {
    id: 'tgl',
    name: 'TGL',
    keyword: 'TGL',
    mode: 'update',
    tableName: '顧客管理',

    // Key: 需要家コード(文本字段) <- CSV 需要家コード
    keyMappings: [
      { fieldName: '需要家コード', csvColumn: '需要家コード' },
    ],

    // 更新字段映射:更新时写入 TGL 评分信息
    updateMappings: [
      { fieldName: '顧客名', csvColumn: '顧客名' },
      { fieldName: 'コンロスコア', csvColumn: 'コンロスコア' },
      { fieldName: '給湯器スコア', csvColumn: '給湯器スコア' },
      { fieldName: '年齢', csvColumn: '年齢' },
      { fieldName: 'スコア内訳', csvColumn: 'スコア内訳' },
      { fieldName: 'TGL更新日', csvColumn: 'TGL更新日' },
    ],

    // 新增字段映射:空数组(update 模式不新增记录)
    insertMappings: [],
  },

  // 预设19: マイページ情報(顧客管理)数据同步
  {
    id: 'mypage-information',
    name: 'マイページ情報',
    keyword: 'マイページ情報',
    mode: 'update',
    tableName: '顧客管理',

    // Key: 需要家コード(文本字段) <- CSV 需要家コード
    keyMappings: [
      { fieldName: '需要家コード', csvColumn: '需要家コード' },
    ],

    // 更新字段映射:更新时写入マイページ状态信息
    updateMappings: [
      { fieldName: '顧客名', csvColumn: '顧客名' },
      { fieldName: 'マイページ加入対象', csvColumn: 'マイページ加入対象' },
      { fieldName: 'マイページ加入状況', csvColumn: 'マイページ加入状況' },
      { fieldName: 'マイページ更新日', csvColumn: 'マイページ更新日' },
    ],

    // 新增字段映射:空数组(update 模式不新增记录)
    insertMappings: [],
  },

  // 预设20: イベント来場履歴_需要家コード(顧客管理)数据同步
  {
    id: 'event-visit-history-by-customer-code',
    name: 'イベント来場履歴_需要家コード',
    keyword: 'イベント来場履歴_需要家コード',
    mode: 'update',
    tableName: '顧客管理',

    // Key: 需要家コード(文本字段) <- CSV 需要家コード
    keyMappings: [
      { fieldName: '需要家コード', csvColumn: '需要家コード' },
    ],

    // 更新字段映射:更新时写入历年秋イベント来場信息
    updateMappings: [
      { fieldName: '顧客名', csvColumn: '顧客名' },
      { fieldName: '2025年度秋イベント', csvColumn: '2025年度秋イベント' },
      { fieldName: '2024年度秋イベント', csvColumn: '2024年度秋イベント' },
      { fieldName: '2023年度秋イベント', csvColumn: '2023年度秋イベント' },
    ],

    // 新增字段映射:空数组(update 模式不新增记录)
    insertMappings: [],
  },

  // 预设21: イベント来場履歴_統合ID(顧客管理)数据同步
  {
    id: 'event-visit-history-by-unified-id',
    name: 'イベント来場履歴_統合ID',
    keyword: 'イベント来場履歴_統合ID',
    mode: 'update',
    tableName: '顧客管理',

    // Key: 統合ID(文本字段) <- CSV 統合ID
    keyMappings: [
      { fieldName: '統合ID', csvColumn: '統合ID' },
    ],

    // 更新字段映射:更新时写入历年秋イベント来場信息
    updateMappings: [
      { fieldName: '顧客名', csvColumn: '顧客名' },
      { fieldName: '2025年度秋イベント', csvColumn: '2025年度秋イベント' },
      { fieldName: '2024年度秋イベント', csvColumn: '2024年度秋イベント' },
      { fieldName: '2023年度秋イベント', csvColumn: '2023年度秋イベント' },
    ],

    // 新增字段映射:空数组(update 模式不新增记录)
    insertMappings: [],
  },

  // 预设22: 空インポート_TLC情報(顧客管理)数据同步
  // 注意: 该关键词比 "TLC情報" 更具体,必须放在前面以避免被先匹配
  {
    id: 'empty-import-tlc-information',
    name: '空インポート_TLC情報',
    keyword: '空インポート_TLC情報',
    mode: 'empty',
    tableName: '顧客管理',

    // Key: 需要家コード(文本字段) <- CSV 需要家コード
    keyMappings: [
      { fieldName: '需要家コード', csvColumn: '需要家コード' },
    ],

    // 更新字段映射:empty 模式下这些字段会在匹配成功后被清空
    updateMappings: [
      // { fieldName: '統合ID', csvColumn: '統合ID' },
      { fieldName: 'TLC会員ID', csvColumn: 'TLC会員ID' },
      { fieldName: '利用可能ポイント数', csvColumn: '利用可能ポイント数' },
      { fieldName: 'TLCポイントデータ更新日', csvColumn: 'TLCポイントデータ更新日' },
      { fieldName: '失効予定ポイント数', csvColumn: '失効予定ポイント数' },
      { fieldName: 'ポイント直近失効日', csvColumn: 'ポイント直近失効日' },
      { fieldName: 'TLC情報（2枚目以降）', csvColumn: 'TLC情報（2枚目以降）' },
    ],

    // 新增字段映射:空数组(empty 模式不新增记录)
    insertMappings: [],
  },

  // 预设23: TLC情報(顧客管理)数据同步
  {
    id: 'tlc-information',
    name: 'TLC情報',
    keyword: 'TLC情報',
    mode: 'update',
    tableName: '顧客管理',

    // Key: 需要家コード(文本字段) <- CSV 需要家コード
    keyMappings: [
      { fieldName: '需要家コード', csvColumn: '需要家コード' },
    ],

    // 更新字段映射:更新时写入 TLC 会員/ポイント信息
    updateMappings: [
      { fieldName: '統合ID', csvColumn: '統合ID' },
      { fieldName: 'TLC会員ID', csvColumn: 'TLC会員ID' },
      { fieldName: '利用可能ポイント数', csvColumn: '利用可能ポイント数' },
      { fieldName: 'TLCポイントデータ更新日', csvColumn: 'TLCポイントデータ更新日' },
      { fieldName: '失効予定ポイント数', csvColumn: '失効予定ポイント数' },
      { fieldName: 'ポイント直近失効日', csvColumn: 'ポイント直近失効日' },
      { fieldName: 'TLC情報（2枚目以降）', csvColumn: 'TLC情報（2枚目以降）' },
    ],

    // 新增字段映射:空数组(update 模式不新增记录)
    insertMappings: [],
  },

  // 预设24: 空インポート_他社グループ顧客(顧客管理)数据同步
  // 注意: 该关键词比 "他社グループ顧客" 更具体,必须放在前面以避免被先匹配
  {
    id: 'empty-import-other-group-customer',
    name: '空インポート_他社グループ顧客',
    keyword: '空インポート_他社グループ顧客',
    mode: 'empty',
    tableName: '顧客管理',

    // Key: 統合ID(文本字段) <- CSV 統合ID
    keyMappings: [
      { fieldName: '統合ID', csvColumn: '統合ID' },
    ],

    // 更新字段映射:empty 模式下这些字段会在匹配成功后被清空
    updateMappings: [
      // { fieldName: '顧客名', csvColumn: '顧客名' },
      // { fieldName: '顧客名（カナ）', csvColumn: '顧客名（カナ）' },
      { fieldName: '住所', csvColumn: '住所' },
      { fieldName: '建物名', csvColumn: '建物名' },
      { fieldName: '戸建・集合（潜在顧客のみ）', csvColumn: '戸建・集合' },
      { fieldName: '郵便番号', csvColumn: '郵便番号' },
      { fieldName: '自社担当者1(主担当)', csvColumn: '主担当（自社担当部署）' },
      // { fieldName: '自社担当部署1(主担当)', csvColumn: '主担当（自社担当部署）' }, // 同一个 CSV 列同时写入担当者和担当部署
      { fieldName: '年齢', csvColumn: '年齢' },
      { fieldName: 'TKアクア', csvColumn: 'TKアクア' },
      { fieldName: 'トコちゃんねる', csvColumn: 'トコちゃんねる静岡' },
      { fieldName: 'CATV', csvColumn: 'CATV' },
      { fieldName: 'TLC会員ID', csvColumn: 'TLC会員ID' },
      { fieldName: '失効予定ポイント数', csvColumn: '失効予定ポイント数' },
      { fieldName: 'ポイント直近失効日', csvColumn: 'ポイント直近失効日' },
      { fieldName: '利用可能ポイント数', csvColumn: '利用可能ポイント数' },
      { fieldName: '他社サービス更新日', csvColumn: '他サービス更新日' },
    ],

    // 新增字段映射:空数组(empty 模式不新增记录)
    insertMappings: [],
  },

  // 预设25: 他社グループ顧客(顧客管理)数据同步
  {
    id: 'other-group-customer',
    name: '他社グループ顧客',
    keyword: '他社グループ顧客',
    mode: 'upsert',
    tableName: '顧客管理',

    // Key: 統合ID(文本字段) <- CSV 統合ID
    keyMappings: [
      { fieldName: '統合ID', csvColumn: '統合ID' },
    ],

    // 更新字段映射:更新时写入他社グループ顧客基础信息
    updateMappings: [
      { fieldName: '顧客名', csvColumn: '顧客名' },
      { fieldName: '顧客名（カナ）', csvColumn: '顧客名（カナ）' },
      { fieldName: '住所', csvColumn: '住所' },
      { fieldName: '建物名', csvColumn: '建物名' },
      { fieldName: '戸建・集合（潜在顧客のみ）', csvColumn: '戸建・集合' },
      { fieldName: '郵便番号', csvColumn: '郵便番号' },
      { fieldName: '自社担当者1(主担当)', csvColumn: '主担当（自社担当部署）' },
      // { fieldName: '自社担当部署1(主担当)', csvColumn: '主担当（自社担当部署）' }, // 同一个 CSV 列同时写入担当者和担当部署
      { fieldName: '年齢', csvColumn: '年齢' },
      { fieldName: 'TKアクア', csvColumn: 'TKアクア' },
      { fieldName: 'トコちゃんねる', csvColumn: 'トコちゃんねる静岡' },
      { fieldName: 'CATV', csvColumn: 'CATV' },
      { fieldName: 'TLC会員ID', csvColumn: 'TLC会員ID' },
      { fieldName: '失効予定ポイント数', csvColumn: '失効予定ポイント数' },
      { fieldName: 'ポイント直近失効日', csvColumn: 'ポイント直近失効日' },
      { fieldName: '利用可能ポイント数', csvColumn: '利用可能ポイント数' },
      { fieldName: '他社サービス更新日', csvColumn: '他サービス更新日' },
    ],

    // 新增字段映射:新增时写入 Key 字段和基础信息
    insertMappings: [
      { fieldName: '統合ID', csvColumn: '統合ID' },
      { fieldName: '顧客名', csvColumn: '顧客名' },
      { fieldName: '顧客名（カナ）', csvColumn: '顧客名（カナ）' },
      { fieldName: '住所', csvColumn: '住所' },
      { fieldName: '建物名', csvColumn: '建物名' },
      { fieldName: '戸建・集合（潜在顧客のみ）', csvColumn: '戸建・集合' },
      { fieldName: '郵便番号', csvColumn: '郵便番号' },
      { fieldName: '自社担当者1(主担当)', csvColumn: '主担当（自社担当部署）' },
      // { fieldName: '自社担当部署1(主担当)', csvColumn: '主担当（自社担当部署）' }, // 同一个 CSV 列同时写入担当者和担当部署
      { fieldName: '年齢', csvColumn: '年齢' },
      { fieldName: 'TKアクア', csvColumn: 'TKアクア' },
      { fieldName: 'トコちゃんねる', csvColumn: 'トコちゃんねる静岡' },
      { fieldName: 'CATV', csvColumn: 'CATV' },
      { fieldName: 'TLC会員ID', csvColumn: 'TLC会員ID' },
      { fieldName: '失効予定ポイント数', csvColumn: '失効予定ポイント数' },
      { fieldName: 'ポイント直近失効日', csvColumn: 'ポイント直近失効日' },
      { fieldName: '利用可能ポイント数', csvColumn: '利用可能ポイント数' },
      { fieldName: '他社サービス更新日', csvColumn: '他サービス更新日' },
    ],
  },

  // 预设26: 空インポート_在宅見込情報(在宅見込情報)数据同步
  // 注意: 该关键词比 "在宅見込情報" 更具体,必须放在前面以避免被先匹配
  {
    id: 'empty-import-at-home-prospect-information',
    name: '空インポート_在宅見込情報',
    keyword: '空インポート_在宅見込情報',
    mode: 'empty',
    tableName: '在宅見込情報',

    // Key: 需要家コード(文本字段) <- CSV 需要家コード
    keyMappings: [
      { fieldName: '需要家コード', csvColumn: '需要家コード' },
    ],

    // 更新字段映射:empty 模式下这些字段会在匹配成功后被清空
    updateMappings: [
      { fieldName: '信頼度', csvColumn: '信頼度' },
      { fieldName: '月／午前', csvColumn: '月/午前' },
      { fieldName: '月／午後', csvColumn: '月/午後' },
      { fieldName: '月／夜間', csvColumn: '月/夜間' },
      { fieldName: '火／午前', csvColumn: '火/午前' },
      { fieldName: '火／午後', csvColumn: '火/午後' },
      { fieldName: '火／夜間', csvColumn: '火/夜間' },
      { fieldName: '水／午前', csvColumn: '水/午前' },
      { fieldName: '水／午後', csvColumn: '水/午後' },
      { fieldName: '水／夜間', csvColumn: '水/夜間' },
      { fieldName: '木／午前', csvColumn: '木/午前' },
      { fieldName: '木／午後', csvColumn: '木/午後' },
      { fieldName: '木／夜間', csvColumn: '木/夜間' },
      { fieldName: '金／午前', csvColumn: '金/午前' },
      { fieldName: '金／午後', csvColumn: '金/午後' },
      { fieldName: '金／夜間', csvColumn: '金/夜間' },
      { fieldName: '土／午前', csvColumn: '土/午前' },
      { fieldName: '土／午後', csvColumn: '土/午後' },
      { fieldName: '土／夜間', csvColumn: '土/夜間' },
      { fieldName: '日／午前', csvColumn: '日/午前' },
      { fieldName: '日／午後', csvColumn: '日/午後' },
      { fieldName: '日／夜間', csvColumn: '日/夜間' },
      { fieldName: '更新日', csvColumn: '更新日' },
    ],

    // 新增字段映射:空数组(empty 模式不新增记录)
    insertMappings: [],
  },

  // 预设27: 在宅見込情報(在宅見込情報)数据同步
  {
    id: 'at-home-prospect-information',
    name: '在宅見込情報',
    keyword: '在宅見込情報',
    mode: 'update',
    tableName: '在宅見込情報',

    // Key: 需要家コード(文本字段) <- CSV 需要家コード
    keyMappings: [
      { fieldName: '需要家コード', csvColumn: '需要家コード' },
    ],

    // 更新字段映射:更新时写入曜日/时段在宅见込信息
    updateMappings: [
      { fieldName: '信頼度', csvColumn: '信頼度' },
      { fieldName: '月／午前', csvColumn: '月/午前' },
      { fieldName: '月／午後', csvColumn: '月/午後' },
      { fieldName: '月／夜間', csvColumn: '月/夜間' },
      { fieldName: '火／午前', csvColumn: '火/午前' },
      { fieldName: '火／午後', csvColumn: '火/午後' },
      { fieldName: '火／夜間', csvColumn: '火/夜間' },
      { fieldName: '水／午前', csvColumn: '水/午前' },
      { fieldName: '水／午後', csvColumn: '水/午後' },
      { fieldName: '水／夜間', csvColumn: '水/夜間' },
      { fieldName: '木／午前', csvColumn: '木/午前' },
      { fieldName: '木／午後', csvColumn: '木/午後' },
      { fieldName: '木／夜間', csvColumn: '木/夜間' },
      { fieldName: '金／午前', csvColumn: '金/午前' },
      { fieldName: '金／午後', csvColumn: '金/午後' },
      { fieldName: '金／夜間', csvColumn: '金/夜間' },
      { fieldName: '土／午前', csvColumn: '土/午前' },
      { fieldName: '土／午後', csvColumn: '土/午後' },
      { fieldName: '土／夜間', csvColumn: '土/夜間' },
      { fieldName: '日／午前', csvColumn: '日/午前' },
      { fieldName: '日／午後', csvColumn: '日/午後' },
      { fieldName: '日／夜間', csvColumn: '日/夜間' },
      { fieldName: '更新日', csvColumn: '更新日' },
    ],

    // 新增字段映射:空数组(update 模式不新增记录)
    insertMappings: [],
  },

  // 预设28: ゼンリン顧客データ(顧客管理)数据同步
  {
    id: 'zenrin-customer-data',
    name: 'ゼンリン顧客データ',
    keyword: 'ゼンリン顧客データ',
    mode: 'upsert',
    tableName: '顧客管理',

    // Key: SZコード(文本字段) <- CSV SZコード※ゼンリン地図アプリの顧客コード
    keyMappings: [
      { fieldName: 'SZコード', csvColumn: 'SZコード' },
    ],

    // 更新字段映射:更新时写入ゼンリン顧客基础信息
    updateMappings: [
      { fieldName: 'SZ更新日', csvColumn: 'SZ更新日' },
      { fieldName: '顧客名', csvColumn: '顧客名' },
      { fieldName: '住所', csvColumn: '住所' },
      { fieldName: '郵便番号', csvColumn: '郵便番号' },
      { fieldName: '自社担当者1(主担当)', csvColumn: '主担当（自社担当部署）' },
      // { fieldName: '自社担当部署1(主担当)', csvColumn: '主担当（自社担当部署）' }, // 同一个 CSV 列同时写入担当者和担当部署
      // { fieldName: '電話番号', csvColumn: '電話番号' },
      { fieldName: '他社情報', csvColumn: '他社情報' },
      { fieldName: 'その他会社名', csvColumn: 'その他会社名' },
    ],

    // 新增字段映射:新增时写入 Key 字段和基础信息
    insertMappings: [
      { fieldName: 'SZコード', csvColumn: 'SZコード' },
      { fieldName: 'SZ更新日', csvColumn: 'SZ更新日' },
      { fieldName: '顧客名', csvColumn: '顧客名' },
      { fieldName: '住所', csvColumn: '住所' },
      { fieldName: '郵便番号', csvColumn: '郵便番号' },
      { fieldName: '自社担当者1(主担当)', csvColumn: '主担当（自社担当部署）' },
      // { fieldName: '自社担当部署1(主担当)', csvColumn: '主担当（自社担当部署）' }, // 同一个 CSV 列同时写入担当者和担当部署
      // { fieldName: '電話番号', csvColumn: '電話番号' },
      { fieldName: '他社情報', csvColumn: '他社情報' },
      { fieldName: 'その他会社名', csvColumn: 'その他会社名' },
    ],
  },

  // 预设29: DM履歴(顧客管理)数据同步
  {
    id: 'dm-history',
    name: 'DM履歴',
    keyword: 'DM履歴',
    mode: 'update',
    tableName: '顧客管理',

    // Key: 需要家コード(文本字段) <- CSV 需要家コード
    keyMappings: [
      { fieldName: '需要家コード', csvColumn: '需要家コード' },
    ],

    // 更新字段映射:更新时写入 DM 履歴信息
    updateMappings: [
      { fieldName: 'DM履歴', csvColumn: 'DM履歴' },
      { fieldName: '顧客名', csvColumn: '顧客名' },
    ],

    // 新增字段映射:空数组(update 模式不新增记录)
    insertMappings: [],
  },

  // 预设30: 自社担当者(顧客管理)数据同步
  {
    id: 'internal-person-in-charge',
    name: '自社担当者',
    keyword: '自社担当者',
    mode: 'update',
    tableName: '顧客管理',

    // Key: 需要家コード(文本字段) <- CSV 需要家コード
    keyMappings: [
      { fieldName: '需要家コード', csvColumn: '需要家コード' },
    ],

    // 更新字段映射:更新时写入自社担当者信息
    updateMappings: [
      { fieldName: '自社担当者1(主担当)', csvColumn: '自社担当者' },
      { fieldName: '顧客名', csvColumn: '顧客名' },
    ],

    // 新增字段映射:空数组(update 模式不新增记录)
    insertMappings: [],
  },

  // 预设31: 営利評価(顧客管理)数据同步
  {
    id: 'profitability-evaluation',
    name: '営利評価',
    keyword: '営利評価',
    mode: 'update',
    tableName: '顧客管理',

    // Key: 需要家コード(文本字段) <- CSV 需要家コード
    keyMappings: [
      { fieldName: '需要家コード', csvColumn: '需要家コード' },
    ],

    // 更新字段映射:更新时写入営利評価信息
    updateMappings: [
      { fieldName: '営利評価', csvColumn: '営利評価' },
      { fieldName: '顧客名', csvColumn: '顧客名' },
    ],

    // 新增字段映射:空数组(update 模式不新增记录)
    insertMappings: [],
  },

  // 预设32: 案件(案件管理)数据同步
  {
    id: 'project-management',
    name: '案件',
    keyword: '案件',
    mode: 'upsert',
    tableName: '案件管理',

    // 复合 Key: 案件コード + eSMコード
    keyMappings: [
      { fieldName: '案件コード', csvColumn: '案件コード' },
      { fieldName: 'eSMコード', csvColumn: 'eSMコード' },
      { fieldName: '訪問内容', csvColumn: '訪問内容' },
    ],

    // 更新字段映射:更新时写入案件基础信息
    updateMappings: [
      { fieldName: '顧客管理', csvColumn: '顧客名' },
      // { fieldName: '訪問内容', csvColumn: '訪問内容' }, // 这里按 CSV「訪問内容」写入,并作为進捗状況拆分的判断依据
      { fieldName: '案件名', csvColumn: '案件名' },
      { fieldName: '進捗状況＜器具＞', csvColumn: '進捗状況', conditionCsvColumn: '訪問内容', conditionIncludes: '器具' },
      { fieldName: '進捗状況＜新設＞', csvColumn: '進捗状況', conditionCsvColumn: '訪問内容', conditionIncludes: '新設' },
      { fieldName: '進捗状況＜リフォーム＞', csvColumn: '進捗状況', conditionCsvColumn: '訪問内容', conditionIncludes: 'リフォーム' },
      { fieldName: '進捗状況＜受付＞', csvColumn: '進捗状況', conditionCsvColumn: '訪問内容', conditionIncludes: '受付' },
      { fieldName: '営業状況（PPAのみ）', csvColumn: '営業状況（PPAのみ）' },
      { fieldName: '分類', csvColumn: '分類' },
      { fieldName: '商談内容', csvColumn: '商談内容' },
      { fieldName: 'WRSコード', csvColumn: 'WRSコード' },
      { fieldName: '顧客属性', csvColumn: '顧客属性' },
      { fieldName: '情報源', csvColumn: '情報源' },
      { fieldName: 'イベント開催日', csvColumn: 'イベント開催日' },
      { fieldName: 'イベント会場', csvColumn: 'イベント会場' },
      { fieldName: '競合', csvColumn: '競合' },
      { fieldName: '競合先', csvColumn: '競合先' },
      { fieldName: '成約予定日', csvColumn: '成約予定日' },
      { fieldName: '売上予定日', csvColumn: '売上予定日' },
      { fieldName: '情報提供会社', csvColumn: '情報提供会社' },
      { fieldName: 'その他情報提供会社', csvColumn: 'その他情報提供会社' },
      { fieldName: '情報提供者所属', csvColumn: '情報提供者所属' },
      { fieldName: '情報提供事業所', csvColumn: '情報提供事業所' },
      { fieldName: '情報提供者名', csvColumn: '情報提供者名' },
      { fieldName: '自社担当者1(主担当)', csvColumn: '主担当者' },
      { fieldName: '自社担当部署1(主担当)', csvColumn: '主担当(自社担当部署)' },
      { fieldName: '商品名', csvColumn: '商品名（商品）' },
      { fieldName: '成約理由', csvColumn: '成約理由' },
      { fieldName: '成約理由詳細', csvColumn: '成約理由詳細' },
      { fieldName: '敗戦理由(リフォーム)', csvColumn: '敗戦理由（リフォーム）' },
      { fieldName: '敗戦理由詳細', csvColumn: '敗戦理由詳細' },
    ],

    // 新增字段映射:需求未单独列出时,按现有 upsert 规则复用更新字段
    insertMappings: [
      { fieldName: '顧客管理', csvColumn: '顧客名' },
      { fieldName: '訪問内容', csvColumn: '訪問内容' }, // 这里按 CSV「訪問内容」写入,并作为進捗状況拆分的判断依据
      { fieldName: '案件名', csvColumn: '案件名' },
      { fieldName: '進捗状況＜器具＞', csvColumn: '進捗状況', conditionCsvColumn: '訪問内容', conditionIncludes: '器具' },
      { fieldName: '進捗状況＜新設＞', csvColumn: '進捗状況', conditionCsvColumn: '訪問内容', conditionIncludes: '新設' },
      { fieldName: '進捗状況＜リフォーム＞', csvColumn: '進捗状況', conditionCsvColumn: '訪問内容', conditionIncludes: 'リフォーム' },
      { fieldName: '進捗状況＜受付＞', csvColumn: '進捗状況', conditionCsvColumn: '訪問内容', conditionIncludes: '受付' },
      { fieldName: '営業状況（PPAのみ）', csvColumn: '営業状況（PPAのみ）' },
      { fieldName: '分類', csvColumn: '分類' },
      { fieldName: '商談内容', csvColumn: '商談内容' },
      { fieldName: 'WRSコード', csvColumn: 'WRSコード' },
      { fieldName: '顧客属性', csvColumn: '顧客属性' },
      { fieldName: '情報源', csvColumn: '情報源' },
      { fieldName: 'イベント開催日', csvColumn: 'イベント開催日' },
      { fieldName: 'イベント会場', csvColumn: 'イベント会場' },
      { fieldName: '競合', csvColumn: '競合' },
      { fieldName: '競合先', csvColumn: '競合先' },
      { fieldName: '成約予定日', csvColumn: '成約予定日' },
      { fieldName: '売上予定日', csvColumn: '売上予定日' },
      { fieldName: '情報提供会社', csvColumn: '情報提供会社' },
      { fieldName: 'その他情報提供会社', csvColumn: 'その他情報提供会社' },
      { fieldName: '情報提供者所属', csvColumn: '情報提供者所属' },
      { fieldName: '情報提供事業所', csvColumn: '情報提供事業所' },
      { fieldName: '情報提供者名', csvColumn: '情報提供者名' },
      { fieldName: '自社担当者1(主担当)', csvColumn: '主担当者' },
      { fieldName: '自社担当部署1(主担当)', csvColumn: '主担当(自社担当部署)' },
      { fieldName: '商品名', csvColumn: '商品名（商品）' },
      { fieldName: '成約理由', csvColumn: '成約理由' },
      { fieldName: '成約理由詳細', csvColumn: '成約理由詳細' },
      { fieldName: '敗戦理由(リフォーム)', csvColumn: '敗戦理由（リフォーム）' },
      { fieldName: '敗戦理由詳細', csvColumn: '敗戦理由詳細' },
    ],
  },

  // 预设33: 新設他社情報更新(顧客管理)数据同步
  {
    id: 'new-install-other-company-info-update',
    name: '新設他社情報更新',
    keyword: '新設他社情報更新',
    mode: 'update',
    tableName: '顧客管理',

    // Key: 需要家コード(文本字段) <- CSV 需要家コード
    keyMappings: [
      { fieldName: '需要家コード', csvColumn: '需要家コード' },
    ],

    // 更新字段映射:更新时写入他社情報
    updateMappings: [
      { fieldName: '他社情報', csvColumn: '他社情報' },
      { fieldName: '顧客名', csvColumn: '顧客名' },
    ],

    // 新增字段映射:空数组(update 模式不新增记录)
    insertMappings: [],
  },

  // 预设34: 顧客情報更新(顧客管理)数据同步
  {
    id: 'customer-information-update',
    name: '顧客情報更新',
    keyword: '顧客情報更新',
    mode: 'update',
    tableName: '顧客管理',

    // Key: 需要家コード(文本字段) <- CSV 需要家コード
    keyMappings: [
      { fieldName: '需要家コード', csvColumn: '需要家コード' },
    ],

    // 更新字段映射:更新时写入顾客状态信息
    updateMappings: [
      { fieldName: 'DM NGフラグ', csvColumn: 'DM NGフラグ' },
      { fieldName: 'サポテン契約ステータス', csvColumn: 'サポテン契約ステータス' },
      { fieldName: '顧客名', csvColumn: '顧客名' },
    ],

    // 新增字段映射:空数组(update 模式不新增记录)
    insertMappings: [],
  },

  // 预设35: 空インポート_安心補償付き対象リスト(顧客管理)数据同步
  // 注意: 该关键词比 "安心補償付き対象リスト" 更具体,必须放在前面以避免被先匹配
  {
    id: 'empty-import-safety-compensation-target-list',
    name: '空インポート_安心補償付き対象リスト',
    keyword: '空インポート_安心補償付き対象リスト',
    mode: 'empty',
    tableName: '顧客管理',

    // Key: 需要家コード(文本字段) <- CSV 需要家コード
    keyMappings: [
      { fieldName: '需要家コード', csvColumn: '需要家コード' },
    ],

    // 更新字段映射:empty 模式下这些字段会在匹配成功后被清空
    updateMappings: [
      { fieldName: '安心補償付きLPガス需要家', csvColumn: '安心補償付きLPガス需要家' },
      // { fieldName: '顧客名', csvColumn: '顧客名' },
    ],

    // 新增字段映射:空数组(empty 模式不新增记录)
    insertMappings: [],
  },

  // 预设36: 安心補償付き対象リスト(顧客管理)数据同步
  {
    id: 'safety-compensation-target-list',
    name: '安心補償付き対象リスト',
    keyword: '安心補償付き対象リスト',
    mode: 'update',
    tableName: '顧客管理',

    // Key: 需要家コード(文本字段) <- CSV 需要家コード
    keyMappings: [
      { fieldName: '需要家コード', csvColumn: '需要家コード' },
    ],

    // 更新字段映射:更新时写入安心補償状态
    updateMappings: [
      { fieldName: '安心補償付きLPガス需要家', csvColumn: '安心補償付きLPガス需要家' },
      { fieldName: '顧客名', csvColumn: '顧客名' },
    ],

    // 新增字段映射:空数组(update 模式不新增记录)
    insertMappings: [],
  },

  // 预设37: 部署情報(事業所マスタ)数据同步
  {
    id: 'department-information',
    name: '部署情報',
    keyword: '部署情報',
    mode: 'insert',
    tableName: '事業所マスタ',

    // Key 字段映射:空数组(insert 模式不需要 Key)
    keyMappings: [
      { fieldName: '部署番号', csvColumn: '部署番号' },
    ],

    // 更新字段映射:空数组(insert 模式不更新已有记录)
    updateMappings: [
      { fieldName: '事務所名', csvColumn: '部署' },
      { fieldName: '部署番号', csvColumn: '部署番号' },
      { fieldName: '所属部署番号', csvColumn: '所属部署番号' },
    ],

    // 新增字段映射:新增时写入部署基础信息
    insertMappings: [
      { fieldName: '事務所名', csvColumn: '部署' },
      { fieldName: '部署番号', csvColumn: '部署番号' },
      { fieldName: '所属部署番号', csvColumn: '所属部署番号' },
    ],
  },

  // 预设38: 社員情報(従業員マスタ)数据同步
  {
    id: 'employee-information',
    name: '社員情報',
    keyword: '社員情報',
    mode: 'insert',
    tableName: '従業員マスタ',

    // Key 字段映射:空数组(insert 模式不需要 Key)
    keyMappings: [],

    // 更新字段映射:空数组(insert 模式不更新已有记录)
    updateMappings: [],

    // 新增字段映射:新增时写入社員基础信息
    insertMappings: [
      { fieldName: '社員番号', csvColumn: '社員番号' },
      // 社員氏名是成员字段,按文档要求通过 email 换取 user_id 后以 [{ id }] 数组写入
      { fieldName: '社員氏名', csvColumn: 'email', userLookupCsvColumn: 'email' },
      { fieldName: '社員氏名(かな)', csvColumn: '社員氏名（かな）' },
      { fieldName: '役職名', csvColumn: '役職名' },
      { fieldName: '部署名', csvColumn: '部署名' },
      { fieldName: '郵便番号', csvColumn: '郵便番号' },
      { fieldName: '住所', csvColumn: '住所' },
      { fieldName: '電話番号', csvColumn: '電話番号' },
      { fieldName: '携帯番号', csvColumn: '携帯番号' },
      { fieldName: '電話番号３', csvColumn: '電話番号3' },
      { fieldName: 'email', csvColumn: 'email' },
      { fieldName: '承認者1', csvColumn: '承認先①' },
      { fieldName: '承認者2', csvColumn: '承認先②' },
    ],
  },

  // 预设8-1: 予算数据同步
  {
    id: 'budget-data',
    name: '予算',
    keyword: '予算',
    mode: 'upsert',
    tableName: '月別予算',

    // Key: ID(文本字段) <- CSV ID
    keyMappings: [
      { fieldName: 'ID', csvColumn: 'ID' },
    ],

    // 更新字段映射:更新时写入预算相关字段
    updateMappings: [
      { fieldName: '予算日付', csvColumn: '予算日付' },
      { fieldName: '事業所コード', csvColumn: '事業所コード' },
      { fieldName: '担当部署', csvColumn: '担当部署' },
      { fieldName: '従業員コード', csvColumn: '従業員コード' },
      { fieldName: '担当者名', csvColumn: '担当者名' },
      { fieldName: '器具売上高_予算', csvColumn: '器具売上高' },
      { fieldName: '器具利益_予算', csvColumn: '器具利益' },
      { fieldName: '新設件数', csvColumn: '新設件数' },
      { fieldName: '燃転_予算（台）', csvColumn: '燃転_予算' },
      { fieldName: '買替_予算（台）', csvColumn: '買替_予算' },
      { fieldName: '風呂切替_予算（台）', csvColumn: '風呂切替_予算' },
      { fieldName: '新設_予算（台）', csvColumn: '新設_予算' },
      { fieldName: 'その他_予算（台）', csvColumn: 'その他_予算' },
      { fieldName: 'ハイブリッド_予算（台）', csvColumn: 'ハイブリッド_予算' },
      { fieldName: '高・2缶3水_予算（台）', csvColumn: '高効率2缶3水_予算' },
      { fieldName: '高効率_予算（台）', csvColumn: '高効率_予算' },
      { fieldName: 'エアバブル_予算（台）', csvColumn: '(内)エアバブル_予算' },
      { fieldName: '浴暖_予算（台）', csvColumn: '浴室暖房_予算' },
      { fieldName: 'レンジフード_予算（台）', csvColumn: 'レンジフード_予算' },
      { fieldName: 'ビルトイン_予算（台）', csvColumn: 'GTビルトインコンロ_予算' },
      { fieldName: '卓上_予算（台）', csvColumn: 'GT卓上_予算' },
      { fieldName: '暖房機_予算（台）', csvColumn: '暖房機_予算' },
      { fieldName: 'GHP_予算（台）', csvColumn: 'GHP_予算' },
      { fieldName: '蓄電池_予算（台）', csvColumn: '蓄電池_予算' },
      { fieldName: '衣類乾燥機_予算（台）', csvColumn: '衣類乾燥機_予算' },
      { fieldName: '床暖_予算（台）', csvColumn: '床暖房_予算' },
      { fieldName: '太陽光_予算（台）', csvColumn: '太陽光発電_予算' },
      { fieldName: 'エネファーム_予算（台）', csvColumn: 'エネファーム_予算' },
      { fieldName: 'リフォーム_予算（台）', csvColumn: 'リフォーム情報_予算' },
      { fieldName: 'PPA_予算', csvColumn: 'PPA_予算' },
      { fieldName: 'リターナブル_予算', csvColumn: 'リターナブル_予算' },
      { fieldName: 'ワンウェイ_予算', csvColumn: 'ワンウェイ_予算' },
      { fieldName: '電力_予算', csvColumn: '電力_予算' },
      { fieldName: 'サポテン_予算', csvColumn: 'サポテン_予算' },
      { fieldName: 'マイページ_予算', csvColumn: 'マイページ_予算' },
      { fieldName: 'ハウスクリーニング_予算（台）', csvColumn: 'ハウスクリーニング_予算' },
      { fieldName: '新都市ガス_予算（台）', csvColumn: '新都市ガス_予算' },
    ],

    // 新增字段映射:ID 会在 upsert 插入分支中由 keyMappings 自动补齐
    insertMappings: [
      { fieldName: '予算日付', csvColumn: '予算日付' },
      { fieldName: '事業所コード', csvColumn: '事業所コード' },
      { fieldName: '担当部署', csvColumn: '担当部署' },
      { fieldName: '従業員コード', csvColumn: '従業員コード' },
      { fieldName: '担当者名', csvColumn: '担当者名' },
      { fieldName: '器具売上高_予算', csvColumn: '器具売上高' },
      { fieldName: '器具利益_予算', csvColumn: '器具利益' },
      { fieldName: '新設件数', csvColumn: '新設件数' },
      { fieldName: '燃転_予算（台）', csvColumn: '燃転_予算' },
      { fieldName: '買替_予算（台）', csvColumn: '買替_予算' },
      { fieldName: '風呂切替_予算（台）', csvColumn: '風呂切替_予算' },
      { fieldName: '新設_予算（台）', csvColumn: '新設_予算' },
      { fieldName: 'その他_予算（台）', csvColumn: 'その他_予算' },
      { fieldName: 'ハイブリッド_予算（台）', csvColumn: 'ハイブリッド_予算' },
      { fieldName: '高・2缶3水_予算（台）', csvColumn: '高効率2缶3水_予算' },
      { fieldName: '高効率_予算（台）', csvColumn: '高効率_予算' },
      { fieldName: 'エアバブル_予算（台）', csvColumn: '(内)エアバブル_予算' },
      { fieldName: '浴暖_予算（台）', csvColumn: '浴室暖房_予算' },
      { fieldName: 'レンジフード_予算（台）', csvColumn: 'レンジフード_予算' },
      { fieldName: 'ビルトイン_予算（台）', csvColumn: 'GTビルトインコンロ_予算' },
      { fieldName: '卓上_予算（台）', csvColumn: 'GT卓上_予算' },
      { fieldName: '暖房機_予算（台）', csvColumn: '暖房機_予算' },
      { fieldName: 'GHP_予算（台）', csvColumn: 'GHP_予算' },
      { fieldName: '蓄電池_予算（台）', csvColumn: '蓄電池_予算' },
      { fieldName: '衣類乾燥機_予算（台）', csvColumn: '衣類乾燥機_予算' },
      { fieldName: '床暖_予算（台）', csvColumn: '床暖房_予算' },
      { fieldName: '太陽光_予算（台）', csvColumn: '太陽光発電_予算' },
      { fieldName: 'エネファーム_予算（台）', csvColumn: 'エネファーム_予算' },
      { fieldName: 'リフォーム_予算（台）', csvColumn: 'リフォーム情報_予算' },
      { fieldName: 'PPA_予算', csvColumn: 'PPA_予算' },
      { fieldName: 'リターナブル_予算', csvColumn: 'リターナブル_予算' },
      { fieldName: 'ワンウェイ_予算', csvColumn: 'ワンウェイ_予算' },
      { fieldName: '電力_予算', csvColumn: '電力_予算' },
      { fieldName: 'サポテン_予算', csvColumn: 'サポテン_予算' },
      { fieldName: 'マイページ_予算', csvColumn: 'マイページ_予算' },
      { fieldName: 'ハウスクリーニング_予算（台）', csvColumn: 'ハウスクリーニング_予算' },
      { fieldName: '新都市ガス_予算（台）', csvColumn: '新都市ガス_予算' },
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
