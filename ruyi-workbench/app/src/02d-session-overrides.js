// 02d-session-overrides.js - 架构还债批 3·B: 从 02-session-store.js 搬出的会话级内存覆盖表(引擎路由/权限档/桌面工具的 live-turn stale-save guard;纯搬家,零行为变更)。
const sessionEngineRouteOverrides = new Map(); // live-turn stale-save guard for UI route changes
// 116-2a(27 号文 §3.3/§8.6 线程权限就地快切):会话级权限档的内存权威副本 —— 与上面那张 engineRoute
// 覆盖表同款「live-turn stale-save guard」。值为档名,或 ''(= 用户清除了会话级设置,回落全局)。
// 为什么需要它:活回合手里那份会话内存副本是回合开始时的快照,不带用户刚切的权限档;它的收尾 save
// 会把整个会话头写回「没有该字段」的样子。loadSession / saveSession 两侧都应用这张表,任何顺序下
// 快切都不会被回合的陈旧副本吞掉,也让「点开即换、立即生效」对所有读者(含还没落盘的那一刻)成立。
// 表为空时全部应用点都是零操作 —— 没有设过会话级权限的会话(含全部存量会话)行为逐字节不变。
const sessionPermissionModeOverrides = new Map();
// 会话头 permissionMode 的白名单归一:''/null/非法值一律归成 ''(= 清除会话级设置,回落全局默认)。
function normalizeSessionPermissionMode(value) {
  const mode = value == null ? '' : String(value);
  return PERMISSION_MODES.includes(mode) ? mode : '';
}
// 会话级权限档的读形:合法则返回档名,否则 null(【不】在这里填全局值 —— 见 sessionMeta 的注释)。
function sessionPermissionModeOf(o) {
  const mode = normalizeSessionPermissionMode(o && o.permissionMode);
  return mode || null;
}
// 把内存覆盖表盖到一个会话对象/会话头上(装载时与落盘前各一次)。没有条目就原样返回。
function applySessionPermissionModeOverride(session) {
  const id = session && session.id;
  if (!id || !sessionPermissionModeOverrides.has(id)) return session;
  const mode = sessionPermissionModeOverrides.get(id);
  if (mode) session.permissionMode = mode; else delete session.permissionMode;
  return session;
}
// 117m-A1(用户第六轮走查②;27 号文 §3.3/§8.6):活回合中途改档,闸门要读【此刻】的会话级档,
// 而不是回合开始时的那个快照。修前 10-context-governance 在回合开始时把三层解析成一个不可变快照
// (resolvePermissionMode(request > session > config)),09/08 全程读它 —— 上面 sessionMetaDeferChains
// 的设计注释 ② 自称「permissionMode 先进内存覆盖表…对所有读者立刻是新值」,但 09 的闸门从来没读过
// 这张表,那句话对活回合从未成立。后果是用户在最该收紧/放宽的那几分钟里改档等于没改(放宽只是费
// token,反过来「想临时收紧」失效则是安全问题)。
// 本函数【只读】,不碰延后落盘那条链;档位仍然只有 PATCH 一个写口。
// '' = 用户清了会话级设置(回落全局),此时返回 null 让调用方继续用它自己的解析结果 —— 中途「清除」
// 要到下一个回合才生效。这是有意的保守取舍:清除是回落全局,方向不定,不在活回合里替用户猜。
function liveSessionPermissionMode(id) {
  const mode = sessionPermissionModeOverrides.get(String(id || ''));
  return mode ? mode : null;
}

// ── 117z-E2 提交①(27 号文 §11.21.3):会话级【桌面工具】覆盖 ───────────────────────────────
// 修前 `allowDesktopTools` 是【全局唯一】的一把闸(07-autonomy:99),在 buildOpenAiTools 的注册层
// 决定桌面工具要不要提供给模型;没有任何会话级覆盖。本波加的是【另一把钥匙】,不动那把全局闸:
//   · session.desktopTools === true   -> 这条线程拿得到桌面工具(与全局值无关);
//   · session.desktopTools === false  -> 这条线程拿不到(与全局值无关);
//   · 缺席 / null                     -> 跟随全局 allowDesktopTools(= 全部存量会话的行为逐字节不变)。
// 三态而不是布尔:两态分不出「这条线程自己定了」与「跟着全局走」,与 permissionMode 的 chip 同一条
// 理由(见 sessionMeta 里那段注释)。
function normalizeSessionDesktopTools(value) {
  if (value === true) return true;
  if (value === false) return false;
  return null;   // null/''/缺席/任何野值 -> 跟随全局(fail-open 到【修前行为】,不是 fail-open 到放行)
}
// 读形:true / false / null(null = 没设过会话级覆盖)。
function sessionDesktopToolsOf(o) {
  return normalizeSessionDesktopTools(o && o.desktopTools);
}
// 与 sessionPermissionModeOverrides 同款「live-turn stale-save guard」:活回合手里那份会话内存副本是
// 回合开始时的快照,不带刚写下的覆盖值;它的收尾 save 会把整个会话头写回「没有该字段」的样子。
// loadSession / saveSession 两侧都盖一次,任何顺序下这次改动都不会被回合的陈旧副本吞掉。
// 表为空时全部应用点都是零操作 —— 没设过会话级桌面覆盖的会话(含全部存量会话)行为逐字节不变。
const sessionDesktopToolsOverrides = new Map();   // id -> true | false | null(null = 清除,回落全局)
function applySessionDesktopToolsOverride(session) {
  const id = session && session.id;
  if (!id || !sessionDesktopToolsOverrides.has(id)) return session;
  const value = sessionDesktopToolsOverrides.get(id);
  if (value === null) delete session.desktopTools; else session.desktopTools = value;
  return session;
}
