/**
 * 电源网络高亮助手 (Power Net Highlighter)
 *
 * 一键识别原理图中的电源网络并沿导线描线高亮：
 *  1. 结构检测：网络标识符（VCC/GND 等电源符号）所在网络
 *  2. 网络名规则：通配符匹配网络标签 / 网络端口 / 导线网络名
 *  3. 引脚规则：通配符匹配 位号.引脚号 / 位号.引脚名（如 U3.3、U*.LX），
 *     命中引脚所在的物理网络整组高亮（支持无名称网络）
 *  4. 电源贯通传播：电源网络跨 2 引脚电感/磁珠（位号字母前缀精确匹配 L、FB）
 *     或毫欧级电阻
 *     （R 前缀且阻值 < 阈值）后，对侧所在物理网络整组同为电源网络
 *  5. 短接标识符：短接符（short_symbol，双引脚）两引脚所连导线组直接并组
 *     （同一短接符 = 电气短路，视为同一网络），上述各通道均按并组后的连通性执行；
 *     被标记组内的网络名（含经短接符并入的信号名）按同名并组闭包传播，
 *     页面上其他位置的同名导线组（仅靠网络名连接）一并高亮
 *
 * 高亮机制：dmt_EditorControl.generateIndicatorMarkers 沿导线画标记线
 *（不随点击消失，颜色线宽可配置），可另选中网络。
 *
 * 打包格式：EasyEDA 加载器将入口文件作为普通脚本求值（不支持 ES Module），
 * 顶层函数声明对接 registerFn 调度，并挂载 edaEsbuildExportName 兼容官方 SDK 产物。
 *
 * 注：ESCH_PrimitiveComponentType 为字符串枚举，此处直接使用文档化的字面值；
 *     检测与高亮均作用于当前激活的原理图页面。
 */

const STORAGE_KEY = 'powerNetHighlighter.config';

/** ESCH_PrimitiveComponentType 枚举字面值 */
const COMP_TYPE = {
	PART: 'part',
	NET_FLAG: 'netflag',
	NET_LABEL: 'netlabel',
	NET_PORT: 'netport',
	SHORT_SYMBOL: 'short_symbol',
};

/** EDMT_EditorDocumentType.SCHEMATIC_PAGE = 1 */
const DOC_TYPE_SCHEMATIC_PAGE = 1;

const DEFAULT_COLOR = '#e63228';
const PIN_STUB_LEN = 7;

/** 内置规则（可禁用/改模式；引脚规则默认关闭仅作示例） */
const BUILTIN_RULES = [
	{ id: 'b-gnd', name: 'GND 系列', pattern: '*gnd*', target: 'net', enabled: true, builtin: true },
	{ id: 'b-earth', name: '大地 / 保护地', pattern: '*earth*', target: 'net', enabled: true, builtin: true },
	{ id: 'b-pe', name: '保护地 PE', pattern: 'pe', target: 'net', enabled: false, builtin: true },
	{ id: 'b-vcc', name: 'VCC 电源', pattern: 'vcc*', target: 'net', enabled: true, builtin: true },
	{ id: 'b-vdd', name: 'VDD 电源', pattern: '*vdd*', target: 'net', enabled: true, builtin: true },
	{ id: 'b-vee', name: 'VEE 负电源', pattern: '*vee*', target: 'net', enabled: true, builtin: true },
	{ id: 'b-rail', name: '电压轨 (+3V3/+5V/...)', pattern: '+*', target: 'net', enabled: true, builtin: true },
	{ id: 'b-rail-neg', name: '负电压轨 (-5V/...)', pattern: '-*', target: 'net', enabled: true, builtin: true },
	{ id: 'b-vbat', name: '电池 VBAT', pattern: '*vbat*', target: 'net', enabled: true, builtin: true },
	{ id: 'b-batt', name: '电池 BAT+/BATT', pattern: '*batt*', target: 'net', enabled: true, builtin: true },
	{ id: 'b-vbus', name: 'USB VBUS', pattern: 'vbus*', target: 'net', enabled: true, builtin: true },
	{ id: 'b-vsys', name: '系统电源 VSYS', pattern: 'vsys*', target: 'net', enabled: true, builtin: true },
	{ id: 'b-avdd', name: '模拟电源 AVDD/AVCC', pattern: 'a*v*d*', target: 'net', enabled: false, builtin: true },
	{ id: 'b-pin-lx', name: 'DCDC 开关节点 LX（引脚）', pattern: '*.lx', target: 'pin', enabled: true, builtin: true },
	{ id: 'b-pin-ph', name: 'DCDC 开关节点 PH（引脚）', pattern: '*.ph', target: 'pin', enabled: true, builtin: true },
	{ id: 'b-pin-sw', name: 'DCDC 开关节点 SW（引脚）', pattern: '*.sw', target: 'pin', enabled: false, builtin: true },
	{ id: 'b-pin-vout', name: '稳压输出 VOUT（引脚）', pattern: '*.vout*', target: 'pin', enabled: true, builtin: true },
];

const DEFAULT_OPTIONS = {
	detectNetFlags: true,
	matchNetLabels: true,
	matchNetPorts: true,
	matchWires: false,
	matchPins: true,
	caseInsensitive: true,
	propagatePassThrough: true,
	passThroughPrefixes: 'L,FB',
	shuntThreshold: 1,
	alsoSelect: false,
	highlightColor: DEFAULT_COLOR,
	lineWidth: 3,
};

function defaultConfig() {
	return {
		version: 2,
		rules: BUILTIN_RULES.map((r) => ({ ...r })),
		options: { ...DEFAULT_OPTIONS },
	};
}

/** 读取用户配置（与默认合并；v1 规则缺 target 字段自动补 'net'） */
function loadConfig() {
	try {
		const saved = eda.sys_Storage.getExtensionUserConfig(STORAGE_KEY);
		if (!saved || typeof saved !== 'object') return defaultConfig();
		const cfg = defaultConfig();
		if (Array.isArray(saved.rules)) {
			const savedBuiltins = new Map(saved.rules.filter((r) => r.builtin).map((r) => [r.id, r]));
			cfg.rules = cfg.rules.map((b) => {
				const s = savedBuiltins.get(b.id);
				return s ? { ...b, enabled: !!s.enabled, pattern: typeof s.pattern === 'string' && s.pattern ? s.pattern : b.pattern } : b;
			});
			for (const r of saved.rules) {
				if (!r.builtin && r.id && typeof r.pattern === 'string') {
					cfg.rules.push({
						id: r.id,
						name: r.name || r.pattern,
						pattern: r.pattern,
						target: r.target === 'pin' ? 'pin' : 'net',
						enabled: r.enabled !== false,
						builtin: false,
					});
				}
			}
		}
		if (saved.options && typeof saved.options === 'object') cfg.options = { ...DEFAULT_OPTIONS, ...saved.options };
		if (typeof cfg.options.highlightColor !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(cfg.options.highlightColor)) cfg.options.highlightColor = DEFAULT_COLOR;
		if (!(cfg.options.lineWidth >= 1 && cfg.options.lineWidth <= 10)) cfg.options.lineWidth = 3;
		if (typeof cfg.options.passThroughPrefixes !== 'string' || !cfg.options.passThroughPrefixes.trim()) cfg.options.passThroughPrefixes = 'L,FB';
		if (!(Number(cfg.options.shuntThreshold) >= 0 && Number(cfg.options.shuntThreshold) <= 100)) cfg.options.shuntThreshold = 1;
		else cfg.options.shuntThreshold = Number(cfg.options.shuntThreshold);
		return cfg;
	} catch (e) {
		return defaultConfig();
	}
}

/** 通配符模式编译为正则（* 任意串，? 单字符；非单词字符一律转义） */
function compilePattern(pattern, caseInsensitive) {
	let re = '^';
	for (const ch of String(pattern)) {
		if (ch === '*') re += '.*';
		else if (ch === '?') re += '.';
		else if (/[a-zA-Z0-9_]/.test(ch)) re += ch;
		else re += '\\' + ch;
	}
	return new RegExp(re + '$', caseInsensitive ? 'i' : '');
}

/** '#rrggbb' -> {r,g,b,alpha} */
function parseColor(hex) {
	const m = /^#?([0-9a-fA-F]{6})$/.test(hex) ? hex.slice(-6) : DEFAULT_COLOR.slice(-6);
	return { r: parseInt(m.slice(0, 2), 16), g: parseInt(m.slice(2, 4), 16), b: parseInt(m.slice(4, 6), 16), alpha: 255 };
}

/**
 * 解析阻值字符串为欧姆数，失败返回 null。
 * 支持：100mΩ / 5.1kΩ / 10k / 0.05R / R005 / 0R05 / 4R7 / 4k7 / 0.005 / 4M7 / 1meg；
 * m（毫）与 M（兆）按大小写区分；Ω/ohm 与 % 容差后缀会被剔除。
 */
function parseResistanceOhms(v) {
	if (v == null) return null;
	let s = String(v).replace(/[ΩΩΩ]/g, '').replace(/ohm/gi, '').replace(/±.*/, '').replace(/%.*/, '').trim();
	let m;
	if ((m = s.match(/^(\d*\.?\d+)\s*[rR]\s*(\d+\.?\d*)$/))) return parseFloat(m[1] + '.' + m[2]);            // 0R05 / 4R7
	if ((m = s.match(/^[rR]\s*(\d+\.?\d*)$/))) return parseFloat('0.' + m[1].replace('.', ''));               // R005 / R047
	if ((m = s.match(/^(\d*\.?\d+)\s*(?:[mM][eE][gG]|M)\s*(\d*\.?\d*)$/))) return (parseFloat(m[1]) + (m[2] ? parseFloat(m[2]) / 10 : 0)) * 1e6; // 4M7 / 1M / 1meg
	if ((m = s.match(/^(\d*\.?\d+)\s*[kK]\s*(\d*\.?\d*)$/))) return (parseFloat(m[1]) + (m[2] ? parseFloat(m[2]) / 10 : 0)) * 1000;              // 4k7 / 5.1k
	if ((m = s.match(/^(\d*\.?\d+)\s*m\s*(\d*\.?\d*)$/))) return (parseFloat(m[1]) + (m[2] ? parseFloat(m[2]) / 10 : 0)) * 0.001;                // 100m / 4m7
	if ((m = s.match(/^(\d*\.?\d+)\s*[rR]$/))) return parseFloat(m[1]);                                       // 10R / 0.05R
	if ((m = s.match(/^(\d*\.?\d+)\s*[kK]$/))) return parseFloat(m[1]) * 1000;                                // 10k
	if ((m = s.match(/^(\d*\.?\d+)\s*m$/))) return parseFloat(m[1]) * 0.001;                                  // 20m
	if ((m = s.match(/^(\d*\.?\d+)\s*M$/))) return parseFloat(m[1]) * 1e6;                                    // 10M
	if ((m = s.match(/^(\d*\.?\d+)$/))) return parseFloat(m[1]);                                              // 0.005 / 470
	return null;
}

/* ===================== 几何与连通性 ===================== */

const pkey = (x, y) => Math.round(x * 1000) / 1000 + ',' + Math.round(y * 1000) / 1000;

/**
 * 解析导线 line 数据。
 * 格式为线段端点对序列：[x1,y1,x2,y2, x3,y3,x4,y4, ...]（每 4 个数一段，并非连续折线）
 */
function parseWireSegments(line) {
	const pts = [];
	const segs = [];
	if (!Array.isArray(line) || line.length < 4) return { pts, segs };
	for (let i = 0; i + 3 < line.length; i += 4) {
		const x1 = line[i], y1 = line[i + 1], x2 = line[i + 2], y2 = line[i + 3];
		pts.push([x1, y1], [x2, y2]);
		if (x1 === x2 && y1 === y2) continue;
		segs.push([x1, y1, x2, y2]);
	}
	return { pts, segs };
}

const pointOnSeg = (px, py, s) => {
	const cross = (s[2] - s[0]) * (py - s[1]) - (s[3] - s[1]) * (px - s[0]);
	if (Math.abs(cross) > 0.001) return false;
	return Math.min(s[0], s[2]) - 0.001 <= px && px <= Math.max(s[0], s[2]) + 0.001 && Math.min(s[1], s[3]) - 0.001 <= py && py <= Math.max(s[1], s[3]) + 0.001;
};

/* ===================== 检测与高亮 ===================== */

/**
 * 识别当前页面电源网络并生成高亮标记
 * @returns {Promise<{markers: Array, netNames: string[], hits: Array<{name, sources, rules}>}>}
 */
async function detectPowerNets() {
	const cfg = loadConfig();
	const options = cfg.options;

	const netRules = cfg.rules.filter((r) => r.enabled && r.pattern && (r.target || 'net') === 'net');
	const pinRules = cfg.rules.filter((r) => r.enabled && r.pattern && r.target === 'pin');
	const netMatchers = netRules.map((r) => ({ name: r.name || r.pattern, re: compilePattern(r.pattern, options.caseInsensitive) }));
	const pinMatchers = pinRules.map((r) => ({ name: r.name || r.pattern, re: compilePattern(r.pattern, options.caseInsensitive) }));
	const matchNet = (net) => {
		for (const m of netMatchers) if (m.re.test(net)) return m.name;
		return null;
	};

	/* ---- 导线加载与连通性分组 ---- */
	const wires = (await eda.sch_PrimitiveWire.getAll()) || [];
	const wireData = wires.map((w) => {
		const { pts, segs } = parseWireSegments(w.getState_Line());
		return { net: w.getState_Net() || '', pts, segs };
	}).filter((wd) => wd.pts.length > 0);

	const parent = wireData.map((_, i) => i);
	const find = (i) => {
		while (parent[i] !== i) {
			parent[i] = parent[parent[i]];
			i = parent[i];
		}
		return i;
	};
	const union = (a, b) => {
		parent[find(a)] = find(b);
	};

	const endpointMap = new Map();
	wireData.forEach((wd, i) => {
		for (const p of wd.pts) {
			const k = pkey(p[0], p[1]);
			if (!endpointMap.has(k)) endpointMap.set(k, []);
			endpointMap.get(k).push(i);
		}
	});
	for (const idxs of endpointMap.values()) for (let i = 1; i < idxs.length; i++) union(idxs[0], idxs[i]);
	for (const [k, idxs] of endpointMap) {
		const [px, py] = k.split(',').map(Number);
		const root = idxs[0];
		for (let j = 0; j < wireData.length; j++) {
			if (find(j) === find(root)) continue;
			if (wireData[j].segs.some((s) => pointOnSeg(px, py, s))) union(root, j);
		}
	}

	/* ---- 短接标识符：同一短接符两引脚所连导线并组（电气短路视为同一网络） ---- */
	const shortLinks = [];
	const shortByPoint = new Map();
	{
		const shorts = (await eda.sch_PrimitiveComponent.getAll(COMP_TYPE.SHORT_SYMBOL, false)) || [];
		for (const s of shorts) {
			const pins = (await s.getAllPins()) || [];
			if (pins.length < 2) continue;
			shortLinks.push(pins);
			shortByPoint.set(pkey(pins[0].x, pins[0].y), pins[1]);
			shortByPoint.set(pkey(pins[1].x, pins[1].y), pins[0]);
		}
	}
	/** 坐标 -> 命中导线下标（端点优先，其次线段穿越），未命中返回 -1 */
	const wireIndexAt = (x, y) => {
		const k = pkey(x, y);
		return endpointMap.has(k) ? endpointMap.get(k)[0] : wireData.findIndex((wd) => wd.segs.some((s) => pointOnSeg(x, y, s)));
	};
	for (const pins of shortLinks) {
		const ia = wireIndexAt(pins[0].x, pins[0].y);
		const ib = wireIndexAt(pins[1].x, pins[1].y);
		if (ia >= 0 && ib >= 0) union(ia, ib);
	}
	/** 坐标 -> 所在导线连通组根（未连导线返回 null）；坐标落在短接符引脚上时沿短接链跳对侧（限深防环） */
	const pointGroup = (x, y, depth = 0) => {
		const wi = wireIndexAt(x, y);
		if (wi >= 0) return find(wi);
		if (depth < 4) {
			const other = shortByPoint.get(pkey(x, y));
			if (other) return pointGroup(other.x, other.y, depth + 1);
		}
		return null;
	};

	const groups = new Map();
	wireData.forEach((wd, i) => {
		const r = find(i);
		if (!groups.has(r)) groups.set(r, { name: '', wires: [] });
		const g = groups.get(r);
		if (wd.net) g.name = g.name || wd.net;
		g.wires.push(i);
	});

	/* ---- 命中记录 ---- */
	const hits = new Map();
	const addHit = (name, source, rule) => {
		if (!name) return;
		if (!hits.has(name)) hits.set(name, { name, sources: [], rules: [] });
		const h = hits.get(name);
		if (source && !h.sources.includes(source)) h.sources.push(source);
		if (rule && !h.rules.includes(rule)) h.rules.push(rule);
	};

	/* ---- 通道一：网络标识符结构检测 ---- */
	if (options.detectNetFlags) {
		const flags = (await eda.sch_PrimitiveComponent.getAll(COMP_TYPE.NET_FLAG, false)) || [];
		for (const f of flags) addHit(f.getState_Net(), '网络标识', null);
	}

	/* ---- 通道二：规则匹配网络标签 / 网络端口 ---- */
	const scanComponents = async (type, enabled, sourceLabel) => {
		if (!enabled) return;
		const prims = (await eda.sch_PrimitiveComponent.getAll(type, false)) || [];
		for (const p of prims) {
			const net = p.getState_Net();
			if (!net) continue;
			const rule = matchNet(net);
			if (rule) addHit(net, sourceLabel, rule);
		}
	};
	await scanComponents(COMP_TYPE.NET_LABEL, options.matchNetLabels, '网络标签');
	await scanComponents(COMP_TYPE.NET_PORT, options.matchNetPorts, '网络端口');

	/* ---- 通道三：规则匹配导线网络名（复用已加载的 wireData） ---- */
	if (options.matchWires) {
		for (const wd of wireData) {
			if (!wd.net) continue;
			const rule = matchNet(wd.net);
			if (rule) addHit(wd.net, '导线', rule);
		}
	}

	/* ---- 标记命中名称对应的导线分组（组内任一导线网络名命中即整组标记，覆盖并组后多名称共存） ---- */
	const nameSet = new Set([...hits.keys()]);
	const marked = new Set();
	for (const g of groups.values()) {
		if (g.wires.some((i) => wireData[i].net && nameSet.has(wireData[i].net))) for (const i of g.wires) marked.add(i);
	}

	/* ---- 电源标识符连通性标记：标识符所连导线整组描线（导线可无网络名；经短接符相连时跳到对侧组） ---- */
	if (options.detectNetFlags) {
		const flags = (await eda.sch_PrimitiveComponent.getAll(COMP_TYPE.NET_FLAG, false)) || [];
		for (const f of flags) {
			const net = f.getState_Net();
			if (!net || !nameSet.has(net)) continue;
			const root = pointGroup(f.getState_X(), f.getState_Y());
			if (root != null) for (const i of groups.get(root).wires) marked.add(i);
		}
	}

	/* ---- 元件与引脚准备（引脚规则 + 贯通传播共用） ---- */
	const passPrefixes = String(options.passThroughPrefixes || '').split(/[\s,;，、]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
	const shuntThreshold = Number(options.shuntThreshold) || 0;
	const wantPinRules = !!options.matchPins && pinMatchers.length > 0;
	const wantPropagation = !!options.propagatePassThrough && (passPrefixes.length > 0 || shuntThreshold > 0);
	const parts = wantPinRules || wantPropagation ? ((await eda.sch_PrimitiveComponent.getAll(COMP_TYPE.PART, false)) || []) : [];
	const pinCache = new Map();
	const getPins = async (idx) => {
		if (!pinCache.has(idx)) {
			let pins = [];
			try {
				pins = (await parts[idx].getAllPins()) || [];
			} catch (e) {
				pins = [];
			}
			pinCache.set(idx, pins);
		}
		return pinCache.get(idx);
	};
	/** 引脚坐标 -> 所在导线连通组根（pointGroup：经短接符相连时跳到对侧组，未连导线返回 null） */
	const pinGroup = (x, y) => pointGroup(x, y);

	/* ---- 通道四：引脚规则（支持无名称网络，按连通性整组标记） ---- */
	const pinStubCandidates = [];
	if (wantPinRules) {
		for (let pi = 0; pi < parts.length; pi++) {
			const part = parts[pi];
			const des = part.getState_Designator() || '';
			const pins = await getPins(pi);
			for (const p of pins) {
				const forms = [des + '.' + (p.pinNumber || ''), des + '.' + (p.pinName || '')];
				let ruleHit = null;
				for (const m of pinMatchers) {
					if (forms.some((f) => m.re.test(f))) {
						ruleHit = m.name;
						break;
					}
				}
				if (!ruleHit) continue;
				const label = des + '.' + (p.pinNumber || '?') + (p.pinName && p.pinName !== p.pinNumber ? '(' + p.pinName + ')' : '');
				pinStubCandidates.push({ x: p.x, y: p.y, rotation: p.rotation || 0, label });
				const root = pinGroup(p.x, p.y);
				if (root != null) {
					const g = groups.get(root);
					for (const i of g.wires) marked.add(i);
					addHit(g.name || label, '引脚规则', g.name ? null : ruleHit);
				} else {
					addHit(label, '引脚规则', ruleHit);
				}
			}
		}
	}

	/** 贯通传播一轮（内部迭代至本轮不动点），返回本轮是否有新增标记；wantPropagation 时由通道五段赋值 */
	let propagateAll = null;

	/* ---- 通道五：电源贯通传播（电感/磁珠/毫欧电阻两端网络同为电源） ---- */
	if (wantPropagation) {
		const passComps = [];
		for (let pi = 0; pi < parts.length; pi++) {
			const des = parts[pi].getState_Designator() || '';
			/* 位号字母前缀精确匹配：L1/L2 命中 L，LED1/LS1 不命中（防 LED 等误判为电感） */
			const am = /^([A-Za-z]+)/.exec(des);
			const alpha = am ? am[1].toUpperCase() : '';
			let isPass = passPrefixes.includes(alpha);
			if (!isPass && shuntThreshold > 0 && alpha === 'R') {
				let ohms = null;
				try {
					const attrs = (await eda.sch_PrimitiveAttribute.getAll(parts[pi].getState_PrimitiveId())) || [];
					for (const key of ['Value', 'Resistance']) {
						const a = attrs.find((x) => x.getState_Key() === key);
						if (a) {
							ohms = parseResistanceOhms(a.getState_Value());
							if (ohms != null) break;
						}
					}
				} catch (e) {
					ohms = null;
				}
				isPass = ohms != null && ohms >= 0 && ohms < shuntThreshold;
			}
			if (!isPass) continue;
			const pins = await getPins(pi);
			if (pins.length !== 2) continue;
			const ga = pinGroup(pins[0].x, pins[0].y);
			const gb = pinGroup(pins[1].x, pins[1].y);
			if (ga == null || gb == null || ga === gb) continue;
			passComps.push({ des, ga, gb });
		}
		const groupMarked = (root) => groups.get(root).wires.some((i) => marked.has(i));
		const markGroup = (root, des) => {
			const g = groups.get(root);
			for (const i of g.wires) marked.add(i);
			if (g.name) {
				nameSet.add(g.name);
				addHit(g.name, '贯通传播·' + des, null);
			} else {
				addHit(des + '(贯通)', '贯通传播', null);
			}
		};
		/** 贯通传播一轮（内部迭代至本轮不动点），返回本轮是否有新增标记 */
		propagateAll = () => {
			let any = false;
			let changed = true;
			while (changed) {
				changed = false;
				for (const c of passComps) {
					const aM = groupMarked(c.ga);
					const bM = groupMarked(c.gb);
					if (aM === bM) continue;
					changed = true;
					any = true;
					if (aM) markGroup(c.gb, c.des);
					else markGroup(c.ga, c.des);
				}
			}
			return any;
		};
	}

	/* ---- 同名网络并组闭包（一轮）：被标记组内出现的网络名全部视为电源网络名，页面上其他位置的同名导线组（仅靠网络名连接、无几何连通）一并标记 ---- */
	const sameNamePass = () => {
		let changed = false;
		for (const g of groups.values()) {
			if (!g.wires.some((i) => marked.has(i))) continue;
			for (const i of g.wires) {
				const n = wireData[i].net;
				if (n && !nameSet.has(n)) {
					nameSet.add(n);
					addHit(n, '同名并组', null);
					changed = true;
				}
			}
		}
		for (const g of groups.values()) {
			if (g.wires.some((i) => wireData[i].net && nameSet.has(wireData[i].net))) {
				for (const i of g.wires) {
					if (!marked.has(i)) {
						marked.add(i);
						changed = true;
					}
				}
			}
		}
		return changed;
	};

	/* ---- 贯通传播与同名并组交替执行至全局不动点：闭包新标记的组可能再触发传播（如 IN+ 经同名闭包标记后，其对侧 10mΩ 电阻才传播 IN-），传播并入的信号名也可能再扩散，交替直到双方均无新增 ---- */
	let outer = true;
	while (outer) {
		outer = false;
		if (propagateAll && propagateAll()) outer = true;
		while (sameNamePass()) outer = true;
	}

	/* ---- 生成标记：导线描线 ---- */
	const markers = [];
	const onMarkedWire = (x, y) => wireData.some((wd, i) => marked.has(i) && wd.segs.some((s) => pointOnSeg(x, y, s)));
	wireData.forEach((wd, i) => {
		if (!marked.has(i)) return;
		for (const s of wd.segs) {
			markers.push({ type: 'line', startX: s[0], startY: s[1], endX: s[2], endY: s[3] });
		}
	});

	/* ---- 无走线覆盖的电源符号：沿符号方向短标识 ---- */
	const flags = (await eda.sch_PrimitiveComponent.getAll(COMP_TYPE.NET_FLAG, false)) || [];
	for (const f of flags) {
		const net = f.getState_Net();
		if (!net || !nameSet.has(net)) continue;
		const ox = f.getState_X(), oy = f.getState_Y();
		if (onMarkedWire(ox, oy)) continue;
		let dx = 0, dy = -1;
		try {
			const attrs = (await eda.sch_PrimitiveAttribute.getAll(f.getState_PrimitiveId())) || [];
			const nameAttr = attrs.find((a) => a.getState_Key() === 'Global Net Name' && a.getState_Value() === net && a.getState_X() != null);
			if (nameAttr) {
				const vx = nameAttr.getState_X() - ox, vy = nameAttr.getState_Y() - oy;
				const len = Math.sqrt(vx * vx + vy * vy);
				if (len > 5) {
					dx = -vx / len;
					dy = -vy / len;
				}
			}
		} catch (e) {
			/* 属性不可用时按向上短标识 */
		}
		markers.push({ type: 'line', startX: ox, startY: oy, endX: ox + dx * PIN_STUB_LEN, endY: oy + dy * PIN_STUB_LEN });
	}

	/* ---- 无走线覆盖的规则命中引脚：沿引脚方向短标识 ---- */
	for (const c of pinStubCandidates) {
		if (onMarkedWire(c.x, c.y)) continue;
		const dir = { 0: [1, 0], 90: [0, 1], 180: [-1, 0], 270: [0, -1] }[c.rotation] || [1, 0];
		markers.push({ type: 'line', startX: c.x, startY: c.y, endX: c.x + dir[0] * PIN_STUB_LEN, endY: c.y + dir[1] * PIN_STUB_LEN });
	}

	const hitList = [...hits.values()].sort((a, b) => a.name.localeCompare(b.name));
	const netNames = [...nameSet].filter((n) => n && !n.includes('('));
	return { markers, netNames, hitList, options };
}

/** 确保当前活动文档为原理图页面 */
async function ensureSchematicActive() {
	const doc = await eda.dmt_SelectControl.getCurrentDocumentInfo();
	if (!doc || doc.documentType !== DOC_TYPE_SCHEMATIC_PAGE) {
		eda.sys_Message.showToastMessage('请先打开一个原理图页面再执行此操作', 'warn');
		return false;
	}
	return true;
}

async function detectAndHighlight() {
	try {
		if (!(await ensureSchematicActive())) return;
		eda.sys_Message.showToastMessage('正在识别电源网络...', 'info');

		const { markers, netNames, hitList, options } = await detectPowerNets();
		if (hitList.length === 0) {
			eda.sys_Message.showToastMessage('未识别到电源网络，可在「规则配置」中调整规则', 'warn');
			return;
		}

		await eda.dmt_EditorControl.removeIndicatorMarkers();
		let ok = true;
		if (markers.length > 0) {
			ok = await eda.dmt_EditorControl.generateIndicatorMarkers(markers, parseColor(options.highlightColor), options.lineWidth, false, undefined);
		}
		if (!ok) {
			eda.sys_Message.showToastMessage('高亮失败，请重试', 'error');
			return;
		}
		if (options.alsoSelect) eda.sch_SelectControl.doCrossProbeSelect([], [], netNames, false, true);

		const names = hitList.map((h) => h.name);
		const brief = names.length > 6 ? names.slice(0, 6).join('、') + ` 等 ${names.length} 个` : names.join('、');
		eda.sys_Message.showToastMessage(`已高亮 ${hitList.length} 个电源网络：${brief}`, 'success');
	} catch (e) {
		eda.sys_Message.showToastMessage(`执行出错: ${e && e.message ? e.message : String(e)}`, 'error');
	}
}

async function clearHighlight() {
	try {
		await eda.dmt_EditorControl.removeIndicatorMarkers();
		eda.sch_SelectControl.clearSelected();
		eda.sch_SelectControl.doCrossProbeSelect([], [], [], false, false);
		eda.sys_Message.showToastMessage('已清除高亮', 'success');
	} catch (e) {
		eda.sys_Message.showToastMessage(`执行出错: ${e && e.message ? e.message : String(e)}`, 'error');
	}
}

async function openConfig() {
	try {
		await eda.sys_IFrame.openIFrame('/iframe/index.html', 560, 700, 'pnh-config', {
			title: '电源网络高亮助手 - 规则配置',
			minimizeButton: true,
			maximizeButton: false,
		});
	} catch (e) {
		eda.sys_Message.showToastMessage(`打开配置面板失败: ${e && e.message ? e.message : String(e)}`, 'error');
	}
}

/* 官方 SDK esbuild 产物以 iife + globalName 暴露导出，此处等价挂载以保持兼容 */
var edaEsbuildExportName = { detectAndHighlight: detectAndHighlight, clearHighlight: clearHighlight, openConfig: openConfig };
