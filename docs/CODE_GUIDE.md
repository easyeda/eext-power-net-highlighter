# 代码阅读指南（CODE GUIDE）

面向开发者／维护者的源码导读。用户侧使用说明见 [../README.md](../README.md)，版本历史见 [../CHANGELOG.md](../CHANGELOG.md)。

---

## 1. 项目概览

**电源网络高亮助手（Power Net Highlighter）** 是一个 EasyEDA Pro（嘉立创EDA专业版，≥ 3.2.0）扩展：

- 在原理图页面增加 **「⚡ 电源网络」** 菜单；
- 通过「结构检测 + 通配符规则」双通道识别电源网络；
- 用**编辑器指示器标记**沿导线描线高亮（不修改源数据、不随画布点击消失）；
- 提供 iframe 配置面板管理规则与样式，配置持久化保存。

整个扩展**没有构建步骤**：`dist/index.js` 与 `iframe/index.html` 既是源码也是发布产物，`package.ps1` 直接将它们连同清单打进 `.eext`（zip）包。

## 2. 目录结构

```
power-net-highlighter/
├── extension.json        # 扩展清单：元数据、入口、headerMenus 菜单注册
├── dist/
│   └── index.js          # 扩展宿主侧入口（唯一源码文件，无构建，直接发布）
├── iframe/
│   └── index.html        # 「规则配置」面板：自包含 HTML（CSS + 内嵌 JS）
├── images/
│   └── logo.png          # 扩展图标
├── docs/
│   └── CODE_GUIDE.md     # 本文档
├── debug/                # 开发期调试产物（bridge 验证载荷 + 诊断结果，gitignore）
├── release/              # 打包输出 *.eext（package.ps1 生成，gitignore）
├── package.ps1           # 打包脚本：zip 6 个文件 → release/*.eext
├── README.md             # 用户文档
├── CHANGELOG.md          # 版本日志
├── LICENSE               # Apache-2.0
└── .gitignore
```

## 3. EasyEDA 扩展运行机制

理解本项目的三个关键前提（均源自 EasyEDA 加载器的实际行为，见 `dist/index.js` 文件头注释）：

1. **入口按普通脚本求值，不支持 ES Module。**
   因此 `dist/index.js` 不使用 `export`，而是用**顶层函数声明**（`function detectAndHighlight() {...}`）对接 `extension.json` 里 `registerFn` 按名调度。
2. **兼容官方 SDK 产物格式。**
   官方 esbuild 产物以 iife + globalName 暴露导出，故文件末尾挂载等价全局变量 `edaEsbuildExportName`（[dist/index.js:426](../dist/index.js#L426)）。
3. **iframe 内可直接访问同一个 `eda` API。**
   配置面板虽是独立 HTML，但其中脚本能调用与宿主相同的 `eda.*` 命名空间（含存储、检测、高亮），无需消息中转。

### 清单关键字段（extension.json）

| 字段 | 作用 |
|---|---|
| `entry: ./dist/index` | 加载器求值 `dist/index.js` |
| `engines.eda: ^3.2.0` | 最低 EasyEDA Pro 版本 |
| `headerMenus.sch` | 原理图环境顶部菜单，3 个菜单项分别 `registerFn` 到 `detectAndHighlight` / `clearHighlight` / `openConfig` |
| `images.logo` | 扩展市场图标 |

## 4. 宿主侧入口：dist/index.js（约 430 行）

三个入口函数全部是 async、全部自行 try/catch 并以 toast 反馈：

| 函数 | 位置 | 行为 |
|---|---|---|
| `detectAndHighlight()` | [dist/index.js:372](../dist/index.js#L372) | 校验当前文档 → toast → `detectPowerNets()` → 清旧标记 → 生成新标记 → 可选联动选中 → 汇总 toast |
| `clearHighlight()` | [dist/index.js:402](../dist/index.js#L402) | `removeIndicatorMarkers()` + 清除选中/交叉探测选中 |
| `openConfig()` | [dist/index.js:413](../dist/index.js#L413) | `sys_IFrame.openIFrame('/iframe/index.html', 560, 700, 'pnh-config', {...})` 打开配置面板 |

辅助：

- `ensureSchematicActive()`（[dist/index.js:363](../dist/index.js#L363)）——`getCurrentDocumentInfo()` 校验 `documentType === 1`（`EDMT_EditorDocumentType.SCHEMATIC_PAGE`），否则 toast 拒绝执行。
- `parseColor()`（[dist/index.js:123](../dist/index.js#L123)）——`#rrggbb` → `{r,g,b,alpha}`，供标记 API 使用。

### 涉及的 eda API 一览

| API | 用途 |
|---|---|
| `eda.dmt_SelectControl.getCurrentDocumentInfo()` | 确认活动文档是原理图页面 |
| `eda.sch_PrimitiveWire.getAll()` | 取页面全部导线（含 `getState_Line()` 几何与 `getState_Net()` 网络名） |
| `eda.sch_PrimitiveComponent.getAll(type, false)` | 按 `COMP_TYPE` 取元件(`part`)/网络标识符(`netflag`)/网络标签(`netlabel`)/网络端口(`netport`) |
| `part.getAllPins()` | 取元件引脚（`pinNumber` / `pinName` / `x,y` / `rotation`） |
| `eda.sch_PrimitiveAttribute.getAll(primitiveId)` | 取图元属性（用于判断电源符号朝向） |
| `eda.dmt_EditorControl.generateIndicatorMarkers(markers, color, lineWidth, false, undefined)` | 核心：批量生成指示器标记线 |
| `eda.dmt_EditorControl.removeIndicatorMarkers()` | 清除全部标记 |
| `eda.sch_SelectControl.doCrossProbeSelect([], [], netNames, false, true)` | 「同时选中」联动 |
| `eda.sys_Storage.get/setExtensionUserConfig(key)` | 配置持久化 |
| `eda.sys_Message.showToastMessage(msg, level)` | 全部用户反馈 |
| `eda.sys_IFrame.openIFrame / closeIFrame` | 配置面板开关 |
| `eda.sys_Dialog.showConfirmationMessage` | 恢复默认确认框（iframe 内） |

## 5. 核心算法：detectPowerNets()（[dist/index.js:161](../dist/index.js#L161)）

单次 `await` 级联完成「加载 → 分组 → 检测 → 标记」，返回 `{ markers, netNames, hitList, options }`。建议按以下六段阅读：

### 5.1 规则编译（L165-172）

启用的规则按 `target` 分成 `netMatchers` / `pinMatchers`，每条经 `compilePattern()`（[dist/index.js:111](../dist/index.js#L111)）编译为**锚定正则**：`*`→`.*`、`?`→`.`，非 `[a-zA-Z0-9_]` 字符一律转义（`+3V3`、`-5V` 等模式安全）。`caseInsensitive` 映射 `i` 标志。

### 5.2 导线加载与解析（L175-179）

`getState_Line()` 返回**线段端点对序列** `[x1,y1,x2,y2, x3,y3,x4,y4, ...]`——每 4 个数一段，**不是连续折线**。`parseWireSegments()`（[dist/index.js:136](../dist/index.js#L136)）拆出端点集 `pts` 与零长段过滤后的 `segs`。

### 5.3 并查集连通性分组（L181-217）——算法核心

把"同一物理网络"还原出来，供按连通性整组高亮：

1. 每根导线初始自成一族（`parent` 数组 + 路径压缩 `find`）；
2. **端点重合合并**：端点坐标经 `pkey()`（[dist/index.js:130](../dist/index.js#L130)，四舍五入到 0.001 精度）归一为 key，相同 key 的导线 `union`；
3. **T 型交叉合并**：对每个端点 key，用 `pointOnSeg()`（[dist/index.js:149](../dist/index.js#L149)，叉积共线 + 包围盒，容差 0.001）检查它是否落在**其他族**导线段中部，命中则 `union`——这就是"导线中间接了分支"的场景；
4. 汇总为 `groups: Map<root, { name, wires[] }>`，组名取族内第一根有网络名的导线（可为空串）。

### 5.4 四个检测通道（L220-313）→ 命中表 `hits`

`hits: Map<netName, { name, sources[], rules[] }>` 由 `addHit()` 去重累积，`sources` 记录来源（网络标识/网络标签/网络端口/导线/引脚规则），`rules` 记录命中的规则名。

| 通道 | 开关 | 逻辑 | 特点 |
|---|---|---|---|
| ① 网络标识符结构检测 | `detectNetFlags` | 所有 `netflag`（VCC/GND 符号）的网络名**无条件**记为命中 | 不依赖规则，最可靠 |
| ② 网络标签 / 网络端口 | `matchNetLabels` / `matchNetPorts` | 对象网络名过 `netMatchers` 规则 | 依赖命名规范 |
| ③ 导线网络名 | `matchWires` | 已加载的 `wireData.net` 过规则 | 默认关闭（标签已覆盖） |
| ④ 引脚规则 | `matchPins` | 遍历 `part.getAllPins()`，`位号.引脚号` 与 `位号.引脚名` 两种形式分别过 `pinMatchers` | **支持无名称网络**：命中引脚按坐标挂到所属连通组，整组标记；组名缺失时以 `位号.引脚号(引脚名)` 作展示名 |

通道①还有第二步（L266-276）：对每个命中网络标识符，把**它所在位置连通**的整组导线也加入 `marked`——即使那些导线没有网络名。引脚通道同理（L303-307）。

### 5.5 标记生成（L259-263 + L316-323）

- 按名标记：`groups` 中组名命中 `nameSet` 的导线下标进入 `marked` 集合；
- 每个 `marked` 导线的每个线段生���一条 marker：`{ type:'line', startX, startY, endX, endY }`。

### 5.6 短标识线 stub（L326-355）

未被任何标记线覆盖的电源符号 / 命中引脚，从其坐标沿朝向画一条长 `PIN_STUB_LEN = 7` 的短线，避免"符号在但没走线"被遗漏：

- 电源符号朝向：取其 `Global Net Name` 属性坐标相对符号原点的**反方向**（名字在符号下方 → 朝上画）；
- 引脚朝向：按 `rotation` 查方向表 `{0:[1,0], 90:[0,1], 180:[-1,0], 270:[0,-1]}`。

覆盖判断 `onMarkedWire(x,y)` 用"点是否落在某条已标记线段上"，而非端点匹配（1.1.2 优化项，减少漏标）。

### 返回值

- `netNames`：纯网络名（过滤掉含 `(` 的引脚展示名），供 `doCrossProbeSelect` 联动选中；
- `hitList`：按名排序的命中清单，供 toast 摘要与配置面板结果区渲染。

## 6. 配置系统

### 存储

- Key：`powerNetHighlighter.config`（`STORAGE_KEY`）；
- 读：`getExtensionUserConfig`（**同步**，出错/无存档回落默认）；写：`setExtensionUserConfig`（async，仅配置面板「保存配置」时触发）。

### 结构（v2）

```jsonc
{
  "version": 2,
  "rules": [
    { "id": "b-gnd", "name": "GND 系列", "pattern": "*gnd*",
      "target": "net" /* 或 "pin" */, "enabled": true, "builtin": true }
    // ...16 条内置 + 任意自定义（id 形如 "u-xxxx"）
  ],
  "options": {
    "detectNetFlags": true, "matchNetLabels": true, "matchNetPorts": true,
    "matchWires": false, "matchPins": true, "caseInsensitive": true,
    "alsoSelect": false, "highlightColor": "#e63228", "lineWidth": 3
  }
}
```

### 读取合并策略（loadConfig，[dist/index.js:77](../dist/index.js#L77)）

默认配置为基底：内置规则按 `id` 与存档合并（仅取 `enabled` / `pattern`，新增内置规则对老用户自动生效）；自定义规则追加；`options` 整体浅合并后对 `highlightColor`（`#rrggbb`）与 `lineWidth`（1-10）做兜底校验。v1 存档缺 `target` 字段自动按 `net` 处理——这是无感迁移的关键。

## 7. ⚠️ 双份核心代码，必须同步修改

**iframe 无法 import 宿主文件**，因此 [iframe/index.html](../iframe/index.html) 的 `<script>` 内嵌了一份检测核心的 **ES5 手写版**（L141-443：常量、`BUILTIN_RULES`、`DEFAULT_OPTIONS`、`loadConfig`、`compilePattern`、`parseColor`、`pkey`、`parseWireSegments`、`pointOnSeg`、`detectPowerNets`），供面板内「检测并高亮」实时预览，**语义与 dist/index.js 严格一致**。

> **改任何检测/规则/默认值逻辑，必须同时改 `dist/index.js` 与 `iframe/index.html` 两处，并保持行为一致。** 这是本项目最大的维护陷阱。

iframe 的界面逻辑（L445-656）：`renderOptions/collectOptions`（选项 ↔ DOM）、`renderRules`（规则表格：内置规则只能禁用、自定义可删除）、`runDetect`（面板版高亮流程，结果渲染进 `#result`）、`saveConfig`、`addRule`、恢复默认确认框。

## 8. 打包与发布

`package.ps1`（PowerShell，无外部依赖）：

1. 读 `extension.json` 的 `version`；
2. 用 .NET `ZipFile` 把 **6 个文件**以**扁平、正斜杠**条目名（与官方包一致）写入 zip：`extension.json`、`dist/index.js`、`iframe/index.html`、`images/logo.png`、`README.md`、`CHANGELOG.md`；
3. 输出 `release/power-net-highlighter-<version>.eext`。

发布流程：改 `extension.json` 的 `version` + 补 `CHANGELOG.md` → 运行 `powershell -ExecutionPolicy Bypass -File package.ps1` → 在 EasyEDA 中安装 `release/*.eext` 验证。

## 9. 开发与调试

- **无 npm/构建链**：直接改源码，重打包即可生效。
- **活体调试模式**（debug/ 目录留存的历史方法）：本项目开发时通过 WebSocket bridge 在运行中的 EasyEDA 内执行代码逐步验证——`debug/verify-*.js` 是 Node 脚本，把 `dist/index.js` base64 内嵌生成载荷 `verify-*.json`（`{ code }`）；`verify-p1..p30` 是 1.1.x 功能的 30 步增量验证，`verify-v111` / `verify-stub-diag` 是版本回归与诊断。**这些是一次性产物，仅作参考，不参与构建**，可随时清空。
- 手工调试也可用 EasyEDA 扩展开发控制台直接粘贴表达式，按第 4 节 API 表探索。

## 10. 常见修改指南

| 需求 | 改哪里 |
|---|---|
| 新增/调整内置规则 | `BUILTIN_RULES` **两处**：[dist/index.js:37](../dist/index.js#L37) + [iframe/index.html:150](../iframe/index.html#L150)（同步 README 规则表） |
| 改默认颜色/线宽 | `DEFAULT_COLOR` / `DEFAULT_OPTIONS` **两处** |
| 改菜单项 | `extension.json` 的 `headerMenus.sch`（`registerFn` 对应 `dist/index.js` 顶层函数名） |
| 改面板尺寸/标题 | `openConfig()` 的 `openIFrame` 参数（[dist/index.js:415](../dist/index.js#L415)） |
| 调整连通性判定精度 | `pkey()` 的 1000 倍率与 `pointOnSeg()` 的 0.001 容差（两处） |
| 加新检测通道 | 在 `detectPowerNets()` L220-313 区间加通道 + `DEFAULT_OPTIONS` 加开关 + iframe 面板加复选框（同步 iframe 检测副本） |
| 升级配置结构 | `defaultConfig().version` + `loadConfig()` 迁移逻辑（两处） |
