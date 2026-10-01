// 04j-voice-lexicon.js - 语音词库的纯函数内核:个人词 + 原厂常用词 → 给三处识别口各出一份形状(59 号文)。
//
// 用户 2026-10-01:「转写完以后看用户手动改的字、收集规律整理,后续听到同音字的时候优先转成对应的」;拍板「每个用户的词库
// 不一样,所以默认从用户手改的错字里去学习,原厂只提供一份常见中英文词,当然也可以尽量详细一点」。本模块是第一步的地基:
//   ① 词条的形状与清洗、设置页那份文本(「词 = 被听成的样子1, 样子2」一行一条)的读写;
//   ② 原厂常用词表 BASE_TEXT(中英混说的技术/办公/AI/游戏引擎词 + 常被听错的中文技术词,带常见的错听样子);
//   ③ 按这一句挑词(pick):个人词全带(这一句里出现过它的错听样子的排前面),原厂词只在这一句里出现了它的错听样子、
//      或英文写法大小写不对时才带 —— 原厂表很长,整张塞进去既费 token 又招大模型乱改;
//   ④ 三处识别口各自的形状:大模型改字的 <glossary> 行、整段识别(Qwen3-ASR / Whisper 形)的 prompt、
//      实时识别(asr-stream / sherpa)的会话热词(只给个人词 —— 52 号文 §2 实测通用技术词当热词几乎没用)。
// 第二步「从修改里学」只往同一份词库里加词条(src:'learned'),挑词与出形不用变。
//
// 词条只当【提示】,不做无上下文的硬替换:原型(59 号文 §2)里同一个词会被听成很多样子(debug ← 低暴/低报/低爆/d bug…),
// 单字同音(在/再、爆/报)占改动的大头 —— 按字串硬替换要么覆盖不全、要么误伤;交给听得到声音的(重听)或看得懂整句的
// (大模型)去判,学歪了代价小:对不上的词它们不会用。
//
// 依赖环纪律:与 11b-file-text-io 同模具 —— 本模块【零出边】(不引用任何其他 app/src 模块的顶层符号),
// 只暴露一个冻结对象 VoiceLexicon。落盘(DurableJsonStore)住 05、路由住 13b,它们从这里拿纯函数。
const VoiceLexicon = (() => {
  const SCHEMA = 1;
  const MAX_TERMS = 500;          // 个人词条上限(含学来后又被删掉的停用墓碑)
  const MAX_TERM_CHARS = 40;      // 与 asr-stream 会话热词的单条上限一致
  const MAX_HEARD = 8;            // 一个词最多记几种「被听成的样子」
  const MAX_HEARD_CHARS = 20;
  const MAX_TEXT_CHARS = 40000;   // 设置页一次提交的文本上限
  const PICK_USER_MAX = 40;       // 一句最多带几个个人词
  const PICK_BASE_MAX = 24;       // 一句最多带几个原厂词
  const GLOSSARY_HEARD_MAX = 4;   // <glossary> 每行最多列几种错听样子
  const PROMPT_MAX_CHARS = 400;   // 整段识别的 prompt 上限(asr-shim 字段上限 4096 字节;Whisper 形的 prompt 本来就该短)
  const HOTWORDS_MAX = 200;       // asr-stream 会话热词上限
  const MAX_PENDING = 300;        // 第二步:还没攒够证据的候选(04j-voice-learn 写)
  const SOURCES = ['manual', 'learned', 'typed'];   // 手加 / 从修改里学(第二步)/ 从打过的字里抽(第二步)
  const PENDING_KINDS = ['pair', 'window', 'typed'];

  // 一段词或样子的清洗:控制字符与尖括号换成空格(词条要进 <glossary> 标签,不许借词条串标签)、空白收成一个空格、截长。
  // 一个字母、数字或汉字都没有的(纯标点)不收。
  function clean(raw, max) {
    let s = String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim();
    if (s.length > max) s = s.slice(0, max).trim();
    return /[\p{L}\p{N}]/u.test(s) ? s : '';
  }
  const isLatin = s => /^[\x20-\x7e]+$/.test(s);
  const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // 错听样子的门槛:与词本身相同(不分大小写)的不收;中文至少 2 个字、英文至少 3 个字母数字 —— 太短的样子(「在」「ma」)
  // 在别的句子里到处都是,拿它当「这一句可能说的是 X」的线索只会招来误改。
  function addHeard(entry, raw) {
    const h = clean(raw, MAX_HEARD_CHARS);
    if (!h || entry.heard.length >= MAX_HEARD) return;
    const low = h.toLowerCase();
    if (low === entry.term.toLowerCase()) return;
    if (isLatin(h) ? h.replace(/[^A-Za-z0-9]/g, '').length < 3 : h.replace(/\s/g, '').length < 2) return;
    if (entry.heard.some(x => x.toLowerCase() === low)) return;
    entry.heard.push(h);
  }

  // 设置页那份文本 → 词条。一行一个词;「词 = 样子1, 样子2」(= ＝ ← 都认;样子之间 , ，、 ; ； | 都认);
  // 空行与 # 或 // 开头的行是注释。同一个词(不分大小写)写了两行就合并它们的样子。skipped = 认不出词的行数。
  function parseText(source) {
    const entries = [], index = new Map();
    let skipped = 0;
    for (const raw of String(source == null ? '' : source).slice(0, MAX_TEXT_CHARS).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || line.startsWith('//')) continue;
      const m = line.match(/^(.*?)\s*(?:=|＝|←)\s*(.*)$/);
      const term = clean(m ? m[1] : line, MAX_TERM_CHARS);
      if (!term) { skipped += 1; continue; }
      const key = term.toLowerCase();
      let entry = index.get(key);
      if (!entry) { entry = { term, heard: [] }; index.set(key, entry); entries.push(entry); }
      if (m) for (const h of m[2].split(/[,，、;；|]/)) addHeard(entry, h);
    }
    return { entries, skipped };
  }
  function formatText(entries) {
    return (Array.isArray(entries) ? entries : []).map(e => (e.heard && e.heard.length ? e.term + ' = ' + e.heard.join(', ') : e.term)).join('\n');
  }

  // ── 落盘形状(05 的 DurableJsonStore 用这两个函数)───────────────────────────────────────────────────
  // { schema:1, base:true(用不用原厂常用词), learn:true(从用户手改里学,第二步,缺省开),
  //   terms:{ <小写词>: { term, heard[], src, n, at, off } },
  //   pending:{ <小写词>: { term, heard[], n, at, kind, group } } }
  //   n   = 被改过(或打过)几次;at = 最近一次的时间;off = 停用的墓碑(学来的词被用户删掉 → 别再学回来)。
  //   pending 是还没攒够证据的候选(04j-voice-learn 的 apply 写、到数就挪进 terms);kind:pair(整段改动)／window(人名这种
  //   只改了一个字、要靠前后几个字拼出整个词)／typed(打过的英文词);group = 同一处改动的几个窗口共用的组名。
  //   键一律由 term 重算(手改坏的键不认);对象键的插入序 = 新旧序,超出容量时 DurableJsonStore 从最早的键裁起。
  function defaultState() { return { schema: SCHEMA, base: true, learn: true, terms: {}, pending: {} }; }
  function sanitizePending(src) {
    const pending = {};
    for (const raw of Object.values(src && typeof src === 'object' && !Array.isArray(src) ? src : {})) {
      if (!raw || typeof raw !== 'object') continue;
      const term = clean(raw.term, MAX_TERM_CHARS);
      if (!term) continue;
      const entry = { term, heard: [] };
      for (const h of Array.isArray(raw.heard) ? raw.heard : []) addHeard(entry, h);
      const key = term.toLowerCase();
      delete pending[key];
      const n = Number(raw.n);
      pending[key] = {
        term, heard: entry.heard,
        n: Number.isFinite(n) && n > 0 ? Math.min(1e6, Math.floor(n)) : 1,
        at: typeof raw.at === 'string' ? raw.at.slice(0, 40) : '',
        kind: PENDING_KINDS.includes(raw.kind) ? raw.kind : 'pair',
        group: typeof raw.group === 'string' ? raw.group.slice(0, 60) : '',
      };
    }
    return pending;
  }
  function sanitizeState(value) {
    const v = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const src = v.terms && typeof v.terms === 'object' && !Array.isArray(v.terms) ? v.terms : {};
    const terms = {};
    for (const raw of Object.values(src)) {
      if (!raw || typeof raw !== 'object') continue;
      const term = clean(raw.term, MAX_TERM_CHARS);
      if (!term) continue;
      const entry = { term, heard: [] };
      for (const h of Array.isArray(raw.heard) ? raw.heard : []) addHeard(entry, h);
      const key = term.toLowerCase();
      delete terms[key];   // 同名的后来者覆盖、并挪到最后(最新)
      const n = Number(raw.n);
      terms[key] = {
        term, heard: entry.heard,
        src: SOURCES.includes(raw.src) ? raw.src : 'manual',
        n: Number.isFinite(n) && n > 0 ? Math.min(1e6, Math.floor(n)) : 0,
        at: typeof raw.at === 'string' ? raw.at.slice(0, 40) : '',
        off: raw.off === true,
      };
    }
    return { schema: SCHEMA, base: v.base !== false, learn: v.learn !== false, terms, pending: sanitizePending(v.pending) };
  }
  const activeTerms = state => Object.values(sanitizeState(state).terms).filter(t => !t.off);

  // 设置页提交整份文本:按词对齐旧词条 —— 留下的保留来源与次数(词或样子有改动才更新时间),新出现的记成 manual;
  // 文本里没了的:手加的直接删;学来的留一条停用墓碑(off:true),免得第二步又把它学回来。墓碑排在前面:超容量时先裁墓碑。
  // 一次超过 MAX_TERMS 条:只留前面那些、overflow 报多出来几条(路由据此整份拒收,不静默截断)。
  function applyText(state, source, stamp) {
    const prev = sanitizeState(state);
    const { entries, skipped } = parseText(source);
    const overflow = Math.max(0, entries.length - MAX_TERMS);
    const live = {}, tombs = {};
    for (const e of entries.slice(0, MAX_TERMS)) {
      const key = e.term.toLowerCase();
      const old = prev.terms[key];
      const keep = old && !old.off;
      const same = keep && old.term === e.term && old.heard.join('\n') === e.heard.join('\n');
      live[key] = { term: e.term, heard: e.heard, src: keep ? old.src : 'manual', n: old ? old.n : 0, at: same ? old.at : String(stamp || ''), off: false };
    }
    for (const [key, old] of Object.entries(prev.terms)) {
      if (live[key] || old.src === 'manual') continue;
      tombs[key] = { ...old, off: true };
    }
    return { state: { ...prev, terms: { ...tombs, ...live } }, skipped, overflow, count: Math.min(entries.length, MAX_TERMS) };
  }
  function setBase(state, enabled) { const s = sanitizeState(state); s.base = enabled !== false; return s; }
  function setLearn(state, enabled) { const s = sanitizeState(state); s.learn = enabled !== false; return s; }

  // ── 原厂常用词表 ───────────────────────────────────────────────────────────────────────────────────
  // 格式与设置页同一份(parseText 读)。收词原则:说中文时常夹着说的英文词、常被识别错的中文技术词;
  // 错听样子只收「出现了几乎就是在说这个词」的(多是音译串:刀客、瑞迪斯、康米特),
  // 日常常用词当样子要有评测里的实证才收(腹泻→复现、雾气→服务器、心中→新增、题型→提醒,59 号文 §2 原型抽出来的)。
  // 没有错听样子的词也有用:英文写法大小写不对(GITHUB / postgresql)时它会被挑中,告诉改字的模型正经写法。
  const BASE_TEXT = `
# —— 版本管理与协作 ——
git = 给特, 吉特, 鸡特, 盖特, 盖茨
GitHub = 给特哈布, 吉特哈布, 鸡特哈布, git hub
GitLab = 给特莱布, 吉特莱布, git lab
Gitee = 吉提, 给提
commit = 康米特, 抗米特, 科米特, 可米特
push = 普什, 扑什
pull = 普尔, 扑尔
fetch = 菲奇, 费曲
merge = 墨菊, 默几
rebase = 瑞贝斯, 瑞倍斯, 锐贝斯, 日贝斯
cherry-pick = 车厘子皮克, 切瑞皮克, cherry pick
stash = 斯泰什, 斯戴什
branch = 布兰奇, 布朗奇
checkout = 切克奥特, check out
diff = 迪夫
patch = 派奇, 帕奇
main = 魅影, 麦恩
master = 马斯特, 玛斯特
develop = 迪维洛普
feature = 飞车, 菲彻
hotfix = 哈特菲克斯, hot fix
release = 瑞丽斯, 瑞莉斯, 瑞利斯, 锐丽斯
pull request = 博瑞卡斯, 普瑞克斯, 普瑞快斯, 博瑞凯斯, 布瑞克斯, poor request, full request, pro request
merge request = 默基瑞快斯
code review = 扣的瑞view
issue = 依修, 衣修, 一休
fork = 佛克, 福克
repo = 瑞泼, 锐坡
submodule
pipeline = 派普兰, 派普莱恩
workflow
GitHub Actions
Jenkins = 詹金斯, 简金斯
SVN
Perforce = 珀福斯, 泼佛斯
changelog
README

# —— 编程语言与运行时 ——
Python = 拍森, 派森, 拍伞, 拍赛, 帕萨, 趴散, 派萨
Java = 加瓦, 扎瓦
JavaScript = 加瓦斯克瑞普特, java script
TypeScript = 泰普斯克瑞普特, type script
Node.js = 诺德, node js
npm
pnpm
yarn = 亚恩
Golang = 狗浪, 够浪
Rust = 拉斯特, 若斯特
C++ = C加加, 西加加, c plus plus
C# = C井, c sharp, 西沙普
Kotlin = 科特林, 考特林
Swift = 斯威夫特
PHP
Ruby = 鲁比, 茹比
Lua = 卢阿, 路阿
shell = 谢尔
Bash = 巴什
PowerShell = power shell
SQL
HTML
CSS
JSON = 杰森, 杰深, 节森
YAML = 亚莫, 雅莫
XML
Markdown = 马克当, 马克党, mark down
WebAssembly = web assembly
regex = 瑞杰克斯
pip = 皮普
conda = 康达
Anaconda = 安纳康达
Jupyter = 朱庇特, 丘比特
Maven = 梅文, 麦文
Gradle = 格雷德尔, 格瑞多
CMake = C make
Makefile = make file
JDK
JVM
venv

# —— 前端 ——
React = 瑞艾克特, 锐艾克特
Vue = 维优, 微优
Angular = 安格拉, 安古拉
Next.js = next js
Nuxt = 纳克斯特
Vite = 维特
webpack = 韦伯派克, web pack
Babel = 巴别, 巴贝尔
ESLint = es lint
Prettier = 普瑞蒂尔
Tailwind = 泰尔温德, tail wind
jQuery = 杰奎瑞, j query
Electron = 伊莱克特龙
Flutter = 弗拉特
DOM = 达姆
SVG
Canvas = 坎瓦斯, 堪瓦斯
WebSocket = web socket, 韦伯骚凯特
Ajax = 阿贾克斯
iframe
SSR
Chrome = 克罗姆
Safari = 萨法瑞
DevTools = dev tools
console = 康搜
localStorage = local storage

# —— 后端与框架 ——
Spring = 斯普林
Spring Boot = 斯普林布特
MyBatis = 麦巴蒂斯, my batis
Django = 姜戈, 江戈
Flask = 弗拉斯克
FastAPI = fast API
Express
NestJS = nest js
gRPC
GraphQL = graph QL
RESTful = rest ful
OpenAPI = open API
Swagger = 斯瓦格, 史瓦格
Postman = 泊斯特曼
ORM
MVC
JWT
OAuth = 欧奥斯, o auth
SSO
RPC
Dubbo = 达博, 杜博
Netty = 内蒂
Tomcat = 汤姆凯特
Nginx = 恩金克斯, 引擎X, 恩靳克斯, 恩基克斯, engine x
Apache = 阿帕奇
Celery = 塞勒瑞

# —— 数据库与中间件 ——
Redis = 瑞迪斯, 威迪斯, 瑞蒂斯, 锐迪斯, 热迪斯, 雷迪斯
MySQL = my SQL, 麦色扣
PostgreSQL = postgre SQL, 泊斯特格瑞
Postgres = 泊斯特格瑞斯
MongoDB = 芒果DB, 蒙戈DB, mongo DB
SQLite = SQL lite
Oracle = 奥瑞口, 欧瑞扣
SQL Server
Elasticsearch = elastic search, 伊拉斯提克
Kafka = 卡夫卡
RabbitMQ = rabbit MQ, 瑞比特MQ
RocketMQ = rocket MQ
ZooKeeper = zoo keeper, 祖基珀
etcd
Consul = 康索尔
ClickHouse = click house
HBase
Hive = 海夫
Spark = 斯帕克
Flink = 弗林克
Hadoop = 哈杜普, 哈都普
TiDB
Navicat = 纳维凯特
binlog = bin log
schema = 斯基马, 斯奇玛

# —— 运维、容器与云 ——
Docker = 刀客, 刀刻, 道客, 多克, 刀可, DOCT
docker compose = 刀客康珀斯, docker complex
Dockerfile = docker file
Kubernetes = 酷伯奈提斯, 库伯内特斯, 库伯奈蒂斯, 酷伯内蒂斯
k8s
kubectl = cube control, kube control
Helm = 赫尔姆
Pod = 泡德
Ingress = 因格瑞斯
Linux = 林纳斯, 里纳克斯, 利纳克斯, 林那克斯
Ubuntu = 乌班图, 乌邦图, 乌本图
CentOS = cent OS, 森特OS
Debian = 迪比安, 德比安
Windows
macOS = mac OS, 麦克OS
iOS
SSH
VPN
DNS
CDN
SSL
TLS
Terraform = 泰拉福姆
Ansible = 安瑟博
Prometheus = 普罗米修斯
Grafana = 格拉法纳, 格拉法那
Kibana = 基巴纳
Logstash = log stash
Zabbix = 扎比克斯
crontab = cron tab, 克龙泰布
systemd
AWS
Azure = 阿祖尔
OSS
S3
ECS
EC2
Lambda = 兰姆达, 拉姆达
Serverless = server less
VMware = VM ware
VirtualBox = virtual box
WSL
Hyper-V = hyper V

# —— 网络与协议 ——
HTTP
HTTPS
TCP
UDP
IPv6
URL
WebRTC
MQTT
SFTP
NAT
VLAN
localhost = local host
proxy = 普罗克西
cookie = 酷奇, 曲奇
session = 赛深, 塞神
token = 偷肯, 托肯, 头肯
CORS
CSRF
XSS

# —— 开发日常用语 ——
debug = 低报, 低暴, 低爆, 滴爆, 地堡, 迪巴格, d bug
bug = 巴格, 八哥, 巴克, 霸格
log = 落格, 洛格
deploy = 迪普洛伊
build = 比尔德
compile = 康派尔
crash = 克拉什
dump = 当普
rollback = roll back
refactor = 瑞法克特
demo = 迪摩, 得摩
case = 凯斯
review
sprint = 斯普林特
backlog = back log
deadline = dead line, 戴德莱恩
sync = 星克, 辛克
async = a sync
callback = call back
promise = 普罗米斯
timeout = time out
retry = re try
thread = 斯瑞德
buffer = 巴佛
config = 康飞格, 康菲格
env = EMV
script = 斯克瑞普特
plugin = 普拉根, plug in
sudo = 苏杜
TODO
workaround = work around
fallback = fall back
breakpoint = break point
stack trace
traceback = trace back
API
SDK
CLI
IDE

# —— 数据结构与代码元素 ——
array = 阿瑞
map = 麦普
dict = 迪克特
string = 斯纯, 斯琼
float = 弗洛特
struct = 斯卓克特
interface = 因特菲斯
props = 普拉普斯
hook = 胡克
getter
setter
namespace = name space
iterator

# —— 测试与质量 ——
unit test
mock = 毛克, 莫克
benchmark = bench mark
profiler
coverage
E2E
QA
lint
pytest = py test
Jest = 杰斯特
JUnit = j unit
Selenium = 塞勒尼姆
Playwright = play wright, 普雷莱特
Cypress = 赛普瑞斯

# —— AI 与大模型 ——
AI
LLM
GPT
ChatGPT = chat GPT, 拆特GPT
Claude = 克劳德, 可劳德
Claude Code = 克劳德扣的
Anthropic = 安斯若匹克
OpenAI = open AI, 欧喷AI
Qwen = q wen
DeepSeek = 迪普西克, deep seek
Kimi = 基米, 奇米
GLM
Gemini = 杰米尼
Llama = 拉玛
Mistral = 米斯特拉尔
Hugging Face
ModelScope = model scope
prompt = 普朗普特, 普罗姆特, 普朗特
embedding = 埃姆贝丁
RAG
agent = 艾真特, 艾吉特
MCP
fine-tune = fine tune
LoRA = 劳拉, 萝拉
SFT
RLHF
Transformer
inference
temperature
ASR
TTS
OCR
NLP
Stable Diffusion
ComfyUI = comfy UI, 康飞UI
Ollama = 欧拉玛, 奥拉玛
vLLM
LangChain = lang chain
Dify = 迪法伊
Cursor = 克瑟
Copilot = 扣派拉特, co pilot
Codex = 扣带克斯
Whisper = 维斯珀
CUDA = 库达, 酷达
ROCm
GPU
NVIDIA = 恩维迪亚

# —— 办公与项目管理 ——
PPT
Excel = 艾克塞尔, 伊克赛尔
Word
PDF
OA
ERP
CRM
KPI
OKR
PRD
UI
UX
PM
SRE
DevOps = dev ops
MVP
ROI
SaaS = 萨斯
Jira = 吉拉, 基拉
Confluence = 康弗鲁恩斯
Notion
Figma = 菲格玛, 飞格玛
Axure
Outlook
Visio
follow up
offer

# —— 游戏与引擎 ——
Unreal Engine
UE5
UE4
蓝图 = 兰图, 拦图
Blueprint = blue print
Niagara = 尼亚加拉, 尼加拉
Lumen = 路们, 卢门, 鲁门
Nanite = 纳奈特, 那奈特, 纳耐特
Actor = 艾克特, 阿克特
Pawn = 泡恩
PlayerController = player controller
GameMode = game mode
GameState = game state
HUD
Widget = 威杰特, 维吉特
UMG
Slate = 斯雷特
Shader = 谢德, 筛德
Mesh = 麦什, 美什
Static Mesh
Skeletal Mesh
Sequencer
Tick = 提克
PIE
Subsystem = sub system
Gameplay Ability System
Enhanced Input
MetaHuman = meta human
World Partition
DataTable = data table
Render Target
Post Process
NavMesh = nav mesh
Behavior Tree
Blackboard = black board
Dedicated Server
LOD
Draw Call
Unity = 优尼提, 尤尼提
Prefab = 普瑞法布
ScriptableObject = scriptable object
Godot = 戈多
Rider = 莱德, 赖德
Visual Studio
VS Code = VS扣的
DirectX = direct x
Vulkan = 沃尔坎, 瓦尔坎
OpenGL = open GL
DLSS
RTX

# —— 常被听错的中文技术词 ——
服务器 = 雾气, 巫启, 无启, 误气, 服务期
复现 = 负线, 腹泻, 富线, 复线
日志 = 日至, 日制
新增 = 心中, 新正
提醒 = 题型, 提型
接口 = 街口, 接扣
字段 = 自断, 字断, 子段
数组 = 竖组, 树组, 数阻
函数 = 含数
参数 = 残数, 惨数
变量 = 便量
回滚 = 回棍, 灰滚
部署 = 布署
灰度 = 恢度, 回度
压测 = 押策, 压侧, 鸭测
埋点 = 麦点
鉴权 = 见全, 建权
回调 = 回掉
缓存 = 换存, 环存
索引 = 所引, 锁引
主键 = 主建
外键 = 外件, 外建
死锁 = 死所, 死索
内存 = 内村
显存 = 线存
空指针 = 空纸针, 空职针
断点 = 短点
堆栈 = 堆站
熔断 = 容断, 融断
限流 = 现流, 线流
容器 = 荣器
镜像 = 镜相, 静像
集群 = 急群
负载均衡 = 负债均衡, 付载均衡
中间件 = 中间键
分布式 = 分步式
联调 = 连调, 联条
提测 = 题测, 提侧
迭代 = 叠代
重构 = 重够, 冲够
迁移 = 牵一
发版 = 发板
周报 = 粥报, 周豹
复盘 = 腹盘, 副盘
颗粒度 = 颗粒肚
脚本 = 角本
调试 = 条试, 掉试
依赖 = 一赖
报错 = 爆错
序列化 = 序列话
反序列化 = 反序列话
哈希 = 哈西, 哈息
递归 = 地归, 递规
指针 = 纸针, 职针
断言 = 段言
单元测试 = 单元侧试
冒烟测试 = 冒烟侧试
密钥 = 秘钥, 蜜钥
证书 = 正书
域名 = 遇名, 欲名
端口 = 短口, 端扣
带宽 = 待宽
吞吐 = 吞土
串行 = 窜行
正则 = 正泽
会议纪要 = 会议记要
`;
  const BASE = Object.freeze(parseText(BASE_TEXT).entries.map(e => Object.freeze({ term: e.term, heard: Object.freeze(e.heard.slice()) })));

  // ── 挑词 ───────────────────────────────────────────────────────────────────────────────────────────
  // 英文按词边界、不分大小写找(样子里的空格当「可有可无的空白」:git hub 也认 GitHub、GITHUB);中文直接找子串(不分大小写,
  // 兼顾「C加加」这种中英混写的样子)。
  // 返回的判定函数收 (原文, 原文的小写) 两份,小写只在 pick 里算一次。
  function finder(s) {
    if (isLatin(s)) {
      const re = new RegExp('(?:^|[^A-Za-z0-9])' + escapeRe(s).replace(/ +/g, '\\s*') + '(?![A-Za-z0-9])', 'i');
      return hay => re.test(hay);
    }
    const low = s.toLowerCase();
    return (hay, hayLow) => hayLow.includes(low);
  }
  // 原厂词的「英文写法不对」只对写法特殊的词生效(词中间有大写:GitHub、macOS、PostgreSQL、LoRA)——
  // Word、Express、Spring 这类普通英文词按大小写去「纠正」只会招来误改。
  const specialCasing = term => isLatin(term) && /[a-z0-9]/.test(term) && /.[A-Z]/.test(term);
  const BASE_FINDERS = BASE.map(b => ({ b, heard: b.heard.map(h => ({ h, find: finder(h) })), casing: specialCasing(b.term) ? finder(b.term) : null }));

  // 一个词这一句里命中了哪些错听样子(按词表里的顺序)。
  const hitsOf = (finders, hay, hayLow) => finders.filter(x => x.find(hay, hayLow)).map(x => x.h);
  const orderHeard = (heard, hits) => [...hits, ...heard.filter(h => !hits.includes(h))];

  // 返回 [{ term, heard, src:'user'|'base', hit }],hit = 这一句里有它的错听样子(或英文大小写不对)。
  // 个人词:全带(最多 PICK_USER_MAX 个),命中的排前面,其次被改得多的(第二步的 n),再次原顺序。
  // 从打过的字里抽来的英文词(src:'typed')不全带,只在这一句命中时带 —— 它们多是项目名/产品名的正经写法,数量可能不少,
  // 全带会把手加的、从改字里学来的词挤出上限。
  // 原厂词:总开关开着、且这一句命中时才带(最多 PICK_BASE_MAX 个);已经正确写出来的不带;与个人词同名的让给个人词。
  // text 为空(整段识别前、开实时识别会话时还没有字)= 只带个人词。
  // (参数用一个对象收、按属性读:模块依赖图的扫描器认不全解构默认值里的局部绑定,同名的 text 会被当成 00-boot 的 text())
  function pick(opts = {}) {
    const { state = null, userMax = PICK_USER_MAX, baseMax = PICK_BASE_MAX } = opts;
    const hay = String(opts.text || '');
    const hayLow = hay.toLowerCase();
    const s = sanitizeState(state || defaultState());
    const out = [], taken = new Set();
    const user = Object.values(s.terms).filter(t => !t.off).map((t, i) => {
      const hits = hay ? hitsOf(t.heard.map(h => ({ h, find: finder(h) })), hay, hayLow) : [];
      const casing = Boolean(hay) && isLatin(t.term) && !hay.includes(t.term) && finder(t.term)(hay, hayLow);
      return { t, i, hits, hit: hits.length > 0 || casing };
    }).filter(u => u.t.src !== 'typed' || u.hit);
    user.sort((a, b) => (Number(b.hit) - Number(a.hit)) || (b.t.n - a.t.n) || (a.i - b.i));
    for (const u of user.slice(0, Math.max(0, userMax))) {
      out.push({ term: u.t.term, heard: orderHeard(u.t.heard, u.hits), src: 'user', hit: u.hit });
      taken.add(u.t.term.toLowerCase());
    }
    if (s.base && hay) {
      let n = 0;
      for (const { b, heard, casing } of BASE_FINDERS) {
        if (n >= baseMax) break;
        if (taken.has(b.term.toLowerCase()) || hay.includes(b.term)) continue;
        const hits = hitsOf(heard, hay, hayLow);
        if (!hits.length && !(casing && casing(hay, hayLow))) continue;
        out.push({ term: b.term, heard: orderHeard(b.heard, hits), src: 'base', hit: true });
        taken.add(b.term.toLowerCase());
        n += 1;
      }
    }
    return out;
  }

  // ── 三处识别口的形状 ───────────────────────────────────────────────────────────────────────────────
  // 大模型改字:<glossary> 里一行一个词,「词 ← 样子1、样子2」(样子最多 GLOSSARY_HEARD_MAX 个)。
  function glossaryLines(picked) {
    return (Array.isArray(picked) ? picked : []).map(p => (p.heard && p.heard.length ? p.term + ' ← ' + p.heard.slice(0, GLOSSARY_HEARD_MAX).join('、') : p.term));
  }
  // 整段识别的 prompt:只列词(不列错听样子 —— 那是给识别模型「别往那边靠」的反面教材),命中的在前,总长 ≤ PROMPT_MAX_CHARS。
  // Qwen3-ASR 把它当系统提示里的上下文/热词;Whisper 形端点把它当前文,列词同样能把拼写往这边带。
  function asrPrompt(picked) {
    const list = Array.isArray(picked) ? picked : [];
    const ordered = [...list.filter(p => p.hit), ...list.filter(p => !p.hit)];
    let out = '';
    for (const p of ordered) {
      const next = out ? out + ', ' + p.term : p.term;
      if (next.length > PROMPT_MAX_CHARS) break;
      out = next;
    }
    return out;
  }
  // 实时识别的会话热词:只给个人词(原厂通用词当热词几乎没用,52 号文 §2);太短的不给(单字热词在流式第一遍里容易被硬插);
  // 从打过的字里抽来的英文词不给(那是写法,不是常说的话)。
  function hotwords(state) {
    const list = activeTerms(state).filter(t => t.src !== 'typed').map((t, i) => ({ t, i }));
    list.sort((a, b) => (b.t.n - a.t.n) || (a.i - b.i));
    const out = [];
    for (const { t } of list) {
      if (out.length >= HOTWORDS_MAX) break;
      if (t.term.replace(/[^\p{L}\p{N}]/gu, '').length < 2) continue;
      out.push(t.term);
    }
    return out;
  }

  // 设置页读的视图:个人词那份文本(停用墓碑不出现)、计数、原厂表开关与条数;withBase 时附原厂表全文(只读展示)。
  function view(state, { withBase = false } = {}) {
    const s = sanitizeState(state);
    const active = Object.values(s.terms).filter(t => !t.off);
    return {
      text: formatText(active),
      count: active.length,
      learned: active.filter(t => t.src === 'learned').length,
      typed: active.filter(t => t.src === 'typed').length,
      pending: Object.keys(s.pending).length,
      learn: s.learn,
      base: { enabled: s.base, count: BASE.length, ...(withBase ? { text: BASE_TEXT.trim() } : {}) },
      limits: { maxTerms: MAX_TERMS, maxTermChars: MAX_TERM_CHARS, maxHeard: MAX_HEARD, maxTextChars: MAX_TEXT_CHARS },
    };
  }

  return Object.freeze({
    SCHEMA, MAX_TERMS, MAX_TERM_CHARS, MAX_HEARD, MAX_HEARD_CHARS, MAX_TEXT_CHARS, PICK_USER_MAX, PICK_BASE_MAX, PROMPT_MAX_CHARS, HOTWORDS_MAX, MAX_PENDING,
    BASE, BASE_TEXT,
    clean, addHeard, parseText, formatText, defaultState, sanitizeState, applyText, setBase, setLearn, activeTerms,
    pick, glossaryLines, asrPrompt, hotwords, view,
  });
})();
