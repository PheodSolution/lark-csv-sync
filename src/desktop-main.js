// 引入 Node.js 路径模块,用于处理文件路径
const path = require('path');
// 引入 Electron 核心模块
// - app: 控制应用程序的生命周期
// - BrowserWindow: 创建和管理浏览器窗口
// - dialog: 显示原生系统对话框(如错误提示)
const { app, BrowserWindow, dialog } = require('electron');

// GUI 服务器配置常量
// 绑定到本地回环地址,只允许本机访问,提高安全性
const GUI_HOST = '127.0.0.1';

// GUI 服务器端口号
// 从环境变量读取,如果未设置则使用默认值 3904
const GUI_PORT = Number(process.env.GUI_PORT || 3904);

// GUI 服务器基础 URL
// 用于在 Electron 窗口中加载本地 Web 应用
const GUI_BASE_URL = `http://${GUI_HOST}:${GUI_PORT}`;

// 全局变量:主窗口实例
// 保持对主窗口的引用,防止被垃圾回收
let mainWindow = null;

// 全局变量:嵌入式服务器实例
// 保存 Express 服务器对象,用于后续关闭操作
let embeddedServer = null;

// 全局变量:服务器启动标志
// 标记服务器是否由桌面应用启动(用于判断是否需要在退出时关闭服务器)
let startedServerByDesktop = false;

/**
 * 延迟函数
 * 返回一个在指定毫秒后 resolve 的 Promise
 * 
 * @param {number} ms - 延迟的毫秒数
 * @returns {Promise<void>}
 * 
 * @example
 * await sleep(1000); // 等待 1 秒
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 检查服务器是否存活
 * 通过发送 HTTP 请求到服务器的 /api/defaults 端点来检测服务器状态
 * 
 * @returns {Promise<boolean>} - 服务器是否可访问
 * 
 * 功能说明:
 * - 发送 GET 请求到服务器
 * - 如果响应成功(response.ok = true),返回 true
 * - 如果请求失败(网络错误、超时等),返回 false
 * 
 * @example
 * const alive = await isServerAlive();
 * if (alive) {
 *   console.log('服务器正在运行');
 * }
 */
async function isServerAlive() {
  try {
    // 发送 HTTP GET 请求到服务器的默认配置端点
    const response = await fetch(`${GUI_BASE_URL}/api/defaults`);
    // 检查响应状态是否成功(2xx 状态码)
    return response.ok;
  } catch {
    // 捕获所有错误(网络错误、超时等),返回 false
    return false;
  }
}

/**
 * 等待服务器启动
 * 轮询检查服务器是否可访问,直到成功或超时
 * 
 * @param {number} timeoutMs - 超时时间(毫秒),默认 30 秒
 * @returns {Promise<boolean>} - 服务器是否在超时前启动成功
 * 
 * 工作原理:
 * 1. 记录开始时间
 * 2. 每 300 毫秒检查一次服务器状态
 * 3. 如果服务器可访问,立即返回 true
 * 4. 如果超过超时时间,返回 false
 * 
 * @example
 * const ready = await waitForServer(30000);
 * if (!ready) {
 *   console.error('服务器启动超时');
 * }
 */
async function waitForServer(timeoutMs = 30000) {
  const startedAt = Date.now(); // 记录开始时间
  
  // 循环检查,直到超时
  while (Date.now() - startedAt < timeoutMs) {
    // 检查服务器是否存活
    if (await isServerAlive()) return true;
    
    // 等待 300 毫秒后再次检查
    await sleep(300);
  }
  
  // 超时,返回 false
  return false;
}

/**
 * 创建主窗口
 * 创建并配置 Electron 主窗口,加载本地 Web 应用
 * 
 * 窗口配置:
 * - 默认尺寸: 1320x900 像素
 * - 最小尺寸: 1024x720 像素
 * - 初始隐藏,等待内容加载完成后显示(避免白屏闪烁)
 * - 自动隐藏菜单栏(提供更简洁的界面)
 * - 背景色: #f7f2e9(米黄色,与应用主题一致)
 * 
 * 安全配置:
 * - contextIsolation: true - 启用上下文隔离(防止渲染进程访问 Node.js API)
 * - sandbox: true - 启用沙箱模式(增强安全性)
 * - nodeIntegration: false - 禁用 Node.js 集成(防止 XSS 攻击)
 * 
 * OAuth 登录窗口处理:
 * - 使用 setWindowOpenHandler 拦截 window.open 调用
 * - 在应用内打开 OAuth 登录弹窗(而非外部浏览器)
 * - 弹窗配置: 540x760 像素,模态窗口,继承安全配置
 */
function createMainWindow() {
  // 创建浏览器窗口实例
  mainWindow = new BrowserWindow({
    width: 1060,      // 窗口宽度
    height: 900,      // 窗口高度
    minWidth: 800,    // 最小宽度
    minHeight: 720,   // 最小高度
    show: false,      // 初始隐藏,等待 ready-to-show 事件
    autoHideMenuBar: true, // 自动隐藏菜单栏(Alt 键可显示)
    backgroundColor: '#f7f2e9', // 窗口背景色(米黄色)
    
    // Web 首选项配置(安全相关)
    webPreferences: {
      contextIsolation: true,  // 启用上下文隔离(渲染进程与主进程隔离)
      sandbox: true,           // 启用沙箱模式(限制渲染进程权限)
      nodeIntegration: false,  // 禁用 Node.js 集成(防止 XSS 攻击)
    },
  });

  // Keep OAuth login popup inside desktop app window flow.
  // 设置窗口打开处理器(用于处理 OAuth 登录弹窗)
  // 当渲染进程调用 window.open() 时触发
  mainWindow.webContents.setWindowOpenHandler(() => ({
    action: 'allow', // 允许打开新窗口
    
    // 覆盖新窗口的配置选项
    overrideBrowserWindowOptions: {
      width: 540,   // OAuth 登录窗口宽度
      height: 760,  // OAuth 登录窗口高度
      autoHideMenuBar: true, // 隐藏菜单栏
      parent: mainWindow,    // 设置父窗口(使其成为子窗口)
      modal: false,          // 非模态窗口(不阻塞父窗口)
      
      // 继承安全配置
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    },
  }));

  // 监听 'ready-to-show' 事件
  // 当窗口内容加载完成且准备显示时触发(避免白屏闪烁)
  mainWindow.once('ready-to-show', () => {
    mainWindow.show(); // 显示窗口
  });

  // 监听窗口关闭事件
  // 当窗口被关闭时,清空引用,允许垃圾回收
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 加载本地 Web 应用
  // 从嵌入式 Express 服务器加载 HTML 页面
  mainWindow.loadURL(GUI_BASE_URL);
}

/**
 * 确保运行时数据目录存在
 * 设置环境变量 LARK_SYNC_DATA_DIR,指定数据文件存储位置
 * 
 * 数据目录用途:
 * - 存储上传的 CSV 文件
 * - 存储同步报告
 * - 存储检查点文件
 * - 存储配置文件
 * 
 * 目录位置:
 * - Windows: C:\Users\<用户名>\AppData\Roaming\<应用名>\runtime
 * - macOS: ~/Library/Application Support/<应用名>/runtime
 * - Linux: ~/.config/<应用名>/runtime
 * 
 * @returns {string} - 数据目录的完整路径
 */
function ensureRuntimeDataDir() {
  // 如果环境变量未设置,则设置为 Electron userData 目录下的 runtime 子目录
  if (!process.env.LARK_SYNC_DATA_DIR) {
    // app.getPath('userData') 返回应用的用户数据目录
    // path.join 拼接路径,添加 'runtime' 子目录
    process.env.LARK_SYNC_DATA_DIR = path.join(app.getPath('userData'), 'runtime');
  }
  
  // 返回数据目录路径
  return process.env.LARK_SYNC_DATA_DIR;
}

/**
 * 启动嵌入式服务器
 * 在 Electron 应用内启动 Express 服务器
 * 
 * 功能说明:
 * 1. 确保数据目录存在
 * 2. 动态加载 gui-server.js 模块
 * 3. 调用 startServer 函数启动服务器
 * 4. 配置服务器选项(端口、严格模式、禁用浏览器自动打开)
 * 5. 标记服务器由桌面应用启动
 * 
 * 服务器配置:
 * - port: GUI_PORT (3904)
 * - strictPort: true - 端口被占用时不自动递增,直接报错
 * - openBrowser: false - 不自动打开浏览器(使用 Electron 窗口)
 * - logger: 自定义日志函数,输出到控制台
 */
async function startEmbeddedServer() {
  // 确保运行时数据目录存在
  ensureRuntimeDataDir();

  // 动态加载 gui-server.js 模块
  // require() 返回模块导出的对象,包含 startServer 函数
  const { startServer } = require('./gui-server');
  
  // 启动服务器,传入配置选项
  embeddedServer = await startServer({
    port: GUI_PORT,        // 端口号
    strictPort: true,      // 严格端口模式(不自动递增)
    openBrowser: false,    // 不自动打开浏览器
    
    // 自定义日志函数
    logger: (message) => {
      // 输出日志到控制台,添加 [gui] 前缀
      process.stdout.write(`[gui] ${message}\n`);
    },
  });
  
  // 标记服务器由桌面应用启动
  startedServerByDesktop = true;
}

/**
 * 应用启动引导函数
 * 负责启动服务器并创建主窗口的完整流程
 * 
 * 启动流程:
 * 1. 检查服务器是否已经运行
 * 2. 如果未运行,启动嵌入式服务器
 * 3. 等待服务器就绪(最多 30 秒)
 * 4. 如果服务器启动失败,显示错误对话框并退出应用
 * 5. 如果服务器就绪,创建主窗口
 * 
 * 错误处理:
 * - 服务器启动超时: 显示错误对话框,提示用户连接失败
 * - 自动退出应用,避免用户看到空白窗口
 * 
 * @example
 * // 在 app.whenReady() 事件中调用
 * app.whenReady().then(bootstrap);
 */
async function bootstrap() {
  // 检查服务器是否已经运行
  if (!(await isServerAlive())) {
    // 服务器未运行,启动嵌入式服务器
    startEmbeddedServer();
  }

  // 等待服务器就绪(最多 30 秒)
  const ready = await waitForServer(30000);
  if (!ready) {
    // 服务器启动失败,显示错误对话框
    dialog.showErrorBox(
      'Startup Failed', // 对话框标题
      `Failed to connect to local GUI server: ${GUI_BASE_URL}` // 错误消息
    );
    // 退出应用
    app.quit();
    return;
  }

  // 服务器就绪,创建主窗口
  createMainWindow();
}

/**
 * 清理函数
 * 在应用退出前关闭嵌入式服务器,释放资源
 * 
 * 清理条件:
 * - 服务器必须由桌面应用启动(startedServerByDesktop = true)
 * - 服务器实例存在(embeddedServer 不为 null)
 * - 服务器实例有 close 方法(typeof embeddedServer.close === 'function')
 * 
 * 如果不满足以上任一条件,说明:
 * - 服务器由外部启动(不应该关闭)
 * - 服务器已经关闭
 * - 服务器对象无效
 * 
 * 错误处理:
 * - 忽略关闭过程中的所有错误(使用 catch(() => {}))
 * - 确保应用能够正常退出,不会因为服务器关闭失败而卡住
 */
function cleanup() {
  // 检查清理条件
  if (!startedServerByDesktop || !embeddedServer || typeof embeddedServer.close !== 'function') {
    return; // 不满足条件,直接返回
  }

  // 关闭服务器
  embeddedServer.close().catch(() => {
    // 忽略关闭错误
  });
  
  // 清空服务器引用
  embeddedServer = null;
}

/**
 * 应用单实例锁
 * 确保同一时间只运行一个应用实例
 * 
 * 工作原理:
 * - requestSingleInstanceLock() 尝试获取单实例锁
 * - 如果获取成功,返回 true,当前实例成为主实例
 * - 如果获取失败,返回 false,说明已有实例在运行
 * 
 * 单实例模式的好处:
 * - 避免多个实例同时访问同一数据文件(可能导致数据冲突)
 * - 避免多个实例占用同一端口(导致启动失败)
 * - 提供更好的用户体验(点击图标时激活现有窗口,而非创建新窗口)
 */
const singleLock = app.requestSingleInstanceLock();

if (!singleLock) {
  // 获取锁失败,说明已有实例在运行
  // 直接退出当前实例
  app.quit();
} else {
  // 获取锁成功,当前实例成为主实例
  
  /**
   * 监听 'second-instance' 事件
   * 当用户尝试启动第二个实例时触发
   * 
   * 行为:
   * - 如果主窗口存在,激活并聚焦主窗口
   * - 如果主窗口最小化,先恢复窗口
   * - 这样用户点击图标时,会激活现有窗口,而非启动新实例
   */
  app.on('second-instance', () => {
    if (!mainWindow) return; // 主窗口不存在,直接返回
    
    // 如果窗口最小化,先恢复
    if (mainWindow.isMinimized()) mainWindow.restore();
    
    // 聚焦窗口(将窗口置于最前)
    mainWindow.focus();
  });

  /**
   * 监听 'ready' 事件
   * 当 Electron 完成初始化并准备创建浏览器窗口时触发
   * 
   * 调用 bootstrap() 函数启动应用
   */
  app.whenReady().then(bootstrap);

  /**
   * 监听 'before-quit' 事件
   * 在应用退出前触发,用于执行清理操作
   * 
   * 清理操作:
   * - 设置 app.isQuitting 标志(用于区分用户主动退出和关闭窗口)
   * - 调用 cleanup() 函数关闭嵌入式服务器
   */
  app.on('before-quit', () => {
    app.isQuitting = true; // 标记应用正在退出
    cleanup(); // 执行清理操作
  });

  /**
   * 监听 'window-all-closed' 事件
   * 当所有窗口都被关闭时触发
   * 
   * 平台差异处理:
   * - Windows/Linux: 关闭所有窗口时退出应用(符合用户习惯)
   * - macOS: 关闭所有窗口时不退出应用(保持应用在 Dock 中运行)
   *   用户可以通过 Cmd+Q 或菜单退出应用
   */
  app.on('window-all-closed', () => {
    // 如果不是 macOS 平台,退出应用
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  /**
   * 监听 'activate' 事件
   * 在 macOS 上,当用户点击 Dock 图标且没有窗口打开时触发
   * 
   * 行为:
   * - 如果主窗口不存在,创建新窗口
   * - 这是 macOS 应用的标准行为
   */
  app.on('activate', () => {
    if (!mainWindow) {
      createMainWindow(); // 创建主窗口
    }
  });
}
