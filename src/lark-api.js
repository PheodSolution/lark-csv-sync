// ============================================================================
// Lark API 客户端模块
// ============================================================================
// 本模块封装了所有 Lark OpenAPI 调用,包括:
// 1. 认证管理(tenant_access_token, app_access_token, user_access_token)
// 2. OAuth 2.0 流程(授权码交换、令牌刷新)
// 3. 多维表格 API(表管理、字段管理、记录 CRUD)
// 4. 自动重试机制(指数退避、错误码识别)
// 5. OIDC 双通道支持(优先使用 OIDC,失败后回退旧版)
// ============================================================================

// 可重试的 Lark API 错误码集合
// 这些错误码表示临时性错误,可以通过重试解决
const RETRYABLE_CODES = new Set([
  1254290, // TooManyRequest - 请求频率超限(QPS 限制)
  1254291, // Write conflict - 写冲突(并发写入冲突)
  1254607, // Data not ready - 数据未就绪(后端处理中)
  1255040, // Request timeout - 请求超时
]);

/**
 * 延迟函数
 * 返回一个在指定毫秒后 resolve 的 Promise,用于实现异步等待
 *
 * @param {number} ms - 延迟的毫秒数
 * @returns {Promise<void>}
 *
 * @example
 * await sleep(1000); // 等待 1 秒
 * await sleep(500);  // 等待 0.5 秒
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 将错误对象转换为字符串消息
 * 统一处理 Error 对象和其他类型的错误值
 *
 * @param {Error|any} error - 错误对象或其他值
 * @returns {string} - 错误消息字符串
 *
 * @example
 * toErrorMessage(new Error('test'))  // => 'test'
 * toErrorMessage('error string')     // => 'error string'
 * toErrorMessage(404)                // => '404'
 */
function toErrorMessage(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * 构建请求错误对象
 * 创建一个带有 retryable 标记的 Error 对象
 *
 * @param {string} message - 错误消息
 * @param {boolean} retryable - 是否可重试
 * @returns {Error} - 带有 retryable 属性的 Error 对象
 *
 * @example
 * throw buildRequestError('Network error', true);  // 可重试错误
 * throw buildRequestError('Invalid token', false); // 不可重试错误
 */
function buildRequestError(message, retryable) {
  const error = new Error(message);
  error.retryable = Boolean(retryable); // 添加 retryable 属性
  return error;
}

/**
 * 从 Lark API 响应中提取 data 字段
 * Lark API 响应格式通常为 { code, msg, data },需要解包 data 字段
 *
 * @param {Object} payload - API 响应对象
 * @returns {Object} - 解包后的 data 对象,如果不存在则返回原始 payload
 *
 * @example
 * unwrapPayload({ code: 0, data: { name: 'test' } })  // => { name: 'test' }
 * unwrapPayload({ name: 'test' })                     // => { name: 'test' }
 */
function unwrapPayload(payload) {
  if (!payload || typeof payload !== 'object') return {};
  // 如果存在 data 字段且为对象,返回 data
  if ('data' in payload && payload.data && typeof payload.data === 'object') {
    return payload.data;
  }
  // 否则返回原始 payload
  return payload;
}

/**
 * Lark API 客户端类
 * 封装所有 Lark OpenAPI 调用,提供统一的接口
 *
 * 主要功能:
 * 1. 令牌管理:自动获取和缓存 tenant_access_token、app_access_token
 * 2. OAuth 2.0:支持用户授权、令牌交换、令牌刷新
 * 3. 自动重试:内置指数退避重试机制,最多重试 6 次
 * 4. 错误处理:识别可重试错误码,自动刷新过期令牌
 * 5. OIDC 支持:优先使用 OIDC 端点,失败后回退旧版端点
 *
 * @class LarkApiClient
 */
class LarkApiClient {
  /**
   * 构造函数
   *
   * @param {Object} options - 配置选项
   * @param {string} options.appId - Lark 应用 ID(必需)
   * @param {string} options.appSecret - Lark 应用密钥(必需)
   * @param {string} [options.baseUrl='https://open.larksuite.com'] - API 基础地址
   * @param {number} [options.maxRetries=6] - 最大重试次数
   * @param {Function} [options.accessTokenProvider] - 自定义令牌提供函数(用于 user_access_token)
   *
   * @example
   * // 基本用法
   * const client = new LarkApiClient({
   *   appId: 'cli_xxx',
   *   appSecret: 'xxx'
   * });
   *
   * // 使用自定义令牌提供函数(用于 OAuth 场景)
   * const client = new LarkApiClient({
   *   appId: 'cli_xxx',
   *   appSecret: 'xxx',
   *   accessTokenProvider: async (forceRefresh) => {
   *     return await getUserAccessToken(forceRefresh);
   *   }
   * });
   */
  constructor(options) {
    this.appId = options.appId;           // Lark 应用 ID
    this.appSecret = options.appSecret;   // Lark 应用密钥
    this.baseUrl = options.baseUrl || 'https://open.larksuite.com'; // API 基础地址
    this.maxRetries = Number.isFinite(options.maxRetries) ? options.maxRetries : 6; // 最大重试次数

    // 自定义令牌提供函数(用于 user_access_token 场景)
    this.accessTokenProvider =
      typeof options.accessTokenProvider === 'function'
        ? options.accessTokenProvider
        : null;

    // 租户令牌缓存
    this.tenantToken = '';              // tenant_access_token
    this.tenantTokenExpireAt = 0;       // 过期时间(Unix 时间戳)

    // 应用令牌缓存
    this.appAccessToken = '';           // app_access_token
    this.appAccessTokenExpireAt = 0;    // 过期时间(Unix 时间戳)
  }

  /**
   * 发送 POST JSON 请求的通用方法
   * 用于内部调用,不包含重试逻辑
   *
   * @param {string} path - API 路径(相对于 baseUrl)
   * @param {Object} body - 请求体对象
   * @param {Object} [headers={}] - 额外的 HTTP 头
   * @returns {Promise<Object>} - 解包后的响应数据
   * @throws {Error} - 如果请求失败或响应码不为 0
   *
   * @private
   */
  async postJson(path, body, headers = {}) {
    const url = new URL(path, this.baseUrl); // 构造完整 URL
    const response = await fetch(url.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        ...headers, // 合并自定义 headers
      },
      body: JSON.stringify(body || {}), // 序列化请求体
    });

    let payload = {};
    try {
      payload = await response.json(); // 解析 JSON 响应
    } catch {
      payload = {}; // 解析失败返回空对象
    }

    // 检查响应状态和 Lark API code
    // response.ok: HTTP 状态码 2xx
    // payload.code: Lark API 业务状态码(0 表示成功)
    if (!response.ok || Number(payload.code) !== 0) {
      throw new Error(
        `HTTP ${response.status}, code ${payload.code}, msg ${payload.msg || 'unknown'}`
      );
    }

    return unwrapPayload(payload); // 返回解包后的数据
  }

  /**
   * 获取租户访问令牌(tenant_access_token)
   * 用于应用级别的 API 调用(非用户级别)
   *
   * 令牌缓存策略:
   * - 如果缓存未过期且不强制刷新,直接返回缓存
   * - 提前 60 秒刷新令牌,避免在使用时过期
   * - 默认有效期 7200 秒(2 小时)
   *
   * @param {boolean} [forceRefresh=false] - 是否强制刷新令牌
   * @returns {Promise<string>} - tenant_access_token
   * @throws {Error} - 如果获取失败
   *
   * @example
   * const token = await client.getTenantAccessToken();
   * const newToken = await client.getTenantAccessToken(true); // 强制刷新
   */
  async getTenantAccessToken(forceRefresh = false) {
    const now = Date.now();

    // 检查缓存是否有效(提前 60 秒刷新)
    if (
      !forceRefresh &&
      this.tenantToken &&
      this.tenantTokenExpireAt &&
      now < this.tenantTokenExpireAt - 60 * 1000 // 提前 60 秒
    ) {
      return this.tenantToken; // 返回缓存的令牌
    }

    let data;
    try {
      // 调用 Lark API 获取 tenant_access_token
      data = await this.postJson('/open-apis/auth/v3/tenant_access_token/internal', {
        app_id: this.appId,
        app_secret: this.appSecret,
      });
    } catch (error) {
      throw buildRequestError(`Failed to get tenant_access_token: ${toErrorMessage(error)}`, true);
    }

    // 验证响应数据
    if (!data.tenant_access_token) {
      throw buildRequestError('tenant_access_token is empty', false);
    }

    // 缓存令牌
    this.tenantToken = data.tenant_access_token;
    const expiresIn = Number(data.expire || data.expires_in || 7200); // 默认 2 小时
    this.tenantTokenExpireAt = Date.now() + expiresIn * 1000; // 计算过期时间

    return this.tenantToken;
  }

  /**
   * 获取应用访问令牌(app_access_token)
   * 用于 OAuth 流程中的令牌交换和刷新
   *
   * 令牌缓存策略:同 getTenantAccessToken
   *
   * @param {boolean} [forceRefresh=false] - 是否强制刷新令牌
   * @returns {Promise<string>} - app_access_token
   * @throws {Error} - 如果获取失败
   */
  async getAppAccessToken(forceRefresh = false) {
    const now = Date.now();

    // 检查缓存是否有效
    if (
      !forceRefresh &&
      this.appAccessToken &&
      this.appAccessTokenExpireAt &&
      now < this.appAccessTokenExpireAt - 60 * 1000
    ) {
      return this.appAccessToken;
    }

    let data;
    try {
      data = await this.postJson('/open-apis/auth/v3/app_access_token/internal', {
        app_id: this.appId,
        app_secret: this.appSecret,
      });
    } catch (error) {
      throw buildRequestError(`Failed to get app_access_token: ${toErrorMessage(error)}`, true);
    }

    if (!data.app_access_token) {
      throw buildRequestError('app_access_token is empty', false);
    }

    this.appAccessToken = data.app_access_token;
    const expiresIn = Number(data.expire || data.expires_in || 7200);
    this.appAccessTokenExpireAt = Date.now() + expiresIn * 1000;

    return this.appAccessToken;
  }

  /**
   * 构造 OAuth 用户授权 URL
   * 用于引导用户进行 Lark OAuth 登录
   *
   * @param {string} redirectUri - OAuth 回调地址(必须在 Lark 开发者平台配置)
   * @param {string} [state] - 状态参数(用于防 CSRF 攻击)
   * @returns {string} - 完整的授权 URL
   *
   * @example
   * const authUrl = client.getUserAuthorizeUrl(
   *   'http://127.0.0.1:3904/api/auth/callback',
   *   'random-state-string'
   * );
   * // 在浏览器中打开 authUrl,用户完成授权后会重定向到 redirectUri
   */
  getUserAuthorizeUrl(redirectUri, state) {
    const url = new URL('/open-apis/authen/v1/index', this.baseUrl);
    url.searchParams.set('app_id', this.appId);           // 应用 ID
    url.searchParams.set('redirect_uri', redirectUri);    // 回调地址
    if (state) url.searchParams.set('state', state);      // 状态参数(可选)
    return url.toString();
  }

  /**
   * 用授权码换取用户访问令牌(user_access_token)
   * OAuth 2.0 授权码模式的第二步
   *
   * OIDC 双通道策略:
   * 1. 优先使用 OIDC 端点(/open-apis/authen/v1/oidc/access_token)
   * 2. 如果 OIDC 失败,回退到旧版端点(/open-apis/authen/v1/access_token)
   * 3. 如果两者都失败,抛出包含两个错误的异常
   *
   * @param {string} code - OAuth 授权码(从回调 URL 中获取)
   * @returns {Promise<Object>} - 令牌数据对象
   *   {
   *     access_token: string,      // 用户访问令牌
   *     refresh_token: string,     // 刷新令牌
   *     expires_in: number,        // 访问令牌有效期(秒)
   *     refresh_expires_in: number // 刷新令牌有效期(秒)
   *   }
   * @throws {Error} - 如果两个端点都失败
   *
   * @example
   * const tokenData = await client.exchangeAuthCodeForUserToken('auth_code_xxx');
   * console.log(tokenData.access_token);  // user_access_token
   * console.log(tokenData.refresh_token); // refresh_token
   */
  async exchangeAuthCodeForUserToken(code) {
    const appAccessToken = await this.getAppAccessToken(false); // 获取 app_access_token
    const headers = {
      Authorization: `Bearer ${appAccessToken}`, // 使用 app_access_token 认证
    };
    const body = {
      grant_type: 'authorization_code', // 授权类型
      code,                             // 授权码
    };

    try {
      // 优先使用 OIDC 端点
      return await this.postJson('/open-apis/authen/v1/oidc/access_token', body, headers);
    } catch (oidcError) {
      try {
        // OIDC 失败,回退到旧版端点
        return await this.postJson('/open-apis/authen/v1/access_token', body, headers);
      } catch (legacyError) {
        // 两者都失败,抛出包含两个错误的异常
        throw new Error(
          `Exchange code failed. oidc=${toErrorMessage(oidcError)}; legacy=${toErrorMessage(legacyError)}`
        );
      }
    }
  }

  /**
   * 刷新用户访问令牌
   * 当 user_access_token 过期时,使用 refresh_token 获取新的令牌
   *
   * OIDC 双通道策略:同 exchangeAuthCodeForUserToken
   *
   * @param {string} refreshToken - 刷新令牌
   * @returns {Promise<Object>} - 新的令牌数据对象(格式同 exchangeAuthCodeForUserToken)
   * @throws {Error} - 如果两个端点都失败
   *
   * @example
   * const newTokenData = await client.refreshUserAccessToken(oldRefreshToken);
   * // 使用新的 access_token 和 refresh_token 更新会话
   */
  async refreshUserAccessToken(refreshToken) {
    const appAccessToken = await this.getAppAccessToken(false);
    const headers = {
      Authorization: `Bearer ${appAccessToken}`,
    };
    const body = {
      grant_type: 'refresh_token', // 授权类型
      refresh_token: refreshToken, // 刷新令牌
    };

    try {
      // 优先使用 OIDC 端点
      return await this.postJson('/open-apis/authen/v1/oidc/refresh_access_token', body, headers);
    } catch (oidcError) {
      try {
        // 回退到旧版端点
        return await this.postJson('/open-apis/authen/v1/refresh_access_token', body, headers);
      } catch (legacyError) {
        throw new Error(
          `Refresh user token failed. oidc=${toErrorMessage(oidcError)}; legacy=${toErrorMessage(legacyError)}`
        );
      }
    }
  }

  /**
   * 获取用户信息
   * 使用 user_access_token 获取当前登录用户的基本信息
   *
   * @param {string} userAccessToken - 用户访问令牌
   * @returns {Promise<Object>} - 用户信息对象
   *   {
   *     name: string,       // 用户名
   *     en_name: string,    // 英文名
   *     open_id: string,    // 用户 open_id
   *     union_id: string,   // 用户 union_id
   *     ...                 // 其他用户信息
   *   }
   * @throws {Error} - 如果请求失败
   *
   * @example
   * const userInfo = await client.getUserInfo(userAccessToken);
   * console.log(userInfo.name);     // 用户名
   * console.log(userInfo.open_id);  // open_id
   */
  async getUserInfo(userAccessToken) {
    const url = new URL('/open-apis/authen/v1/user_info', this.baseUrl);
    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${userAccessToken}`, // 使用 user_access_token 认证
        'Content-Type': 'application/json; charset=utf-8',
      },
    });

    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }

    if (!response.ok || Number(payload.code) !== 0) {
      throw new Error(
        `Failed to get user info: HTTP ${response.status}, code ${payload.code}, msg ${payload.msg || 'unknown'}`
      );
    }

    return payload.data || {};
  }

  /**
   * 获取访问令牌(统一入口)
   * 根据配置自动选择令牌类型:
   * - 如果配置了 accessTokenProvider,使用 user_access_token(用户级别)
   * - 否则使用 tenant_access_token(应用级别)
   *
   * @param {boolean} [forceRefresh=false] - 是否强制刷新令牌
   * @returns {Promise<string>} - 访问令牌
   * @throws {Error} - 如果获取失败
   *
   * @private
   * @example
   * const token = await client.getAccessToken();      // 获取令牌
   * const newToken = await client.getAccessToken(true); // 强制刷新
   */
  async getAccessToken(forceRefresh = false) {
    if (this.accessTokenProvider) {
      const token = await this.accessTokenProvider(forceRefresh);
      if (!token) {
        throw buildRequestError('user_access_token is empty', false);
      }
      return token;
    }
    return this.getTenantAccessToken(forceRefresh);
  }

  /**
   * 通用 HTTP 请求方法(带自动重试)
   * 这是所有 Lark API 调用的核心方法,包含完整的错误处理和重试逻辑
   *
   * 重试策略:
   * 1. 401 未授权:自动刷新令牌并重试
   * 2. 429 限流/5xx 服务器错误/可重试错误码:指数退避重试
   * 3. 网络错误(TypeError):指数退避重试
   * 4. 最多重试 maxRetries 次(默认 6 次)
   *
   * 退避算法:
   * - 基础延迟:500ms * 2^attempt
   * - 随机抖动:0-200ms
   * - 最大延迟:30 秒
   *
   * @param {Object} options - 请求选项
   * @param {string} options.method - HTTP 方法(GET/POST/PUT/DELETE)
   * @param {string} options.path - API 路径(相对于 baseUrl)
   * @param {Object} [options.query] - URL 查询参数对象
   * @param {Object} [options.body] - 请求体对象(仅 POST/PUT)
   * @returns {Promise<Object>} - 响应数据(已解包 data 字段)
   * @throws {Error} - 如果所有重试都失败
   *
   * @private
   * @example
   * // GET 请求
   * const data = await client.request({
   *   method: 'GET',
   *   path: '/open-apis/bitable/v1/apps/xxx/tables',
   *   query: { page_size: 100 }
   * });
   *
   * // POST 请求
   * const result = await client.request({
   *   method: 'POST',
   *   path: '/open-apis/bitable/v1/apps/xxx/tables/yyy/records/batch_create',
   *   body: { records: [...] }
   * });
   */
  async request(options) {
    const { method, path, query, body } = options;

    // 重试循环:最多尝试 maxRetries + 1 次
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        // 1. 获取访问令牌
        const token = await this.getAccessToken(false);
        const url = new URL(path, this.baseUrl);

        // 2. 构造查询参数(过滤空值)
        if (query && typeof query === 'object') {
          Object.entries(query).forEach(([key, value]) => {
            if (value === undefined || value === null || value === '') return;
            url.searchParams.set(key, String(value));
          });
        }

        // 3. 发送 HTTP 请求
        const response = await fetch(url.toString(), {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json; charset=utf-8',
          },
          body: body ? JSON.stringify(body) : undefined,
        });

        // 4. 解析响应
        let payload = {};
        try {
          payload = await response.json();
        } catch {
          payload = {}; // JSON 解析失败返回空对象
        }

        const code = Number(payload.code);

        // 5. 处理 401 未授权错误(令牌过期)
        if (response.status === 401) {
          await this.getAccessToken(true); // 强制刷新令牌
          if (attempt < this.maxRetries) {
            await sleep(300); // 等待 300ms 后重试
            continue;
          }
        }

        // 6. 判断是否应该重试
        const shouldRetry =
          response.status === 429 ||              // 限流
          response.status >= 500 ||               // 服务器错误
          RETRYABLE_CODES.has(code);              // 可重试的业务错误码

        // 7. 处理错误响应
        if (response.status >= 400 || code !== 0) {
          const message = `Lark API 请求失败: ${method} ${path}, HTTP ${response.status}, code ${payload.code}, msg ${payload.msg || 'unknown'}`;
          if (shouldRetry && attempt < this.maxRetries) {
            // 计算退避延迟(指数退避 + 随机抖动)
            const backoff = Math.min(
              30000, // 最大 30 秒
              500 * 2 ** attempt + Math.floor(Math.random() * 200) // 指数退避 + 抖动
            );
            await sleep(backoff);
            continue; // 重试
          }
          throw buildRequestError(message, shouldRetry);
        }

        // 8. 成功返回数据
        return payload.data || {};
      } catch (error) {
        // 9. 处理异常(网络错误等)
        const retryable =
          error && error.retryable !== undefined
            ? Boolean(error.retryable)
            : error instanceof TypeError; // TypeError 通常是网络错误,可重试

        if (!retryable || attempt >= this.maxRetries) {
          throw new Error(`重试后仍然失败: ${toErrorMessage(error)}`);
        }

        // 计算退避延迟并重试
        const backoff = Math.min(30000, 500 * 2 ** attempt + Math.floor(Math.random() * 200));
        await sleep(backoff);
      }
    }

    // 理论上不会到达这里(循环会抛出异常)
    throw new Error('未知错误导致请求失败');
  }

  /**
   * 列出多维表格中的所有数据表
   * 自动处理分页,返回所有表的完整列表
   *
   * @param {string} appToken - 多维表格的 app_token(从 URL 中获取)
   * @returns {Promise<Array>} - 数据表列表
   *   [
   *     {
   *       table_id: string,    // 数据表 ID
   *       name: string,        // 数据表名称
   *       revision: number,    // 版本号
   *       ...                  // 其他表属性
   *     },
   *     ...
   *   ]
   * @throws {Error} - 如果请求失败
   *
   * @example
   * const tables = await client.listTables('bascnxxxxxx');
   * console.log(tables.length);        // 表数量
   * console.log(tables[0].table_id);   // 第一个表的 ID
   * console.log(tables[0].name);       // 第一个表的名称
   */
  async listTables(appToken) {
    const results = [];
    let pageToken = '';
    let hasMore = true;

    // 分页循环:持续获取直到没有更多数据
    while (hasMore) {
      const data = await this.request({
        method: 'GET',
        path: `/open-apis/bitable/v1/apps/${appToken}/tables`,
        query: {
          page_size: 100,                      // 每页 100 条
          page_token: pageToken || undefined,  // 分页令牌
        },
      });

      const items = Array.isArray(data.items) ? data.items : [];
      results.push(...items);                  // 合并结果
      hasMore = Boolean(data.has_more);        // 是否有更多数据
      pageToken = data.page_token || '';       // 下一页令牌
      if (hasMore && !pageToken) break;        // 异常情况:有更多数据但没有令牌
    }

    return results;
  }

  /**
   * 列出数据表中的所有字段
   * 自动处理分页,返回所有字段的完整列表
   *
   * @param {string} appToken - 多维表格的 app_token
   * @param {string} tableId - 数据表 ID
   * @returns {Promise<Array>} - 字段列表
   *   [
   *     {
   *       field_id: string,    // 字段 ID
   *       field_name: string,  // 字段名称
   *       type: number,        // 字段类型(1=文本,2=数字,3=单选,4=多选,5=日期,7=复选框,11=人员,15=超链接,17=附件,18=单向关联,21=公式,22=双向关联,1001=创建时间,1002=修改时间,1003=创建人,1004=修改人,1005=自动编号)
   *       property: Object,    // 字段属性(根据类型不同而不同)
   *       ...                  // 其他字段属性
   *     },
   *     ...
   *   ]
   * @throws {Error} - 如果请求失败
   *
   * @example
   * const fields = await client.listFields('bascnxxxxxx', 'tblxxxxxx');
   * console.log(fields.length);           // 字段数量
   * console.log(fields[0].field_name);    // 第一个字段的名称
   * console.log(fields[0].type);          // 第一个字段的类型
   */
  async listFields(appToken, tableId) {
    const results = [];
    let pageToken = '';
    let hasMore = true;

    // 分页循环
    while (hasMore) {
      const data = await this.request({
        method: 'GET',
        path: `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields`,
        query: {
          page_size: 500,                      // 每页 500 条(字段数量通常不多)
          page_token: pageToken || undefined,
        },
      });
      const items = Array.isArray(data.items) ? data.items : [];
      results.push(...items);
      hasMore = Boolean(data.has_more);
      pageToken = data.page_token || '';
      if (hasMore && !pageToken) break;
    }

    return results;
  }

  /**
   * 搜索数据表记录(支持筛选和排序)
   * 使用 POST 方法,支持更复杂的查询条件(虽然当前实现未使用筛选条件)
   *
   * 注意:此方法返回单页数据,需要调用者自行处理分页
   *
   * @param {string} appToken - 多维表格的 app_token
   * @param {string} tableId - 数据表 ID
   * @param {Object} [options={}] - 搜索选项
   * @param {number} [options.pageSize=500] - 每页记录数(最大 500)
   * @param {string} [options.pageToken] - 分页令牌
   * @param {Array<string>} [options.fieldNames] - 要返回的字段名列表(不指定则返回所有字段)
   * @returns {Promise<Object>} - 搜索结果
   *   {
   *     items: Array,        // 记录列表
   *     has_more: boolean,   // 是否有更多数据
   *     page_token: string,  // 下一页令牌
   *     total: number        // 总记录数(可能不准确)
   *   }
   * @throws {Error} - 如果请求失败
   *
   * @example
   * // 获取第一页数据
   * const result = await client.searchRecords('bascnxxxxxx', 'tblxxxxxx', {
   *   pageSize: 100,
   *   fieldNames: ['字段1', '字段2'] // 只返回指定字段
   * });
   *
   * // 获取下一页
   * const nextResult = await client.searchRecords('bascnxxxxxx', 'tblxxxxxx', {
   *   pageToken: result.page_token
   * });
   */
  async searchRecords(appToken, tableId, options = {}) {
    const pageSize = options.pageSize || 500;
    const pageToken = options.pageToken || undefined;
    const body = {
      page_size: pageSize,
      page_token: pageToken,
      field_names:
        options.fieldNames && options.fieldNames.length ? options.fieldNames : undefined,
      automatic_fields: false, // 不自动填充系统字段(创建时间、修改时间等)
    };

    return this.request({
      method: 'POST',
      path: `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/search`,
      query: {
        user_id_type: 'user_id',  // 用户 ID 类型
        page_size: pageSize,
        page_token: pageToken,
      },
      body,
    });
  }

  /**
   * 列出数据表记录(简单列表)
   * 使用 GET 方法,不支持筛选和排序
   *
   * 注意:此方法返回单页数据,需要调用者自行处理分页
   *
   * @param {string} appToken - 多维表格的 app_token
   * @param {string} tableId - 数据表 ID
   * @param {Object} [options={}] - 列表选项
   * @param {number} [options.pageSize=500] - 每页记录数(最大 500)
   * @param {string} [options.pageToken] - 分页令牌
   * @returns {Promise<Object>} - 列表结果(格式同 searchRecords)
   * @throws {Error} - 如果请求失败
   *
   * @example
   * const result = await client.listRecords('bascnxxxxxx', 'tblxxxxxx', {
   *   pageSize: 100
   * });
   * console.log(result.items.length);  // 记录数量
   */
  async listRecords(appToken, tableId, options = {}) {
    return this.request({
      method: 'GET',
      path: `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
      query: {
        user_id_type: 'user_id',
        page_size: options.pageSize || 500,
        page_token: options.pageToken || undefined,
      },
    });
  }

  /**
   * 批量创建记录
   * 一次最多创建 500 条记录
   *
   * @param {string} appToken - 多维表格的 app_token
   * @param {string} tableId - 数据表 ID
   * @param {Array<Object>} records - 记录列表
   *   [
   *     {
   *       fields: {
   *         '字段名1': '值1',
   *         '字段名2': '值2',
   *         ...
   *       }
   *     },
   *     ...
   *   ]
   * @returns {Promise<Object>} - 创建结果
   *   {
   *     records: Array  // 创建成功的记录列表(包含 record_id)
   *   }
   * @throws {Error} - 如果请求失败
   *
   * @example
   * const result = await client.batchCreateRecords('bascnxxxxxx', 'tblxxxxxx', [
   *   { fields: { '姓名': '张三', '年龄': 25 } },
   *   { fields: { '姓名': '李四', '年龄': 30 } }
   * ]);
   * console.log(result.records[0].record_id); // 新记录的 ID
   */
  async batchCreateRecords(appToken, tableId, records) {
    return this.request({
      method: 'POST',
      path: `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_create`,
      query: {
        user_id_type: 'user_id',
      },
      body: {
        records,
      },
    });
  }

  /**
   * 批量更新记录
   * 一次最多更新 500 条记录
   *
   * @param {string} appToken - 多维表格的 app_token
   * @param {string} tableId - 数据表 ID
   * @param {Array<Object>} records - 记录列表(必须包含 record_id)
   *   [
   *     {
   *       record_id: 'recxxxxxx',  // 要更新的记录 ID
   *       fields: {
   *         '字段名1': '新值1',
   *         '字段名2': '新值2',
   *         ...
   *       }
   *     },
   *     ...
   *   ]
   * @returns {Promise<Object>} - 更新结果
   *   {
   *     records: Array  // 更新成功的记录列表
   *   }
   * @throws {Error} - 如果请求失败
   *
   * @example
   * const result = await client.batchUpdateRecords('bascnxxxxxx', 'tblxxxxxx', [
   *   { record_id: 'recxxxxxx', fields: { '年龄': 26 } },
   *   { record_id: 'recyyyyyy', fields: { '年龄': 31 } }
   * ]);
   * console.log(result.records.length); // 更新成功的记录数
   */
  async batchUpdateRecords(appToken, tableId, records) {
    console.log('appToken:::::::::::', appToken);
    console.log('tableId:::::::::::', tableId);
    console.log('records:::::::::::', JSON.stringify(records));
    return this.request({
      method: 'POST',
      path: `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records/batch_update`,
      query: {
        user_id_type: 'user_id',
      },
      body: {
        records,
      },
    });
  }
}

// ============================================================================
// 模块导出
// ============================================================================
// 导出 LarkApiClient 类供其他模块使用
module.exports = {
  LarkApiClient,
};
