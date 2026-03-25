/**
 * Lark CSV 同步工具 - 前端应用模块
 *
 * 本文件实现了 Web 前端界面的完整交互逻辑，包括：
 * 1. OAuth 用户登录（通过弹窗完成 Lark 授权）
 * 2. CSV 文件上传和预览
 * 3. 字段映射配置（Key 映射、更新映射、插入映射）
 * 4. 同步任务的启动、轮询和结果展示
 * 5. 预设规则自动应用（根据文件名匹配预设）
 * 6. 配置的保存和加载
 *
 * 使用立即执行函数（IIFE）封装，避免全局变量污染
 */
(function () {
  /** 映射行 ID 的自增种子，用于为每一行映射生成唯一 ID */
  let mappingIdSeed = 0;

  /**
   * 同步模式元数据定义
   * 每种模式包含：显示标签、说明提示、是否需要 Key 映射
   *
   * 支持的模式：
   * - update: 仅更新已有记录
   * - upsert: 更新+新增(默认)
   * - insert: 仅新增记录
   * - empty: 清空匹配记录的指定字段
   */
  const MODE_META = {
    update: {
      label: "更新のみ",
      tip: "キーに一致した既存レコードのみ更新します。見つからない行は追加しません。",
      needsKey: true,
    },
    upsert: {
      label: "更新 + 追加",
      tip: "キーに一致したら更新、見つからなければ新規追加します。",
      needsKey: true,
    },
    insert: {
      label: "追加のみ",
      tip: "キーマッピングは不要です。CSVから直接新規追加します。",
      needsKey: false,
    },
    empty: {
      label: "空にする",
      tip: "キー一致時のみ更新し、指定列を空値(null)で上書きします。",
      needsKey: true,
    },
  };

  /**
   * 应用程序全局状态对象
   * 集中管理所有 UI 状态、用户数据和同步配置
   */
  const state = {
    busy: false,                // 是否正在执行操作（如上传、加载）
    running: false,             // 同步任务是否正在运行
    authSessionId: "",          // OAuth 认证会话 ID
    authUserName: "",           // 已登录用户的显示名称
    uploadId: "",               // 上传的 CSV 文件 ID
    jobId: "",                  // 当前同步任务 ID
    pollTimer: null,            // 任务状态轮询定时器
    lastLogIndex: 0,            // 已渲染的最后一条日志索引
    tables: [],                 // Base 中的数据表列表
    selectedTableId: "",        // 当前选中的数据表 ID
    fieldNames: [],             // 当前表的字段名列表
    fieldTypes: {},             // 字段名 -> 类型标签 的映射
    csvHeaders: [],             // CSV 文件的表头列名列表
    autoMappings: [],           // 自动生成的同名映射列表
    preset: null,               // 检测到的预设配置对象（null 表示无预设）
    mappingLocked: false,       // 映射是否锁定（预设模式下为 true）
    hasSavedConfig: false,      // 是否已保存过配置
    configModalOpen: false,     // 配置弹窗是否打开
    defaults: {                 // 默认同步参数
      encoding: "utf8",         // CSV 文件编码
      batchSize: 500,           // 批处理大小
      clearEmpty: false,        // 是否清空空值字段
      resumeRow: 0,             // 断点续传起始行号
    },
    keyMappings: [createMappingRow()],      // Key 字段映射列表
    updateMappings: [createMappingRow()],    // 更新字段映射列表
    insertMappings: [createMappingRow()],    // 插入字段映射列表
  };

  /**
   * DOM 元素引用缓存
   * 在初始化时一次性获取所有需要操作的 DOM 元素，避免重复查询
   */
  const el = {
    // 配置弹窗相关
    appId: document.getElementById("appId"),                           // App ID 输入框
    appSecret: document.getElementById("appSecret"),                   // App Secret 输入框
    apiBase: document.getElementById("apiBase"),                       // OpenAPI 基础地址输入框
    baseUrl: document.getElementById("baseUrl"),                       // Base URL 输入框
    editConfigBtn: document.getElementById("editConfigBtn"),           // 编辑配置按钮
    configModal: document.getElementById("configModal"),               // 配置弹窗容器
    configModalBackdrop: document.getElementById("configModalBackdrop"), // 弹窗背景遮罩
    configModalCloseBtn: document.getElementById("configModalCloseBtn"), // 弹窗关闭按钮
    configModalSaveBtn: document.getElementById("configModalSaveBtn"),   // 弹窗保存按钮
    // 登录相关
    loginBtn: document.getElementById("loginBtn"),                     // 登录按钮
    logoutBtn: document.getElementById("logoutBtn"),                   // 登出按钮
    loginStatus: document.getElementById("loginStatus"),               // 登录状态显示
    // CSV 文件上传相关
    csvFile: document.getElementById("csvFile"),                       // CSV 文件选择输入框
    csvInfo: document.getElementById("csvInfo"),                       // CSV 文件信息显示
    startBtn: document.getElementById("startBtn"),                     // 同步开始按钮
    // 基本设置相关
    tableId: document.getElementById("tableId"),                       // 目标表选择下拉框
    mode: document.getElementById("mode"),                             // 同步模式选择下拉框
    modeTip: document.getElementById("modeTip"),                       // 模式说明提示文本
    // 映射卡片容器
    keyMappingCard: document.getElementById("keyMappingCard"),         // Key 映射卡片区域
    updateMappingCard: document.getElementById("updateMappingCard"),   // 更新映射卡片区域
    insertMappingCard: document.getElementById("insertMappingCard"),   // 插入映射卡片区域
    // 映射列表容器
    keyMappingsList: document.getElementById("keyMappingsList"),       // Key 映射列表
    updateMappingsList: document.getElementById("updateMappingsList"), // 更新映射列表
    insertMappingsList: document.getElementById("insertMappingsList"), // 插入映射列表
    // 映射操作按钮
    addKeyMappingBtn: document.getElementById("addKeyMappingBtn"),     // 添加 Key 映射按钮
    addUpdateMappingBtn: document.getElementById("addUpdateMappingBtn"), // 添加更新映射按钮
    addInsertMappingBtn: document.getElementById("addInsertMappingBtn"), // 添加插入映射按钮
    autoMapBtn: document.getElementById("autoMapBtn"),                 // 自动映射按钮
    reloadSchemaBtn: document.getElementById("reloadSchemaBtn"),       // 重新加载 Schema 按钮
    // 提示和错误信息
    errorAlert: document.getElementById("errorAlert"),                 // 错误提示区域
    infoAlert: document.getElementById("infoAlert"),                   // 信息提示区域
    // 执行状态相关
    statusBadge: document.getElementById("statusBadge"),               // 状态徽章（待机/执行中/完成/失败）
    statusText: document.getElementById("statusText"),                 // 状态文本
    // 统计数字显示
    stProcessed: document.getElementById("stProcessed"),               // 处理行数
    stInserted: document.getElementById("stInserted"),                 // 插入行数
    stUpdated: document.getElementById("stUpdated"),                   // 更新行数
    stFailed: document.getElementById("stFailed"),                     // 失败行数
    stSkipped: document.getElementById("stSkipped"),                   // 跳过行数
    stIndexed: document.getElementById("stIndexed"),                   // 索引行数
    errorCsvLink: document.getElementById("errorCsvLink"),             // 错误 CSV 下载链接
    // 进度条相关
    progressTrack: document.getElementById("progressTrack"),           // 进度条轨道
    progressBar: document.getElementById("progressBar"),               // 进度条填充
    progressPhase: document.getElementById("progressPhase"),           // 进度阶段文本
    progressPercent: document.getElementById("progressPercent"),       // 进度百分比
    progressDetail: document.getElementById("progressDetail"),         // 进度详细信息
    // 实时日志窗口
    logWindow: document.getElementById("logWindow"),                   // 实时输出的日志窗口
  };

  /**
   * 创建映射行对象
   * 每行包含唯一 ID、Base 字段名和 CSV 列名
   *
   * @param {Object} partial - 可选的初始值
   * @returns {Object} 映射行对象 { id, fieldName, csvColumn }
   */
  function createMappingRow(partial) {
    mappingIdSeed += 1;
    return {
      id: "map_" + mappingIdSeed,
      fieldName: partial && partial.fieldName ? partial.fieldName : "",
      csvColumn: partial && partial.csvColumn ? partial.csvColumn : "",
    };
  }

  /**
   * 获取当前选中模式的元数据
   * @returns {Object} 模式元数据 { label, tip, needsKey }
   */
  function modeInfo() {
    return MODE_META[el.mode.value] || MODE_META.upsert;
  }

  /**
   * 设置预设状态
   * 当检测到预设配置时，锁定映射（用户不可编辑）
   *
   * @param {Object|null} preset - 预设配置对象，null 表示清除预设
   */
  function setPresetState(preset) {
    if (preset && typeof preset === "object") {
      state.preset = preset;
      state.mappingLocked = true;
      return;
    }
    state.preset = null;
    state.mappingLocked = false;
  }

  /**
   * 将错误对象转换为字符串消息
   * @param {Error|any} error - 错误对象
   * @returns {string} 错误消息
   */
  function toErrorMessage(error) {
    if (error instanceof Error) return error.message;
    return String(error);
  }

  /**
   * HTML 转义函数
   * 转义特殊字符防止 XSS 攻击
   *
   * @param {any} input - 要转义的输入
   * @returns {string} 转义后的安全字符串
   */
  function escapeHtml(input) {
    return String(input)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  /**
   * 带时间戳的控制台日志输出，并同步输出到页面的实时日志窗口
   * @param {string} message - 日志消息
   * @param {boolean} isError - 是否为错误类型的日志
   */
  function log(message, isError = false) {
    const now = new Date().toLocaleTimeString("ja-JP", { hour12: false });
    const logText = "[" + now + "] " + message;
    console.log("[lark-sync]" + logText);
    
    if (el.logWindow) {
      const entry = document.createElement("div");
      entry.className = "log-entry" + (isError ? " error" : "");
      entry.textContent = logText;
      el.logWindow.appendChild(entry);
      el.logWindow.scrollTop = el.logWindow.scrollHeight;
    }
  }

  /**
   * 安全地将值转换为非负整数
   * @param {any} value - 输入值
   * @returns {number} 非负整数，无效值返回 0
   */
  function toSafeInteger(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return Math.max(0, Math.floor(num));
  }

  /**
   * 将同步阶段标识转换为日文显示标签
   * @param {string} phase - 同步阶段标识
   * @returns {string} 日文阶段标签
   */
  function phaseLabel(phase) {
    const key = String(phase || "").trim().toLowerCase();
    if (key === "queued") return "待機中";
    if (key === "initializing") return "初期化中";
    if (key === "resolving-links") return "関連フィールド解析中";
    if (key === "indexing") return "既存レコード索引中";
    if (key === "running") return "同期実行中";
    if (key === "finalizing") return "最終処理中";
    if (key === "completed") return "完了";
    if (key === "failed") return "失敗";
    return "待機中";
  }

  /**
   * 限制百分比值在 0-100 范围内
   * @param {any} value - 输入值
   * @returns {number} 限制后的百分比值
   */
  function clampPercent(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    if (num < 0) return 0;
    if (num > 100) return 100;
    return num;
  }

  /**
   * 更新进度条视图
   * 支持确定进度（百分比）和不确定进度（动画）两种模式
   *
   * @param {Object} input - 进度数据
   * @param {string} input.phaseText - 阶段显示文本
   * @param {string} input.detail - 详细进度描述
   * @param {boolean} input.indeterminate - 是否使用不确定进度动画
   * @param {number} input.percent - 进度百分比（0-100）
   */
  function setProgressView(input) {
    const phaseText = input && input.phaseText ? input.phaseText : "待機中";
    const detailText =
      input && input.detail ? input.detail : "まだ同期は開始されていません。";
    const indeterminate = Boolean(input && input.indeterminate);
    const percent = clampPercent(input && input.percent !== undefined ? input.percent : 0);
    const rounded = Math.round(percent);
    el.progressPhase.textContent = phaseText;
    el.progressDetail.textContent = detailText;
    el.progressPercent.textContent = indeterminate ? "--" : String(rounded) + "%";
    el.progressTrack.setAttribute("aria-valuenow", String(rounded));
    if (indeterminate) {
      el.progressBar.classList.add("indeterminate");
      el.progressBar.style.width = "36%";
      return;
    }
    el.progressBar.classList.remove("indeterminate");
    el.progressBar.style.width = String(rounded) + "%";
  }

  /**
   * 获取各同步阶段对应的基础进度百分比
   * 用于在没有精确进度时提供大致的进度估算
   *
   * @param {string} phase - 同步阶段标识
   * @returns {number} 基础百分比
   */
  function phaseBasePercent(phase) {
    const key = String(phase || "").trim().toLowerCase();
    if (key === "queued") return 1;
    if (key === "initializing") return 5;
    if (key === "resolving-links") return 12;
    if (key === "indexing") return 24;
    if (key === "running") return 35;
    if (key === "finalizing") return 96;
    if (key === "completed") return 100;
    return 0;
  }

  /**
   * 根据任务数据构建进度视图参数
   * 综合任务状态、阶段和统计信息，计算出进度条显示所需的数据
   *
   * @param {Object} jobData - 任务数据（来自 API 响应）
   * @returns {Object} 进度视图参数 { phaseText, percent, detail, indeterminate }
   */
  function buildProgressFromJob(jobData) {
    const data = jobData || {};
    const stats = data.stats || {};
    const status = String(data.status || "").toLowerCase();
    const phase = String(data.phase || "").toLowerCase();
    const processedRows = toSafeInteger(stats.processedRows || stats.totalRows);
    const estimatedTotalRows = toSafeInteger(stats.estimatedTotalRows);
    const indexedRows = toSafeInteger(stats.indexedRows);
    if (status === "completed" || phase === "completed") {
      return {
        phaseText: "完了",
        percent: 100,
        detail:
          estimatedTotalRows > 0
            ? "処理済み: " + processedRows + " / " + estimatedTotalRows + " 行"
            : "処理済み: " + processedRows + " 行",
        indeterminate: false,
      };
    }
    if (status === "failed" || phase === "failed") {
      return {
        phaseText: "失敗",
        percent: clampPercent(phaseBasePercent(phase)),
        detail: data.error || data.message || "同期に失敗しました。",
        indeterminate: false,
      };
    }
    const phaseTotalRows = toSafeInteger(stats.phaseTotalRows);
    const phaseScannedRows = toSafeInteger(stats.phaseScannedRows);

    if (phase === "running") {
      if (estimatedTotalRows > 0) {
        const runningRatio = processedRows / estimatedTotalRows;
        return {
          phaseText: phaseLabel(phase),
          percent: clampPercent(80 + runningRatio * 15),
          detail:
            "処理中: " +
            processedRows +
            " / " +
            estimatedTotalRows +
            " 行 (追加 " +
            toSafeInteger(stats.insertedRows) +
            ", 更新 " +
            toSafeInteger(stats.updatedRows) +
            ", 失敗 " +
            toSafeInteger(stats.failedRows) +
            ")",
          indeterminate: false,
        };
      }
      return {
        phaseText: phaseLabel(phase),
        percent: phaseBasePercent(phase),
        detail:
          "処理中: " +
          processedRows +
          " 行 (追加 " +
          toSafeInteger(stats.insertedRows) +
          ", 更新 " +
          toSafeInteger(stats.updatedRows) +
          ", 失敗 " +
          toSafeInteger(stats.failedRows) +
          ")",
        indeterminate: true,
      };
    }
    if (phase === "resolving-links") {
      let percent = 10;
      if (phaseTotalRows > 0) {
        percent = 10 + (phaseScannedRows / phaseTotalRows) * 35; // 10% -> 45%
      }
      return {
        phaseText: phaseLabel(phase),
        percent: clampPercent(percent),
        detail: data.message || "関連フィールド解析中...",
        indeterminate: phaseTotalRows === 0 && phaseScannedRows === 0,
      };
    }
    if (phase === "indexing") {
      let percent = 45;
      if (phaseTotalRows > 0) {
        percent = 45 + (phaseScannedRows / phaseTotalRows) * 35; // 45% -> 80%
      } else if (indexedRows > 0) {
        // Fallback for cases where total is unknown
        percent = 45 + Math.min(30, (indexedRows / 10000) * 35);
      }
      return {
        phaseText: phaseLabel(phase),
        percent: clampPercent(percent),
        detail:
          data.message ||
          (indexedRows > 0
            ? "索引済みレコード: " + indexedRows
            : "既存レコードを索引中..."),
        indeterminate: phaseTotalRows === 0 && indexedRows === 0,
      };
    }
    return {
      phaseText: phaseLabel(phase || status),
      percent: phaseBasePercent(phase || status),
      detail: data.message || "準備中...",
      indeterminate: status === "queued",
    };
  }

  /**
   * 显示或隐藏错误提示
   * @param {string} text - 错误消息，空字符串表示隐藏
   */
  function showError(text) {
    if (!text) {
      el.errorAlert.classList.add("hidden");
      el.errorAlert.textContent = "";
      return;
    }
    el.errorAlert.textContent = text;
    el.errorAlert.classList.remove("hidden");
  }

  /**
   * 显示或隐藏信息提示
   * @param {string} text - 信息消息，空字符串表示隐藏
   */
  function showInfo(text) {
    if (!text) {
      el.infoAlert.classList.add("hidden");
      el.infoAlert.textContent = "";
      return;
    }
    el.infoAlert.textContent = text;
    el.infoAlert.classList.remove("hidden");
  }

  /** 重置统计数字和进度条为初始状态 */
  function resetStats() {
    el.stProcessed.textContent = "0";
    el.stInserted.textContent = "0";
    el.stUpdated.textContent = "0";
    el.stFailed.textContent = "0";
    el.stSkipped.textContent = "0";
    el.stIndexed.textContent = "0";
    setProgressView({
      phaseText: "待機中",
      percent: 0,
      detail: "まだ同期は開始されていません。",
      indeterminate: false,
    });
  }

  /**
   * 画面全体を初期状態にリセット
   * ログアウト時などに使用
   */
  function resetAllState() {
    // 轮询停止
    stopPolling();
    // 認証情報クリア
    state.authSessionId = "";
    state.authUserName = "";
    // アップロード・ジョブ情報クリア
    state.uploadId = "";
    state.jobId = "";
    state.lastLogIndex = 0;
    // テーブル・フィールド・CSV情報クリア
    state.tables = [];
    state.selectedTableId = "";
    state.fieldNames = [];
    state.fieldTypes = {};
    state.csvHeaders = [];
    state.autoMappings = [];
    state.preset = null;
    state.mappingLocked = false;
    // マッピングリセット
    state.keyMappings = [createMappingRow()];
    state.updateMappings = [createMappingRow()];
    state.insertMappings = [createMappingRow()];
    // UI リセット
    el.csvFile.value = "";
    el.csvInfo.textContent = "未選択";
    el.errorCsvLink.classList.add("hidden");
    if (el.logWindow) el.logWindow.innerHTML = "";
    showError("");
    showInfo("");
    resetStats();
    updateLoginStatus();
    renderTableOptions();
    renderMappings();
    refreshModeView();
    setStatus("idle", "Larkにログインし、CSVファイルを選択してください。");
    refreshControls();
  }

  /**
   * 更新统计数字显示
   * @param {Object} stats - 统计数据对象
   */
  function updateStats(stats) {
    if (!stats) return;
    el.stProcessed.textContent = String(stats.processedRows || stats.totalRows || 0);
    el.stInserted.textContent = String(stats.insertedRows || 0);
    el.stUpdated.textContent = String(stats.updatedRows || 0);
    el.stFailed.textContent = String(stats.failedRows || 0);
    el.stSkipped.textContent = String(stats.skippedRows || 0);
    el.stIndexed.textContent = String(stats.indexedRows || 0);
  }

  /**
   * 设置执行状态徽章和文本
   * @param {string} type - 状态类型（'idle'|'running'|'success'|'failed'）
   * @param {string} text - 状态描述文本
   */
  function setStatus(type, text) {
    el.statusBadge.className = "badge";
    if (type === "running") {
      el.statusBadge.classList.add("badge-running");
      el.statusBadge.textContent = "実行中";
    } else if (type === "success") {
      el.statusBadge.classList.add("badge-success");
      el.statusBadge.textContent = "完了";
    } else if (type === "failed") {
      el.statusBadge.classList.add("badge-failed");
      el.statusBadge.textContent = "失敗";
    } else {
      el.statusBadge.classList.add("badge-idle");
      el.statusBadge.textContent = "待機中";
    }
    el.statusText.textContent = text || "";
  }

  /** 更新登录状态显示（已登录/未登录）、切换ログイン/ログアウトボタン表示 */
  function updateLoginStatus() {
    if (state.authSessionId) {
      el.loginStatus.textContent = "ログイン済み: " + (state.authUserName || "Lark User");
      el.loginBtn.classList.add("hidden");
      el.logoutBtn.classList.remove("hidden");
      return;
    }
    el.loginStatus.textContent = "未ログイン";
    el.loginBtn.classList.remove("hidden");
    el.logoutBtn.classList.add("hidden");
  }

  /** 更新配置按钮的标签（根据是否已保存配置） */
  function updateConfigButtonLabel() {
    el.editConfigBtn.textContent = state.hasSavedConfig ? "設定(保存済)" : "設定";
  }

  /** 获取配置弹窗中所有输入框元素的数组 */
  function getConfigInputs() {
    return [el.appId, el.appSecret, el.apiBase, el.baseUrl];
  }

  /** 打开配置弹窗 */
  function openConfigModal() {
    state.configModalOpen = true;
    el.configModal.classList.remove("hidden");
    el.configModal.setAttribute("aria-hidden", "false");
  }

  /** 关闭配置弹窗 */
  function closeConfigModal() {
    state.configModalOpen = false;
    el.configModal.classList.add("hidden");
    el.configModal.setAttribute("aria-hidden", "true");
  }

  /**
   * 收集配置弹窗中的表单数据
   * @returns {Object} 配置数据 { appId, appSecret, apiBase, baseUrl }
   */
  function collectSettingsPayload() {
    return {
      appId: el.appId.value.trim(),
      appSecret: el.appSecret.value.trim(),
      apiBase: el.apiBase.value.trim(),
      baseUrl: el.baseUrl.value.trim(),
    };
  }

  /**
   * 保存配置到服务器
   * 调用 /api/settings 接口保存配置到磁盘
   */
  async function saveSettings() {
    const payload = collectSettingsPayload();
    state.busy = true;
    refreshControls();
    showError("");
    showInfo("");

    try {
      const data = await api("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      el.appId.value = data.appId || payload.appId;
      el.appSecret.value = data.appSecret || payload.appSecret;
      el.apiBase.value = data.apiBase || payload.apiBase;
      el.baseUrl.value = data.baseUrl || payload.baseUrl;
      state.hasSavedConfig = Boolean(data.hasSavedConfig);
      updateConfigButtonLabel();
      closeConfigModal();
      showInfo("設定をローカルに保存しました。");
      log("設定を保存しました。");
    } finally {
      state.busy = false;
      refreshControls();
    }
  }

  /**
   * 刷新同步模式相关的视图
   * 根据当前模式显示/隐藏对应的映射卡片区域
   */
  function refreshModeView() {
    const info = modeInfo();
    el.modeTip.textContent = "現在のモード: " + info.label + "。" + info.tip;
    if (state.mappingLocked) {
      el.modeTip.textContent += " [プリセット適用中: 読み取り専用]";
    }
    if (info.needsKey) el.keyMappingCard.classList.remove("hidden");
    else el.keyMappingCard.classList.add("hidden");
    const mode = el.mode.value;
    const showUpdate = mode === "update" || mode === "upsert" || mode === "empty";
    const showInsert = mode === "insert" || mode === "upsert";
    if (showUpdate) el.updateMappingCard.classList.remove("hidden");
    else el.updateMappingCard.classList.add("hidden");
    if (showInsert) el.insertMappingCard.classList.remove("hidden");
    else el.insertMappingCard.classList.add("hidden");
  }

  /**
   * 刷新所有控件的启用/禁用状态
   * 根据当前应用状态（忙碌、运行中、预设锁定等）控制各按钮和输入框
   */
  function refreshControls() {
    const canStart = Boolean(
      !state.busy &&
        !state.running &&
        state.authSessionId &&
        state.uploadId &&
        state.selectedTableId
    );
    const lockByPreset = state.mappingLocked;

    getConfigInputs().forEach(function (input) {
      input.disabled = state.busy || state.running;
    });
    el.editConfigBtn.disabled = state.busy || state.running;
    el.configModalCloseBtn.disabled = state.busy || state.running;
    el.configModalSaveBtn.disabled = state.busy || state.running;

    el.loginBtn.disabled = state.busy || state.running;
    el.logoutBtn.disabled = state.busy || state.running;
    el.csvFile.disabled = state.busy || state.running || !state.authSessionId;
    el.tableId.disabled = state.busy || state.running || state.tables.length === 0 || lockByPreset;
    el.mode.disabled = state.busy || state.running || lockByPreset;
    el.addKeyMappingBtn.disabled = state.busy || state.running || lockByPreset;
    el.addUpdateMappingBtn.disabled = state.busy || state.running || lockByPreset;
    el.addInsertMappingBtn.disabled = state.busy || state.running || lockByPreset;
    el.autoMapBtn.disabled =
      state.busy || state.running || state.autoMappings.length === 0 || lockByPreset;
    el.reloadSchemaBtn.disabled = state.busy || state.running;
    el.startBtn.disabled = !canStart;
  }

  /**
   * 标准化映射行数据
   * 验证字段名和列名是否存在于当前 Schema 中
   *
   * @param {Array} rows - 原始映射行数组
   * @returns {Array} 标准化后的映射行数组
   */
  function normalizeRows(rows) {
    const validFields = new Set(state.fieldNames);
    const validColumns = new Set(state.csvHeaders);
    return (Array.isArray(rows) ? rows : []).map(function (row) {
      return {
        id: row && row.id ? row.id : createMappingRow().id,
        fieldName: validFields.has(row && row.fieldName) ? row.fieldName : "",
        csvColumn: validColumns.has(row && row.csvColumn) ? row.csvColumn : "",
      };
    });
  }

  /** 确保每组映射至少有一行（如果为空则添加一行空行） */
  function ensureRows() {
    if (state.keyMappings.length === 0) state.keyMappings = [createMappingRow()];
    if (state.updateMappings.length === 0) state.updateMappings = [createMappingRow()];
    if (state.insertMappings.length === 0) state.insertMappings = [createMappingRow()];
  }

  /** 渲染表格选择下拉框的选项列表 */
  function renderTableOptions() {
    const options = [];
    if (state.tables.length === 0) {
      options.push('<option value="">テーブル未選択</option>');
    } else {
      state.tables.forEach(function (table) {
        const selected = table.tableId === state.selectedTableId ? ' selected="selected"' : "";
        options.push(
          '<option value="' +
            escapeHtml(table.tableId) +
            '"' +
            selected +
            ">" +
            escapeHtml(table.name + " (" + table.tableId + ")") +
            "</option>"
        );
      });
    }
    el.tableId.innerHTML = options.join("");
  }

  /**
   * 构建通用的下拉框 HTML 选项
   *
   * @param {Array<string>} values - 选项值数组
   * @param {string} selectedValue - 当前选中的值
   * @param {string} placeholder - 占位符文本
   * @returns {string} 选项的 HTML 字符串
   */
  function buildSelectOptions(values, selectedValue, placeholder) {
    const options = ['<option value="">' + escapeHtml(placeholder) + "</option>"];
    values.forEach(function (value) {
      const selected = value === selectedValue ? ' selected="selected"' : "";
      options.push(
        '<option value="' +
          escapeHtml(value) +
          '"' +
          selected +
          ">" +
          escapeHtml(value) +
          "</option>"
      );
    });
    return options.join("");
  }

  /**
   * 构建 Base 字段选择下拉框的 HTML 选项
   * 每个选项显示字段名和类型标签
   *
   * @param {string} selectedValue - 当前选中的字段名
   * @returns {string} 选项的 HTML 字符串
   */
  function buildFieldSelectOptions(selectedValue) {
    const options = ['<option value="">Baseフィールドを選択</option>'];
    state.fieldNames.forEach(function (name) {
      const selected = name === selectedValue ? ' selected="selected"' : "";
      const typeLabel = state.fieldTypes[name] || "";
      const display = typeLabel ? name + " (" + typeLabel + ")" : name;
      options.push(
        '<option value="' +
          escapeHtml(name) +
          '"' +
          selected +
          ">" +
          escapeHtml(display) +
          "</option>"
      );
    });
    return options.join("");
  }

  /**
   * 渲染映射列表的 HTML
   * 每行包含: Base 字段选择、CSV 列选择、删除按钮
   *
   * @param {HTMLElement} container - 映射列表容器元素
   * @param {Array} rows - 映射行数据数组
   * @param {string} group - 映射分组标识（'key'|'update'|'insert'）
   */
  function renderMappingList(container, rows, group) {
    const disabledAttr = state.mappingLocked ? ' disabled="disabled"' : "";
    const html = rows
      .map(function (row) {
        const fieldSelect = buildFieldSelectOptions(row.fieldName);
        const csvSelect = buildSelectOptions(state.csvHeaders, row.csvColumn, "CSV列を選択");
        return (
          '<div class="mapping-row" data-map-id="' +
          escapeHtml(row.id) +
          '">' +
          '<div class="mapping-cell"><select data-role="field" data-group="' +
          escapeHtml(group) +
          '"' +
          disabledAttr +
          '">' +
          fieldSelect +
          "</select></div>" +
          '<div class="mapping-cell"><select data-role="csv" data-group="' +
          escapeHtml(group) +
          '"' +
          disabledAttr +
          '">' +
          csvSelect +
          "</select></div>" +
          '<button type="button" class="button danger" data-role="remove" data-group="' +
          escapeHtml(group) +
          '"' +
          disabledAttr +
          '">削除</button>' +
          "</div>"
        );
      })
      .join("");
    container.innerHTML = html;
  }

  /** 渲染所有映射列表（Key、更新、插入） */
  function renderMappings() {
    ensureRows();
    renderMappingList(el.keyMappingsList, state.keyMappings, "key");
    renderMappingList(el.updateMappingsList, state.updateMappings, "update");
    renderMappingList(el.insertMappingsList, state.insertMappings, "insert");
  }

  /**
   * 根据分组名获取对应的映射行数组
   * @param {string} group - 分组标识（'key'|'update'|'insert'）
   * @returns {Array} 映射行数组
   */
  function getRowsByGroup(group) {
    if (group === "key") return state.keyMappings;
    if (group === "insert") return state.insertMappings;
    return state.updateMappings;
  }

  /**
   * 根据分组名设置对应的映射行数组
   * @param {string} group - 分组标识
   * @param {Array} rows - 新的映射行数组
   */
  function setRowsByGroup(group, rows) {
    if (group === "key") {
      state.keyMappings = rows;
      return;
    }
    if (group === "insert") {
      state.insertMappings = rows;
      return;
    }
    state.updateMappings = rows;
  }

  /**
   * 更新指定映射行的字段值
   * 在预设锁定模式下不执行任何操作
   *
   * @param {string} group - 分组标识
   * @param {string} mapId - 映射行 ID
   * @param {Object} patch - 要更新的字段 { fieldName?, csvColumn? }
   */
  function upsertRowValue(group, mapId, patch) {
    if (state.mappingLocked) return;
    const target = getRowsByGroup(group);
    const next = target.map(function (row) {
      if (row.id !== mapId) return row;
      return {
        id: row.id,
        fieldName: patch.fieldName !== undefined ? patch.fieldName : row.fieldName,
        csvColumn: patch.csvColumn !== undefined ? patch.csvColumn : row.csvColumn,
      };
    });
    setRowsByGroup(group, next);
  }

  /**
   * 删除指定映射行
   * 删除后如果列表为空，自动添加一行空行
   *
   * @param {string} group - 分组标识
   * @param {string} mapId - 映射行 ID
   */
  function removeRow(group, mapId) {
    if (state.mappingLocked) return;
    const target = getRowsByGroup(group);
    const next = target.filter(function (row) {
      return row.id !== mapId;
    });
    if (next.length === 0) next.push(createMappingRow());
    setRowsByGroup(group, next);
    renderMappings();
  }

  /**
   * 在指定分组添加一行新的空映射
   * @param {string} group - 分组标识
   */
  function addRow(group) {
    if (state.mappingLocked) return;
    const target = getRowsByGroup(group);
    target.push(createMappingRow());
    setRowsByGroup(group, target);
    renderMappings();
  }

  /**
   * 过滤出有效的映射行（字段名和列名都不为空）
   * @param {Array} rows - 映射行数组
   * @returns {Array} 有效的映射行
   */
  function validMappings(rows) {
    return rows.filter(function (row) {
      return row.fieldName && row.csvColumn;
    });
  }

  /**
   * 将映射行数组转换为文本格式（CSV列=Base字段，换行分隔）
   * 用于提交到 API
   *
   * @param {Array} rows - 映射行数组
   * @returns {string} 映射文本
   */
  function mappingRowsToText(rows) {
    return validMappings(rows)
      .map(function (row) {
        return row.csvColumn + "=" + row.fieldName;
      })
      .join("\n");
  }

  /**
   * 检查映射行中是否有重复的 Base 字段名
   *
   * @param {Array} rows - 映射行数组
   * @param {string} label - 映射类型标签（用于错误提示）
   * @throws {Error} 如果存在重复字段名
   */
  function ensureUniqueFields(rows, label) {
    const seen = new Set();
    rows.forEach(function (row) {
      if (seen.has(row.fieldName)) {
        throw new Error(label + "マッピングにBaseフィールドの重複があります。");
      }
      seen.add(row.fieldName);
    });
  }

  /**
   * 验证所有映射配置的完整性和正确性
   * 根据当前模式检查：
   * - 更新模式/清空模式：需要更新映射和 Key 映射
   * - 插入模式：需要插入映射
   * - 更新+插入模式：需要更新映射、插入映射和 Key 映射
   *
   * @throws {Error} 如果映射配置不完整或有重复
   */
  function validateMappings() {
    const info = modeInfo();
    const mode = el.mode.value;
    const updateRows = validMappings(state.updateMappings);
    const insertRows = validMappings(state.insertMappings);

    const requiresUpdate = mode === "update" || mode === "upsert" || mode === "empty";
    const requiresInsert = mode === "insert" || mode === "upsert";

    if (requiresUpdate && updateRows.length === 0) {
      throw new Error("更新マッピングを1つ以上設定してください。");
    }
    if (requiresInsert && insertRows.length === 0) {
      throw new Error("追加マッピングを1つ以上設定してください。");
    }

    if (requiresUpdate) ensureUniqueFields(updateRows, "更新");
    if (requiresInsert) ensureUniqueFields(insertRows, "追加");

    if (!info.needsKey) return;

    const keyRows = validMappings(state.keyMappings);
    if (keyRows.length === 0) {
      throw new Error("このモードではキーマッピングが必要です。");
    }
    ensureUniqueFields(keyRows, "Key");
  }

  /**
   * 通用 API 请求函数
   * 封装 fetch 调用，统一处理错误响应
   *
   * @param {string} path - API 路径
   * @param {Object} options - fetch 请求选项
   * @returns {Promise<Object>} API 响应中的 data 字段
   * @throws {Error} 如果 HTTP 状态码非 2xx 或响应 ok 为 false
   */
  async function api(path, options) {
    const response = await fetch(path, options);
    const payload = await response.json().catch(function () {
      return {};
    });
    if (!response.ok || payload.ok === false) {
      const message = payload.error || "HTTP " + response.status;
      const hint = payload.hint ? "\nヒント: " + payload.hint : "";
      throw new Error(message + hint);
    }
    return payload.data;
  }

  /**
   * 构建 Schema 加载请求的参数
   * @param {string} tableId - 表格 ID
   * @returns {Object} 请求参数对象
   */
  function payloadForSchema(tableId) {
    return {
      authSessionId: state.authSessionId,
      baseUrl: el.baseUrl.value.trim(),
      uploadId: state.uploadId,
      mode: el.mode.value,
      tableId: tableId || state.selectedTableId || "",
      encoding: state.defaults.encoding || "utf8",
    };
  }

  /**
   * 加载表格 Schema 信息
   * 调用 /api/bootstrap 获取表格列表、字段列表、CSV 表头等
   * 如果检测到预设配置，自动应用预设的映射
   *
   * @param {string} tableId - 要加载的表格 ID（可选）
   */
  async function loadSchema(tableId) {
    if (!state.authSessionId) throw new Error("先にLarkにログインしてください。");
    if (!state.uploadId) throw new Error("先にCSVファイルをアップロードしてください。");
    if (!el.baseUrl.value.trim()) throw new Error("Base URLを入力してください。");

    state.busy = true;
    refreshControls();
    showError("");
    showInfo("");

    try {
      const data = await api("/api/bootstrap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payloadForSchema(tableId)),
      });

      state.tables = Array.isArray(data.tables) ? data.tables : [];
      state.selectedTableId = data.selectedTableId || "";
      state.fieldNames = Array.isArray(data.fieldNames) ? data.fieldNames : [];
      state.fieldTypes =
        data.fieldTypes && typeof data.fieldTypes === "object" ? data.fieldTypes : {};
      state.csvHeaders = Array.isArray(data.csvHeaders) ? data.csvHeaders : [];
      state.autoMappings = Array.isArray(data.autoMappings) ? data.autoMappings : [];
      setPresetState(data.preset && typeof data.preset === "object" ? data.preset : null);

      if (data.mode && MODE_META[data.mode]) {
        el.mode.value = data.mode;
      }

      if (state.mappingLocked) {
        const presetKeyMappings = Array.isArray(state.preset.keyMappings)
          ? state.preset.keyMappings
          : [];
        const presetUpdateMappings = Array.isArray(state.preset.updateMappings)
          ? state.preset.updateMappings
          : [];
        const presetInsertMappings = Array.isArray(state.preset.insertMappings)
          ? state.preset.insertMappings
          : [];

        if (presetKeyMappings.length > 0) {
          state.keyMappings = presetKeyMappings.map(function (item) {
            return createMappingRow(item);
          });
        }
        if (presetUpdateMappings.length > 0) {
          state.updateMappings = presetUpdateMappings.map(function (item) {
            return createMappingRow(item);
          });
        }
        if (presetInsertMappings.length > 0) {
          state.insertMappings = presetInsertMappings.map(function (item) {
            return createMappingRow(item);
          });
        }

        // log(
        //   "プリセット適用: " +
        //     (state.preset.name || state.preset.id || "不明") +
        //     " / ファイル=" +
        //     (state.preset.fileName || "")
        // );
      }

      state.keyMappings = normalizeRows(state.keyMappings);
      state.updateMappings = normalizeRows(state.updateMappings);
      state.insertMappings = normalizeRows(state.insertMappings);

      renderTableOptions();
      renderMappings();
      refreshModeView();
      refreshControls();

      const tableLabel = data.selectedTableName || state.selectedTableId || "-";
      showInfo(
        "スキーマ読込完了: " +
          tableLabel +
          " / CSV列: " +
          state.csvHeaders.length +
          " / Base列: " +
          state.fieldNames.length +
          (state.preset && state.preset.name ? " / プリセット: " + state.preset.name : "") +
          (state.mappingLocked ? " / 読み取り専用" : "")
      );
      // log(
      //   "スキーマ読込完了: テーブル=" +
      //     tableLabel +
      //     ", CSV列数=" +
      //     state.csvHeaders.length +
      //     ", Baseフィールド数=" +
      //     state.fieldNames.length
      // );
    } finally {
      state.busy = false;
      refreshControls();
    }
  }

  /**
   * 尝试自动加载 Schema
   * 当用户已登录且已上传 CSV 文件且已填写 Base URL 时自动触发
   */
  async function tryAutoLoadSchema() {
    if (!state.authSessionId || !state.uploadId || !el.baseUrl.value.trim()) return;
    await loadSchema("");
  }

  /**
   * 上传 CSV 文件到服务器
   * 使用 FormData 发送文件，上传成功后自动尝试加载 Schema
   *
   * @param {File} file - 用户选择的 CSV 文件对象
   */
  async function uploadCsv(file) {
    if (!file) return;
    state.busy = true;
    refreshControls();
    showError("");
    showInfo("");

    try {
      const formData = new FormData();
      formData.append("csvFile", file);
      const data = await api("/api/upload", {
        method: "POST",
        body: formData,
      });

      state.uploadId = data.uploadId;
      const displayName = file.name || data.originalName || "uploaded.csv";
      const sizeBytes =
        Number.isFinite(Number(data.size)) && Number(data.size) > 0
          ? Number(data.size)
          : Number(file.size || 0);
      el.csvInfo.textContent = displayName + " (" + (sizeBytes / 1024 / 1024).toFixed(2) + " MB)";
      const rowCount = toSafeInteger(data.rowCount);
      log("CSV読込完了: " + displayName + "（行数: " + rowCount + "）");
      setStatus("idle", "CSV読込済み" + "（行数: " + rowCount + "）"); 
    } finally {
      state.busy = false;
      refreshControls();
    }

    await tryAutoLoadSchema();
  }

  /**
   * 启动 OAuth 登录流程
   * 1. 调用 /api/auth/start 获取授权 URL
   * 2. 打开弹窗窗口进行 Lark OAuth 授权
   * 3. 授权完成后通过 postMessage 接收结果
   */
  async function startLogin() {
    const payload = {
      appId: el.appId.value.trim(),
      appSecret: el.appSecret.value.trim(),
      apiBase: el.apiBase.value.trim(),
    };

    const data = await api("/api/auth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const popup = window.open(
      data.authUrl,
      "lark_oauth_login",
      "width=520,height=720,menubar=no,toolbar=no,status=no"
    );
    if (!popup) {
      throw new Error(
        "ログインウィンドウを開けませんでした。ポップアップを許可して再試行してください。"
      );
    }
  }

  /**
   * 收集同步启动请求的参数
   * 将当前 UI 状态转换为 API 需要的请求参数
   *
   * @returns {Object} 同步启动参数
   */
  function collectStartPayload() {
    const info = modeInfo();
    const updateText = mappingRowsToText(state.updateMappings);
    const insertText = mappingRowsToText(state.insertMappings);
    const keyText = info.needsKey ? mappingRowsToText(state.keyMappings) : "";

    return {
      authSessionId: state.authSessionId,
      baseUrl: el.baseUrl.value.trim(),
      uploadId: state.uploadId,
      mode: el.mode.value,
      tableId: state.selectedTableId,
      encoding: state.defaults.encoding,
      batchSize: state.defaults.batchSize,
      clearEmpty: state.defaults.clearEmpty,
      resumeRow: state.defaults.resumeRow,
      keyMappingText: keyText,
      updateMappingText: updateText,
      insertMappingText: insertText,
    };
  }

  /** 停止任务状态轮询 */
  function stopPolling() {
    if (!state.pollTimer) return;
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  /**
   * 轮询任务状态
   * 定期调用 /api/jobs/:id 获取任务进度，更新 UI 显示
   * 当任务完成或失败时自动停止轮询
   *
   * @param {string} jobId - 任务 ID
   */
  async function pollJob(jobId) {
    try {
      const data = await api("/api/jobs/" + jobId);
      updateStats(data.stats);
      setProgressView(buildProgressFromJob(data));

      // 渲染新增的日志
      if (Array.isArray(data.logs) && el.logWindow) {
        const newLogs = data.logs.slice(state.lastLogIndex);
        if (newLogs.length > 0) {
          newLogs.forEach(function(msg) {
            const entry = document.createElement("div");
            entry.className = "log-entry";
            entry.textContent = msg;
            el.logWindow.appendChild(entry);
          });
          state.lastLogIndex = data.logs.length;
          el.logWindow.scrollTop = el.logWindow.scrollHeight;
        }
      }

      if (data.status === "running" || data.status === "queued") {
        setStatus("running", data.message || "実行中");
        return;
      }

      if (data.status === "completed") {
        setStatus("success", data.message || "同期が完了しました。");
        if (data.errorCsvPath) {
          el.errorCsvLink.href = "/api/error-csv/" + jobId;
          el.errorCsvLink.classList.remove("hidden");
        }
        stopPolling();
        state.running = false;
        refreshControls();
        log("同期完了。");
        return;
      }

      if (data.status === "failed") {
        setStatus("failed", data.error || data.message || "同期に失敗しました。");
        showError(data.error || data.message || "同期に失敗しました。");
        if (data.hint) log("ヒント: " + data.hint);
        stopPolling();
        state.running = false;
        refreshControls();
      }
    } catch (error) {
      stopPolling();
      state.running = false;
      refreshControls();
      const message = "ジョブステータスの取得に失敗: " + toErrorMessage(error);
      showError(message);
      setStatus("failed", message);
      setProgressView({
        phaseText: "失敗",
        percent: 0,
        detail: message,
        indeterminate: false,
      });
      log(message);
    }
  }

  /**
   * 启动同步任务
   * 1. 验证映射配置
   * 2. 调用 /api/start 创建同步任务
   * 3. 启动轮询定时器（每 1.8 秒检查一次任务状态）
   */
  async function startSync() {
    try {
      validateMappings();
    } catch (error) {
      const message = toErrorMessage(error);
      showError(message);
      setStatus("failed", message);
      log("バリデーションエラー: " + message, true);
      return;
    }

    showError("");
    showInfo("");

    state.running = true;
    state.lastLogIndex = 0;       // ログインデックスをリセット（新ジョブのログを末尾に追加）
    // ※ logWindow はクリアしない（以前のログを保持）
    refreshControls();
    resetStats();
    el.errorCsvLink.classList.add("hidden");

    try {
      const data = await api("/api/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(collectStartPayload()),
      });

      state.jobId = data.jobId;
      setStatus("running", "同期を開始しました。");
      setProgressView({
        phaseText: "待機中",
        percent: 1,
        detail: "ジョブをキューに登録しました。",
        indeterminate: true,
      });
      log("同期開始。ジョブID=" + data.jobId);

      stopPolling();
      state.pollTimer = setInterval(function () {
        pollJob(state.jobId);
      }, 1800);
    } catch (error) {
      state.running = false;
      refreshControls();
      const message = toErrorMessage(error);
      showError(message);
      setStatus("failed", message);
      setProgressView({
        phaseText: "失敗",
        percent: 0,
        detail: message,
        indeterminate: false,
      });
      log("同期開始エラー: " + message, true);
    }
  }

  /**
   * 应用自动映射
   * 将通过同名匹配生成的映射应用到更新映射和插入映射
   * Key 映射使用自动映射的第一项
   */
  function applyAutoMappings() {
    if (state.mappingLocked) return;
    if (!state.autoMappings.length) {
      throw new Error("自動マッピングがありません。先にスキーマを読み込んでください。");
    }

    state.updateMappings = state.autoMappings.map(function (item) {
      return createMappingRow(item);
    });
    state.insertMappings = state.autoMappings.map(function (item) {
      return createMappingRow(item);
    });

    if (modeInfo().needsKey) {
      const first = state.autoMappings[0];
      if (first) {
        state.keyMappings = [createMappingRow(first)];
      }
    }

    renderMappings();
    log("自動マッピング適用: " + state.autoMappings.length + " 行。");
  }

  /**
   * 为映射列表容器绑定事件委托
   * 处理下拉框变更和删除按钮点击事件
   *
   * @param {HTMLElement} container - 映射列表容器
   * @param {string} group - 映射分组标识
   */
  function attachMappingEvents(container, group) {
    container.addEventListener("change", function (event) {
      if (state.mappingLocked) return;
      const target = event.target;
      if (!(target instanceof HTMLSelectElement)) return;
      const row = target.closest(".mapping-row");
      if (!row) return;
      const mapId = row.getAttribute("data-map-id");
      if (!mapId) return;

      const role = target.getAttribute("data-role");
      if (role === "field") {
        upsertRowValue(group, mapId, { fieldName: target.value });
      } else if (role === "csv") {
        upsertRowValue(group, mapId, { csvColumn: target.value });
      }
    });

    container.addEventListener("click", function (event) {
      if (state.mappingLocked) return;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const button = target.closest('button[data-role="remove"]');
      if (!button) return;
      const row = button.closest(".mapping-row");
      if (!row) return;
      const mapId = row.getAttribute("data-map-id");
      if (!mapId) return;
      removeRow(group, mapId);
    });
  }

  /**
   * 绑定所有 UI 事件监听器
   * 包括：
   * - OAuth 登录消息监听（postMessage）
   * - 配置弹窗的打开/关闭/保存
   * - CSV 文件选择和上传
   * - 表格选择变更
   * - 同步模式切换
   * - 映射操作（添加/删除/自动映射）
   * - Schema 重新加载
   * - 同步任务启动
   */
  function bindEvents() {
    window.addEventListener("message", async function (event) {
      const message = event.data || {};

      if (message.type === "lark-auth-success") {
        state.authSessionId = message.sessionId || "";
        state.authUserName = message.userName || "";
        updateLoginStatus();
        setStatus("idle", "ログイン成功。CSVファイルを選択してください。");
        log("ログイン成功: " + (state.authUserName || "Lark User"));
        refreshControls();
        try {
          await tryAutoLoadSchema();
        } catch (error) {
          showError(toErrorMessage(error));
        }
        return;
      }

      if (message.type === "lark-auth-failed") {
        state.authSessionId = "";
        state.authUserName = "";
        updateLoginStatus();
        refreshControls();
        const reason = message.error || "ログインに失敗しました。";
        showError(reason);
        setStatus("failed", reason);
        log("ログイン失敗: " + reason);
      }
    });

    el.editConfigBtn.addEventListener("click", function () {
      openConfigModal();
      refreshControls();
    });

    el.configModalCloseBtn.addEventListener("click", function () {
      closeConfigModal();
    });

    el.configModalBackdrop.addEventListener("click", function () {
      closeConfigModal();
    });

    window.addEventListener("keydown", function (event) {
      if (event.key !== "Escape") return;
      if (!state.configModalOpen) return;
      closeConfigModal();
    });

    el.configModalSaveBtn.addEventListener("click", function () {
      saveSettings().catch(function (error) {
        const message = toErrorMessage(error);
        showError(message);
        setStatus("failed", message);
        log("設定保存失敗: " + message);
      });
    });

    el.loginBtn.addEventListener("click", async function () {
      state.busy = true;
      refreshControls();
      showError("");
      showInfo("");
      try {
        await startLogin();
      } catch (error) {
        const message = toErrorMessage(error);
        showError(message);
        setStatus("failed", message);
        log("ログイン開始失敗: " + message);
      } finally {
        state.busy = false;
        refreshControls();
      }
    });

    el.logoutBtn.addEventListener("click", function () {
      log("ログアウトしました。");
      resetAllState();
    });

    el.csvFile.addEventListener("change", function (event) {
      const file =
        event.target && event.target.files && event.target.files.length
          ? event.target.files[0]
          : null;
      // 新しいファイル選択時に進捗情報をリセット
      resetStats();
      el.errorCsvLink.classList.add("hidden");
      setStatus("idle", "CSVファイルをアップロード中...");
      uploadCsv(file).catch(function (error) {
        const message = toErrorMessage(error);
        showError(message);
        setStatus("failed", message);
        log("CSVアップロード失敗: " + message, true);
      });
    });

    el.tableId.addEventListener("change", function () {
      if (state.mappingLocked) return;
      state.selectedTableId = el.tableId.value;
      loadSchema(state.selectedTableId).catch(function (error) {
        const message = toErrorMessage(error);
        showError(message);
        setStatus("failed", message);
        log("スキーマ再読込失敗: " + message, true);
      });
    });

    el.mode.addEventListener("change", function () {
      if (state.mappingLocked) return;
      refreshModeView();
      refreshControls();
    });

    el.addKeyMappingBtn.addEventListener("click", function () {
      addRow("key");
    });

    el.addUpdateMappingBtn.addEventListener("click", function () {
      addRow("update");
    });

    el.addInsertMappingBtn.addEventListener("click", function () {
      addRow("insert");
    });

    el.autoMapBtn.addEventListener("click", function () {
      try {
        applyAutoMappings();
      } catch (error) {
        const message = toErrorMessage(error);
        showError(message);
        log("自動マッピング失敗: " + message, true);
      }
    });

    el.reloadSchemaBtn.addEventListener("click", function () {
      loadSchema(state.selectedTableId).catch(function (error) {
        const message = toErrorMessage(error);
        showError(message);
        setStatus("failed", message);
        log("スキーマ再読込失敗: " + message, true);
      });
    });

    el.startBtn.addEventListener("click", function () {
      startSync().catch(function (error) {
        const message = toErrorMessage(error);
        showError(message);
        setStatus("failed", message);
        log("同期開始失敗: " + message, true);
      });
    });

    attachMappingEvents(el.keyMappingsList, "key");
    attachMappingEvents(el.updateMappingsList, "update");
    attachMappingEvents(el.insertMappingsList, "insert");
  }

  /**
   * 从服务器加载默认配置
   * 调用 /api/defaults 获取环境变量和已保存的配置
   * 将配置填充到对应的输入框和状态中
   */
  async function loadDefaults() {
    try {
      const data = await api("/api/defaults");
      el.appId.value = data.appId || "";
      el.appSecret.value = data.appSecret || "";
      el.apiBase.value = data.apiBase || "https://open.larksuite.com";
      el.baseUrl.value = data.baseUrl || "";
      el.mode.value = data.mode || "upsert";
      state.defaults.encoding = data.encoding || "utf8";
      state.defaults.batchSize = Number(data.batchSize || 500);
      state.hasSavedConfig = Boolean(data.hasSavedConfig);
      updateConfigButtonLabel();
      closeConfigModal();
      refreshControls();
    } catch (error) {
      log("デフォルト読込失敗: " + toErrorMessage(error), true);
    }
  }

  /**
   * 应用初始化函数
   * 执行顺序：
   * 1. 绑定事件监听器
   * 2. 重置统计数字
   * 3. 更新登录状态
   * 4. 渲染表格选项和映射列表
   * 5. 刷新模式视图和控件状态
   * 6. 从服务器加载默认配置
   */
  async function init() {
    bindEvents();
    resetStats();
    updateLoginStatus();
    renderTableOptions();
    renderMappings();
    refreshModeView();
    refreshControls();
    setStatus("idle", "Larkにログインし、CSVファイルを選択してください。");
    await loadDefaults();
  }

  // 同期実行中はウィンドウを閉じさせない（beforeunload ガード）
  // ブラウザ環境: ブラウザ標準の離脱確認ダイアログが表示される
  // Electron 環境: will-prevent-unload イベントを発火させ、main 側でネイティブダイアログを表示
  window.addEventListener('beforeunload', function (e) {
    if (!state.running) return;
    e.preventDefault();
    // 旧ブラウザ互換 (Chrome 等では returnValue も必要)
    e.returnValue = '同期が実行中です。本当に閉じますか？';
    return e.returnValue;
  });

  // 执行初始化
  init();
})();



