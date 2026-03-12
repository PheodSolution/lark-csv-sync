# Lark CSV 同步工具 - 开发者配置与测试指南

这份文档是为接手和二次开发本项目的开发人员准备的。请按照以下步骤配置您的本地开发环境，并进行启动、测试与二次打包。

## 1. 环境准备 (Prerequisites)

本项目基于 Node.js 运行和打包，在开始之前，请确保您的电脑已安装以下环境：
- **Node.js**: 建议安装 `v18.x` 或更新的 LTS 版本（[前往 Node.js 官网下载](https://nodejs.org/)）。
- **npm**: 随 Node.js 一同安装的包管理工具。

验证安装是否成功，可以在终端 (Terminal / PowerShell) 中输入：
```bash
node -v
npm -v
```

## 2. 项目部署与依赖安装 (Installation)

1. 将收到的代码 ZIP 包解压到您的工作目录中。
2. 打开命令行工具（如 VS Code 的集成终端），**进入到刚解压的项目根目录**（与 `package.json` 同级的目录）：
   ```bash
   cd /您的路径/...
   ```
3. 在该目录下运行以下命令，以下载并安装项目所需的所有依赖包（这会重新生成 `node_modules` 文件夹）：
   ```bash
   npm install
   ```

## 3. 启动并测试项目 (Start & Test)

该项目采用前后端分离但同构运行的模式。后端由 Node.js (Express) 驱动，前端为原生 HTML/JS/CSS 编写。

### 启动本地开发服务器
在项目根目录运行：
```bash
npm start
```
*或者直接运行 `node src/gui-server.js`*

### 进行浏览器测试
服务启动后，终端会打印出本地访问地址。请打开任意现代浏览器（推荐 Chrome 或 Edge），访问以下地址即可预览和测试界面：
- **访问地址**: `http://127.0.0.1:3904`

> **开发修改提示**：
> - **前端修改**：修改 `public/index.html` 或 `public/app.js`。只需在浏览器中按 `F5` 刷新即可看到最新效果，无需重启 Node 服务器。
> - **后端修改**：修改 `src/` 目录下的 `.js` 文件（如 `sync-engine.js` 或 `gui-server.js`）。修改后必须在终端中按 `Ctrl+C` 停止当前服务，然后重新运行 `npm start` 才能使后端的代码生效。

## 4. 如何进行二次打包 (Build EXE)

如果您修改完代码并且测试通过，需要给客户提供一个一键运行的 `.exe` 独立可执行程序，本项目使用 `pkg` 工具进行底层打包制成绿色的 EXE 客户端。

在打包之前，请确保一切测试正常，然后在终端中运行以下命令：
```bash
npm run build
```

**打包产物：**
打包完成后，项目根目录下会自动生成一个 `dist` 文件夹，里面包含了可在 Windows 等系统上直接执行的 `.exe` 二进制文件包。只要把它发送给客户，客户无需安装 Node.js 即可直接无脑双击运行启动同步服务。

## 5. 核心目录结构说明

```text
├── package.json        # 项目描述及依赖配置文件
├── src/                # 后端及核心引擎源代码
│   ├── gui-server.js   # Express Web本地服务器
│   ├── sync-engine.js  # 数据同步核心业务处理引擎
│   ├── lark-api.js     # 调用 Lark (飞书) OpenAPI 的核心封装
│   ├── csv-stream.js   # CSV 文件的解析和读取逻辑
│   └── ...
├── public/             # 前端静默页面（用户界面）
│   ├── index.html      # 纯日文的前端页面
│   ├── app.js          # 前端交互逻辑、状态管理请求与文件上传
│   └── main.css        # 前端样式文件
└── README.md           # 面向普通使用者的使用说明
```

**遇到报错如何排查？**
- UI 或前端请求出错：按 F12 打开浏览器开发者工具检查 `Console` 控制台报错。
- 同步或后端请求出错：查看运行了 `npm start` 的终端命令行的实时日志打印输出，或检查生成的 `*_error_YYYYMMDD.csv` 下载文件内容。
