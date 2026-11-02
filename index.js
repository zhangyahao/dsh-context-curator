/**
 * dsh-context-curator —— Host 侧。
 *
 * 一句话：把每个 agent 的「系统提示词段」和「技能目录」折叠成一行索引，
 * 原文留在本插件的内存里，模型需要时用 `context_load` 按名字取回。
 *
 * 为什么这么做（实测过的三条事实）：
 *   1. `system-prompt/assemble` 是 **waterfall**，能拿到装配好的完整 assembly
 *      （sections 数组，每项 { name, order, text }），返回什么模型就看到什么。
 *      所以「折叠」只是把 sections[i].text 换成一行的字符串，不碰别人的配置。
 *   2. 该事件必须 `{ global: true, prepend: true }` 注册才覆盖所有 agent；
 *      prepend 让我们在最外圈，`await next()` 之后拿到的已经是最终装配结果。
 *   3. 下游任何一个 waterfall 环节抛错都会弄死整条 assemble（会话发不出请求），
 *      因此这里所有回调都必须 try/catch 兜底，失败就原样返回。
 *
 * 技能目录由 `@deepseek-ai/dsh-tool-skill` 在 `agent/pre-step` 里以
 * `source.kind === 'skill-catalog'` 的消息注入，同样在 waterfall 里改写。
 * 只改写展示文本，保留 source.entries —— 那边的去重/重发依赖 entries 的摘要。
 *
 * 关闭状态（enabled=false）下本插件完全透明：只记录账单，不改任何文本。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export const name = 'context-curator';
export const inject = ['tools'];

/** 折叠行前缀：模型看到它以判断「这段是被折叠的索引」。 */
const MARK = '⟨ctx⟩';
/** 折叠行里最多保留多少字符的主题摘要。 */
const BRIEF_MAX = 96;
/** 折叠行整体软上限，超过就再压摘要。 */
const LINE_MAX = 200;

const DEFAULTS = {
  /** 关掉时只记账，不改文本——先看清代价再开。 */
  enabled: false,
  /** 超过这个字符数的段才值得折叠。 */
  minChars: 700,
  /** 永不折叠的段名（精确匹配）。 */
  protect: [
    'context-curator',
    'tools',
    'environment',
    'working-directory',
    'runtime',
    'sandbox',
  ],
  /** 把技能目录的每条描述压成一句。 */
  foldSkillsCatalog: true,
  /** 技能描述压缩后保留的上限。 */
  skillDescriptionMaxChars: 110,
  /** 装/更新插件后新冒出来的段，即使不到 minChars 也折叠（默认关，怕误伤状态类短段）。 */
  foldNewSections: false,
};

const stats = {
  assemblies: 0,
  sectionsSeen: 0,
  foldedNow: 0,
  savedNow: 0,
  savedTotal: 0,
  catalogs: 0,
  catalogSavedNow: 0,
  lastAt: 0,
  errors: [],
};

/** agentId::sectionName -> { agentId, name, text, chars, folded, saved, at } */
const store = new Map();

function dataRoot() {
  const root = process.env.DSH_PROFILE_DIR || process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(root, 'data');
}

function stateFile() {
  return join(dataRoot(), 'context-curator.json');
}

function loadState() {
  const state = { ...DEFAULTS, protect: [...DEFAULTS.protect] };
  try {
    const file = stateFile();
    if (!existsSync(file)) return state;
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    if (raw && typeof raw === 'object') {
      if (typeof raw.enabled === 'boolean') state.enabled = raw.enabled;
      if (Number.isInteger(raw.minChars) && raw.minChars >= 0) state.minChars = raw.minChars;
      if (Array.isArray(raw.protect)) state.protect = raw.protect.filter((x) => typeof x === 'string');
      if (typeof raw.foldSkillsCatalog === 'boolean') state.foldSkillsCatalog = raw.foldSkillsCatalog;
      if (typeof raw.foldNewSections === 'boolean') state.foldNewSections = raw.foldNewSections;
      if (Number.isInteger(raw.skillDescriptionMaxChars) && raw.skillDescriptionMaxChars > 0) {
        state.skillDescriptionMaxChars = raw.skillDescriptionMaxChars;
      }
    }
  } catch {
    /* 读坏了就用默认值，不阻塞启动 */
  }
  return state;
}

/** 记过的段名快照：用来标出「装/更新插件后新冒出来的段」。 */
function seenFile() {
  return join(dataRoot(), 'context-curator-seen.json');
}

function loadSeen() {
  try {
    const raw = JSON.parse(readFileSync(seenFile(), 'utf8'));
    return new Set(Array.isArray(raw?.names) ? raw.names.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function saveSeen(set) {
  try {
    const file = seenFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ names: [...set].slice(-800), at: Date.now() }, null, 2), 'utf8');
  } catch {
    /* 快照写不进去不影响折叠 */
  }
}

function saveState(state) {
  try {
    const file = stateFile();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 归一化空白并截断，用于一行摘要。 */
function brief(text, max = BRIEF_MAX) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** 取正文里第一行有信息量的文字（跳过空行、注释、纯分隔线）。 */
function firstLine(text) {
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    if (t.startsWith('<!--') || t.startsWith('---')) continue;
    return t;
  }
  return '';
}

/** 从 assemble / pre-step 的 context 上尽量拿到 agent id。 */
function agentIdOf(context) {
  try {
    return String(context?.agent?.id ?? context?.scope?.agent?.id ?? 'global');
  } catch {
    return 'global';
  }
}

function keyOf(agentId, sectionName) {
  return `${agentId}::${sectionName}`;
}

function remember(agentId, sectionName, text, folded, saved, now) {
  if (!sectionName || !text) return;
  store.set(keyOf(agentId, sectionName), {
    agentId,
    name: sectionName,
    text,
    chars: text.length,
    folded: Boolean(folded),
    saved: Number.isFinite(saved) ? saved : 0,
    at: now,
  });
  // 只保留最近 400 条，防止长会话无限增长
  if (store.size > 400) {
    const oldest = [...store.values()].sort((a, b) => a.at - b.at).slice(0, store.size - 400);
    for (const entry of oldest) store.delete(keyOf(entry.agentId, entry.name));
  }
}

function isProtected(state, sectionName) {
  return state.protect.some((p) => p === sectionName);
}

/** 该段是否应该折叠。 */
function shouldFold(state, sectionName, text) {
  if (!state.enabled) return false;
  if (!sectionName || !text) return false;
  if (isProtected(state, sectionName)) return false;
  return text.length >= state.minChars;
}

/** 折叠后的那一行：段名、原始体量、首句主题、取回方式。 */
function foldLine(sectionName, text) {
  const head = brief(firstLine(text), BRIEF_MAX);
  let line = `${MARK} ${sectionName}｜${text.length} 字符已折叠｜${head}｜需要时 context_load("${sectionName}")`;
  if (line.length > LINE_MAX) {
    const room = Math.max(24, LINE_MAX - (line.length - head.length));
    line = `${MARK} ${sectionName}｜${text.length} 字符已折叠｜${brief(head, room)}｜需要时 context_load("${sectionName}")`;
  }
  return line;
}

export function apply(ctx, config = {}) {
  const state = loadState();
  // 段名快照：装/更新插件后第一次出现的段会被标成「新」，方便确认它是否已被折叠
  const seen = loadSeen();
  const fresh = new Set();
  const markSeen = (sectionName) => {
    if (!sectionName || seen.has(sectionName)) return;
    seen.add(sectionName);
    fresh.add(sectionName);
    saveSeen(seen);
  };
  // 行内 config 优先（patch 里可以写 enabled: true 直接开）
  for (const field of Object.keys(DEFAULTS)) {
    if (config[field] !== undefined) state[field] = config[field];
  }

  const warn = (message) => {
    try {
      ctx.logger?.warn?.(`[context-curator] ${message}`);
    } catch {
      /* logger 不可用时保持静默 */
    }
    if (stats.errors.length < 20) stats.errors.push(String(message));
  };

  /** 装配时折叠。返回的 assembly 就是模型看到的那一份。 */
  const curateAssembly = (assembly, context) => {
    if (!assembly || !Array.isArray(assembly.sections)) return assembly;
    const agentId = agentIdOf(context);
    const now = Date.now();
    stats.assemblies += 1;
    stats.lastAt = now;

    let saved = 0;
    let folded = 0;
    const out = assembly.sections.map((section) => {
      let sectionName = '';
      let text = '';
      try {
        sectionName = String(section?.name ?? '');
        text = typeof section?.text === 'string' ? section.text : '';
      } catch {
        return section;
      }
      if (!text) return section;
      stats.sectionsSeen += 1;
      markSeen(sectionName);

      // foldNewSections 打开时，装/更新插件后新冒出来的段即使不到阈值也先压成一行
      const fold =
        state.enabled &&
        !isProtected(state, sectionName) &&
        (text.length >= state.minChars || (state.foldNewSections && fresh.has(sectionName)));
      if (fold) {
        const line = foldLine(sectionName, text);
        remember(agentId, sectionName, text, true, text.length - line.length, now);
        folded += 1;
        saved += Math.max(0, text.length - line.length);
        try {
          return { ...section, text: line };
        } catch {
          return section;
        }
      }
      remember(agentId, sectionName, text, false, 0, now);
      return section;
    });

    stats.foldedNow = folded;
    stats.savedNow = saved;
    if (folded) stats.savedTotal += saved;
    if (folded === 0) return assembly;

    // 保持 assembly 的原型（它可能是类实例），只换 sections
    try {
      return { ...assembly, sections: out };
    } catch {
      return assembly;
    }
  };

  /** 技能目录：把每条描述压成一句，保留 source.entries 不动。 */
  const shrinkCatalog = (message) => {
    try {
      const source = message?.source;
      if (!source || source.kind !== 'skill-catalog') return message;
      const entries = Array.isArray(source.entries) ? source.entries : null;
      if (!entries || entries.length === 0) return message;
      const before = messageText(message).length;
      if (before === 0) return message;

      const max = state.skillDescriptionMaxChars;
      const lines = entries.map((entry) => {
        const desc = brief(firstLine(entry?.description ?? ''), max);
        return `- \`${entry?.name}\`: ${desc}`;
      });
      const text = [
        '<system-reminder>',
        `本会话可用技能 ${entries.length} 个。这里只保留识别用的首句，全文用 \`skill\` 工具按精确名称加载。`,
        '',
        '<available_skills>',
        ...lines,
        '</available_skills>',
        '',
        '任务明显匹配某技能、或用户点名时，先用 `skill` 工具加载它，再按其完整指示执行；加载前不要凭空推断技能内容。',
        '</system-reminder>',
      ].join('\n');

      const after = text.length;
      if (after >= before) return message;

      stats.catalogs += 1;
      stats.catalogSavedNow = before - after;
      return replaceMessageText(message, text);
    } catch {
      return message;
    }
  };

  const disposers = [];

  // ── 提示词段折叠 ────────────────────────────────────────────────
  try {
    disposers.push(
      ctx.on(
        'system-prompt/assemble',
        async (...args) => {
          // waterfall 签名兼容：(assembly, context) 或 (assembly, context, next)
          const assembly = args[0];
          const context = args[1];
          const next = args.length >= 3 && typeof args[args.length - 1] === 'function' ? args[args.length - 1] : null;
          let assembled = assembly;
          if (next) {
            try {
              assembled = await next();
            } catch (error) {
              // 下游抛错会弄死整条装配，退回上游结果
              warn(`assemble 下游失败：${error?.message ?? error}`);
              assembled = assembly;
            }
          }
          try {
            return curateAssembly(assembled, context);
          } catch (error) {
            warn(`组装折叠失败：${error?.message ?? error}`);
            return assembled;
          }
        },
        { global: true, prepend: true },
      ),
    );
  } catch (error) {
    warn(`无法注册 assemble 钩子：${error?.message ?? error}`);
  }

  // ── 技能目录压缩 ────────────────────────────────────────────────
  try {
    disposers.push(
      ctx.on(
        'agent/pre-step',
        async (payload, next) => {
          const decision = typeof next === 'function' ? await next() : payload;
          try {
            if (!decision || decision.kind === 'reject') return decision;
            if (!state.enabled || !state.foldSkillsCatalog) return decision;
            if (!Array.isArray(decision.messages)) return decision;
            return { ...decision, messages: decision.messages.map((m) => shrinkCatalog(m)) };
          } catch (error) {
            warn(`技能目录压缩失败：${error?.message ?? error}`);
            return decision;
          }
        },
        { global: true, prepend: true },
      ),
    );
  } catch (error) {
    warn(`无法注册 pre-step 钩子：${error?.message ?? error}`);
  }

  // ── 工具 ────────────────────────────────────────────────────────
  const toolOutput = {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: String(value?.text ?? JSON.stringify(value, null, 2)) }],
  };

  try {
    disposers.push(
      ctx.tools.register({
        name: 'context_ledger',
        description:
          '查看当前上下文的「提示词段账单」：每段的字符数、是否已被折叠、折叠节省了多少，以及技能目录的条目规模。装或更新插件之后先跑一次，新冒出来的段会标 [新]，可据此确认它们是否已被自动折叠。只读，用来决定要不要开启折叠、哪些段不该折叠。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: {
              type: 'string',
              enum: ['list', 'stats'],
              description: 'list 逐段列出（字符数降序）；stats 只看汇总。默认 list。',
            },
            limit: { type: 'integer', description: 'list 最多列多少段，默认 40。' },
          },
        },
        output: toolOutput,
        deferLoading: false,
        async execute(args, exec) {
          const action = String(args?.action ?? 'list');
          const limit = Number.isInteger(args?.limit) && args.limit > 0 ? args.limit : 40;
          const agentId = String(exec?.agent?.id ?? 'global');
          const rows = [...store.values()]
            .filter((entry) => entry.agentId === agentId)
            .sort((a, b) => b.chars - a.chars);

          const totalChars = rows.reduce((sum, r) => sum + r.chars, 0);
          const foldedChars = rows.filter((r) => r.folded).reduce((sum, r) => sum + r.chars, 0);
          const saveable = rows.filter((r) => !r.folded && !isProtected(state, r.name) && r.chars >= state.minChars);

          if (action === 'stats') {
            return {
              text: [
                `enabled=${state.enabled} minChars=${state.minChars} 段数=${rows.length} 总字符=${totalChars}`,
                `已折叠段=${rows.filter((r) => r.folded).length}（原文 ${foldedChars} 字符）`,
                `可折叠但未折叠=${saveable.length}（约 ${saveable.reduce((s, r) => s + r.chars, 0)} 字符）`,
                `技能目录压缩=${state.foldSkillsCatalog ? 'on' : 'off'} 最近节省=${stats.catalogSavedNow}`,
                `最近一次装配节省=${stats.savedNow} 字符，累计=${stats.savedTotal}`,
                `本次运行新出现段=${fresh.size}${fresh.size ? `（${[...fresh].slice(0, 8).join(', ')}）` : ''}`,
              ].join('\n'),
            };
          }

          const lines = [
            `# 上下文账单（agent=${agentId}）`,
            `enabled=${state.enabled}｜minChars=${state.minChars}｜段数=${rows.length}｜总字符=${totalChars}｜已折叠=${rows.filter((r) => r.folded).length}`,
            '',
            '字符数   折叠  段名',
          ];
          for (const row of rows.slice(0, limit)) {
            lines.push(`${String(row.chars).padStart(7, ' ')}  ${row.folded ? '是' : '否'}    ${fresh.has(row.name) ? '[新] ' : ''}${row.name}`);
          }
          if (rows.length > limit) lines.push(`… 另有 ${rows.length - limit} 段未列出`);
          if (fresh.size) {
            lines.push('', `本次运行新出现（多为刚装/刚更新的插件带来的段）：${[...fresh].join(', ')}`);
          }
          if (saveable.length) {
            lines.push('', `建议折叠（≥${state.minChars} 字符且未被保护）：${saveable.map((r) => r.name).join(', ')}`);
          }
          return { text: lines.join('\n') };
        },
      }),
    );
  } catch (error) {
    warn(`注册 context_ledger 失败：${error?.message ?? error}`);
  }

  try {
    disposers.push(
      ctx.tools.register({
        name: 'context_load',
        description:
          '取回某一段被折叠的提示词全文。当任务确实依赖该段细节（规则、协议、命令清单）时先调用它，再按原文执行。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            name: { type: 'string', description: '段名，就是折叠行里 ⟨ctx⟩ 后面的那个名字。' },
          },
          required: ['name'],
        },
        output: toolOutput,
        deferLoading: false,
        async execute(args, exec) {
          const wanted = String(args?.name ?? '').trim();
          if (!wanted) return { text: '缺少 name：折叠行里 ⟨ctx⟩ 后面那段文字就是段名。' };
          const agentId = String(exec?.agent?.id ?? 'global');
          const entry = store.get(keyOf(agentId, wanted)) ?? store.get(keyOf('global', wanted));
          if (!entry) {
            const names = [...store.values()]
              .filter((e) => e.agentId === agentId)
              .map((e) => e.name)
              .slice(0, 30);
            return { text: `没有名为 "${wanted}" 的段。已知段：${names.join(', ') || '（还没有任何记录）'}` };
          }
          return { text: entry.text };
        },
      }),
    );
  } catch (error) {
    warn(`注册 context_load 失败：${error?.message ?? error}`);
  }

  try {
    disposers.push(
      ctx.tools.register({
        name: 'context_config',
        description:
          '读或改上下文折叠的开关与阈值：enabled（总开关）、minChars（多长的段才折叠）、protect（永不折叠的段名）、foldSkillsCatalog、skillDescriptionMaxChars、foldNewSections（装/更新插件后新出现的段即使不到 minChars 也折叠）。改动立即生效并持久化到本 profile。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: { type: 'string', enum: ['get', 'set'], description: '默认 get。' },
            enabled: { type: 'boolean', description: 'set：总开关。' },
            minChars: { type: 'integer', description: 'set：折叠阈值（字符）。' },
            foldSkillsCatalog: { type: 'boolean', description: 'set：是否压缩技能目录。' },
            skillDescriptionMaxChars: { type: 'integer', description: 'set：技能描述保留上限。' },
            foldNewSections: { type: 'boolean', description: 'set：装/更新插件后新出现的段无视 minChars 直接折叠。' },
            protect: { type: 'array', items: { type: 'string' }, description: 'set：整体替换"永不折叠"名单。' },
            protectAdd: { type: 'array', items: { type: 'string' }, description: 'set：追加到保护名单。' },
            protectRemove: { type: 'array', items: { type: 'string' }, description: 'set：从保护名单移除。' },
          },
        },
        output: toolOutput,
        deferLoading: false,
        async execute(args) {
          const action = String(args?.action ?? 'get');
          if (action === 'set') {
            if (typeof args?.enabled === 'boolean') state.enabled = args.enabled;
            if (Number.isInteger(args?.minChars) && args.minChars >= 0) state.minChars = args.minChars;
            if (typeof args?.foldSkillsCatalog === 'boolean') state.foldSkillsCatalog = args.foldSkillsCatalog;
            if (typeof args?.foldNewSections === 'boolean') state.foldNewSections = args.foldNewSections;
            if (Number.isInteger(args?.skillDescriptionMaxChars) && args.skillDescriptionMaxChars > 0) {
              state.skillDescriptionMaxChars = args.skillDescriptionMaxChars;
            }
            if (Array.isArray(args?.protect)) {
              state.protect = args.protect.filter((x) => typeof x === 'string');
            }
            for (const name of Array.isArray(args?.protectAdd) ? args.protectAdd : []) {
              if (typeof name === 'string' && !state.protect.includes(name)) state.protect.push(name);
            }
            for (const name of Array.isArray(args?.protectRemove) ? args.protectRemove : []) {
              state.protect = state.protect.filter((x) => x !== name);
            }
            const saved = saveState({
              enabled: state.enabled,
              minChars: state.minChars,
              protect: state.protect,
              foldSkillsCatalog: state.foldSkillsCatalog,
              foldNewSections: state.foldNewSections,
              skillDescriptionMaxChars: state.skillDescriptionMaxChars,
            });
            return {
              text: [
                `已更新（持久化${saved ? '成功' : '失败，仅在本次进程生效'}）：`,
                JSON.stringify(
                  {
                    enabled: state.enabled,
                    minChars: state.minChars,
                    protect: state.protect,
                    foldSkillsCatalog: state.foldSkillsCatalog,
                    foldNewSections: state.foldNewSections,
                    skillDescriptionMaxChars: state.skillDescriptionMaxChars,
                  },
                  null,
                  2,
                ),
                '说明：下一次模型请求装配时按新配置生效。',
              ].join('\n'),
            };
          }
          return {
            text: JSON.stringify(
              {
                enabled: state.enabled,
                minChars: state.minChars,
                protect: state.protect,
                foldSkillsCatalog: state.foldSkillsCatalog,
                foldNewSections: state.foldNewSections,
                skillDescriptionMaxChars: state.skillDescriptionMaxChars,
                stats: {
                  assemblies: stats.assemblies,
                  sectionsSeen: stats.sectionsSeen,
                  savedNow: stats.savedNow,
                  savedTotal: stats.savedTotal,
                  catalogs: stats.catalogs,
                  catalogSavedNow: stats.catalogSavedNow,
                },
              },
              null,
              2,
            ),
          };
        },
      }),
    );
  } catch (error) {
    warn(`注册 context_config 失败：${error?.message ?? error}`);
  }

  // 插件卸载 / 热重载时收掉全部监听与工具
  try {
    ctx.effect(() => () => {
      for (const dispose of disposers) {
        try {
          dispose?.();
        } catch {
          /* ignore */
        }
      }
    });
  } catch {
    /* 没有 effect 时靠 ctx 自行释放 */
  }
}

/** 消息首个文本块的内容。 */
function messageText(message) {
  try {
    const blocks = Array.isArray(message?.content) ? message.content : [];
    for (const block of blocks) {
      if (block?.type === 'text' && typeof block.text === 'string') return block.text;
    }
  } catch {
    /* ignore */
  }
  return '';
}

/** 替换首个文本块，保留消息 id 与 source（下游按 id/source 去重）。 */
function replaceMessageText(message, text) {
  try {
    const blocks = Array.isArray(message?.content) ? message.content : [];
    let replaced = false;
    const content = blocks.map((block) => {
      if (!replaced && block?.type === 'text' && typeof block.text === 'string') {
        replaced = true;
        return { ...block, text };
      }
      return block;
    });
    if (!replaced) return message;
    return { ...message, content };
  } catch {
    return message;
  }
}
