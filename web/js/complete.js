// 补全数据库 + 符号索引
import { KEYWORDS, TYPES } from './hl.js';

// label|签名|说明|kind(fn/ty/mem/sn/kw)
const RAW = [
  // ── stdio ──
  'printf|int printf(const char *format, ...)|格式化输出到 stdout|fn',
  'fprintf|int fprintf(FILE *stream, const char *format, ...)|格式化输出到文件流|fn',
  'sprintf|int sprintf(char *str, const char *format, ...)|格式化写入字符串|fn',
  'snprintf|int snprintf(char *str, size_t size, const char *format, ...)|安全格式化写入字符串|fn',
  'scanf|int scanf(const char *format, ...)|从 stdin 读取格式化输入|fn',
  'sscanf|int sscanf(const char *str, const char *format, ...)|从字符串解析|fn',
  'fscanf|int fscanf(FILE *stream, const char *format, ...)|从文件流读取|fn',
  'puts|int puts(const char *s)|输出字符串并换行|fn',
  'putchar|int putchar(int c)|输出单个字符|fn',
  'getchar|int getchar(void)|读取单个字符|fn',
  'fgets|char *fgets(char *s, int size, FILE *stream)|读取一行|fn',
  'fputs|int fputs(const char *s, FILE *stream)|写入字符串|fn',
  'fopen|FILE *fopen(const char *path, const char *mode)|打开文件|fn',
  'fclose|int fclose(FILE *stream)|关闭文件|fn',
  'fread|size_t fread(void *ptr, size_t size, size_t n, FILE *stream)|读二进制|fn',
  'fwrite|size_t fwrite(const void *ptr, size_t size, size_t n, FILE *stream)|写二进制|fn',
  'fflush|int fflush(FILE *stream)|刷新缓冲区|fn',
  'perror|void perror(const char *s)|输出错误信息|fn',
  // ── stdlib ──
  'malloc|void *malloc(size_t size)|分配堆内存|fn',
  'calloc|void *calloc(size_t n, size_t size)|分配并清零|fn',
  'realloc|void *realloc(void *ptr, size_t size)|调整内存大小|fn',
  'free|void free(void *ptr)|释放内存|fn',
  'exit|void exit(int status)|退出程序|fn',
  'atoi|int atoi(const char *s)|字符串转整数|fn',
  'atof|double atof(const char *s)|字符串转浮点|fn',
  'strtol|long strtol(const char *s, char **end, int base)|字符串转长整数|fn',
  'strtod|double strtod(const char *s, char **end)|字符串转浮点|fn',
  'qsort|void qsort(void *base, size_t n, size_t size, int (*cmp)(const void*, const void*))|快速排序|fn',
  'rand|int rand(void)|伪随机数|fn',
  'srand|void srand(unsigned seed)|设置随机种子|fn',
  'abs|int abs(int x)|整数绝对值|fn',
  'system|int system(const char *cmd)|执行系统命令（沙箱内不可用）|fn',
  // ── string.h ──
  'strlen|size_t strlen(const char *s)|字符串长度|fn',
  'strcpy|char *strcpy(char *dst, const char *src)|复制字符串|fn',
  'strncpy|char *strncpy(char *dst, const char *src, size_t n)|定长复制|fn',
  'strcat|char *strcat(char *dst, const char *src)|拼接字符串|fn',
  'strcmp|int strcmp(const char *a, const char *b)|比较字符串|fn',
  'strncmp|int strncmp(const char *a, const char *b, size_t n)|比较前 n 字符|fn',
  'strchr|char *strchr(const char *s, int c)|查找字符首次出现|fn',
  'strstr|char *strstr(const char *hay, const char *needle)|查找子串|fn',
  'strtok|char *strtok(char *s, const char *delim)|按分隔符切分|fn',
  'memset|void *memset(void *s, int c, size_t n)|填充内存|fn',
  'memcpy|void *memcpy(void *dst, const void *src, size_t n)|复制内存|fn',
  'memmove|void *memmove(void *dst, const void *src, size_t n)|安全重叠复制|fn',
  'memcmp|int memcmp(const void *a, const void *b, size_t n)|比较内存|fn',
  // ── math.h ──
  'sqrt|double sqrt(double x)|平方根|fn',
  'pow|double pow(double x, double y)|幂运算|fn',
  'fabs|double fabs(double x)|浮点绝对值|fn',
  'floor|double floor(double x)|向下取整|fn',
  'ceil|double ceil(double x)|向上取整|fn',
  'round|double round(double x)|四舍五入|fn',
  'sin|double sin(double x)|正弦|fn',
  'cos|double cos(double x)|余弦|fn',
  'tan|double tan(double x)|正切|fn',
  'log|double log(double x)|自然对数|fn',
  'log2|double log2(double x)|以 2 为底对数|fn',
  'log10|double log10(double x)|以 10 为底对数|fn',
  'exp|double exp(double x)|e 的 x 次幂|fn',
  'fmod|double fmod(double x, double y)|浮点取余|fn',
  'hypot|double hypot(double x, double y)|直角三角形斜边|fn',
  // ── ctype ──
  'isalpha|int isalpha(int c)|是否字母|fn',
  'isdigit|int isdigit(int c)|是否数字|fn',
  'isalnum|int isalnum(int c)|是否字母或数字|fn',
  'isspace|int isspace(int c)|是否空白|fn',
  'isupper|int isupper(int c)|是否大写|fn',
  'islower|int islower(int c)|是否小写|fn',
  'toupper|int toupper(int c)|转大写|fn',
  'tolower|int tolower(int c)|转小写|fn',
  // ── time.h ──
  'time|time_t time(time_t *t)|当前时间戳|fn',
  'clock|clock_t clock(void)|进程 CPU 时间|fn',
  'localtime|struct tm *localtime(const time_t *t)|本地时间结构|fn',
  'strftime|size_t strftime(char *buf, size_t n, const char *fmt, const struct tm *tm)|格式化时间|fn',
  'difftime|double difftime(time_t a, time_t b)|时间差|fn',
  // ── C++ 流与字符串 ──
  'std::cout|std::ostream &operator<<(...)|标准输出流|mem',
  'std::cin|std::istream &operator>>(...)|标准输入流|mem',
  'std::cerr|std::ostream &operator<<(...)|标准错误流|mem',
  'std::endl|std::ostream &endl(std::ostream &)|换行并刷新|mem',
  'std::string|std::string s = "..."|可变长字符串|ty',
  'std::getline|std::istream &getline(std::istream &is, std::string &s)|读取整行|fn',
  'std::stoi|int std::stoi(const std::string &s)|字符串转 int|fn',
  'std::stoll|long long std::stoll(const std::string &s)|字符串转 long long|fn',
  'std::stod|double std::stod(const std::string &s)|字符串转 double|fn',
  'std::to_string|std::string std::to_string(int v)|数值转字符串|fn',
  'std::vector|std::vector<int> v;|动态数组|ty',
  'std::map|std::map<K, V> m;|有序键值表|ty',
  'std::set|std::set<T> s;|有序集合|ty',
  'std::unordered_map|std::unordered_map<K, V> m;|哈希表|ty',
  'std::pair|std::pair<A, B> p;|二元组|ty',
  'std::make_pair|std::pair<T,U> std::make_pair(T a, U b)|构造二元组|fn',
  'std::array|std::array<T, N> a;|定长数组|ty',
  'std::deque|std::deque<T> d;|双端队列|ty',
  'std::queue|std::queue<T> q;|队列|ty',
  'std::stack|std::stack<T> s;|栈|ty',
  'std::priority_queue|std::priority_queue<T> pq;|优先队列（大根堆）|ty',
  'std::tuple|std::tuple<A, B, C> t;|多元组|ty',
  'std::sort|void std::sort(It first, It last[, Cmp cmp])|排序区间|fn',
  'std::stable_sort|void std::stable_sort(It first, It last)|稳定排序|fn',
  'std::reverse|void std::reverse(It first, It last)|反转区间|fn',
  'std::find|It std::find(It first, It last, const T &v)|查找元素|fn',
  'std::max|const T &std::max(const T &a, const T &b)|较大值|fn',
  'std::min|const T &std::min(const T &a, const T &b)|较小值|fn',
  'std::swap|void std::swap(T &a, T &b)|交换|fn',
  'std::abs|int std::abs(int x)|绝对值|fn',
  'std::accumulate|T std::accumulate(It first, It last, T init)|求和|fn',
  'std::unique|It std::unique(It first, It last)|去相邻重复|fn',
  'std::lower_bound|It std::lower_bound(It first, It last, const T &v)|二分下界|fn',
  'std::upper_bound|It std::upper_bound(It first, It last, const T &v)|二分上界|fn',
  'std::binary_search|bool std::binary_search(It first, It last, const T &v)|二分查找|fn',
  'std::make_unique|std::unique_ptr<T> std::make_unique<Args...>(Args &&...)|创建独占指针|fn',
  'std::move|std::remove_reference_t<T> &&std::move(T &&t)|转移语义|fn',
  'std::function|std::function<R(Args...)> f;|通用可调用包装|ty',
  'std::stringstream|std::stringstream ss;|字符串流|ty',
  'std::numeric_limits|std::numeric_limits<int>::max()|类型极值|ty',
  // ── 常用成员 ──
  'push_back|push_back(const T &v)|尾部插入|mem',
  'pop_back|pop_back()|删除尾部元素|mem',
  'emplace_back|emplace_back(Args &&...args)|原位构造插入|mem',
  'size|size()|元素个数|mem',
  'empty|empty()|是否为空|mem',
  'clear|clear()|清空|mem',
  'begin|begin()|首迭代器|mem',
  'end|end()|尾后迭代器|mem',
  'front|front()|首元素|mem',
  'back|back()|尾元素|mem',
  'insert|insert(...)|插入元素|mem',
  'erase|erase(...)|删除元素|mem',
  'count|count(const T &v)|出现次数|mem',
  'at|at(size_t i)|越界检查访问|mem',
  'substr|substr(size_t pos, size_t len)|取子串|mem',
  'c_str|c_str()|C 风格字符串指针|mem',
  'length|length()|字符串长度|mem',
  'resize|resize(size_t n)|调整大小|mem',
  'child::{placeholder}|x|x|kw',
  // ── 代码片段 ──
  'main|int main(int argc, char **argv) { ... }|程序入口|sn',
  'fori|for (int i = 0; i < n; i++) { ... }|计数循环|sn',
  'fore|for (auto &x : v) { ... }|范围 for|sn',
  'while|while (cond) { ... }|while 循环|sn',
  'if|if (cond) { ... }|条件分支|sn',
  'switch|switch (x) { case 1: break; default: break; }|多路分支|sn',
  'struct|struct Name { ... };|结构体|sn',
  'class|class Name { public: ... };|类|sn',
  'vec|std::vector<int> v;|向量声明|sn',
  'readall|while (std::cin >> x) { ... }|读入直到结束|sn',
];

const DB = [];
const MAP = new Map();
for (const line of RAW) {
  const [label, sig, doc, kind] = line.split('|');
  if (!label || label.startsWith('child::')) continue;
  const item = { label, kind: kind || 'fn', sig: sig || '', doc: doc || '' };
  DB.push(item);
  if (!MAP.has(label)) MAP.set(label, item);
}
for (const k of KEYWORDS) DB.push({ label: k, kind: 'kw', sig: '', doc: '关键字' });
for (const t of TYPES) DB.push({ label: t, kind: 'ty', sig: '', doc: '类型/标识符' });

const SNIPPETS = {
  'fori': 'for (int i = 0; i < n; i++) {\n    $0\n}',
  'fore': 'for (auto &x : v) {\n    $0\n}',
  'while': 'while (cond) {\n    $0\n}',
  'if': 'if (cond) {\n    $0\n}',
  'switch': 'switch (x) {\ncase 1:\n    break;\ndefault:\n    break;\n}',
  'struct': 'struct Name {\n    $0\n};',
  'class': 'class Name {\npublic:\n    $0\n};',
  'main': 'int main(int argc, char **argv) {\n    $0\n    return 0;\n}',
  'vec': 'std::vector<int> v;',
  'readall': 'while (std::cin >> x) {\n    $0\n}'
};

export function lookup(label) {
  return MAP.get(label) || null;
}

export function suggestions(prefix, symbols, memberMode) {
  const p = (prefix || '').toLowerCase();
  const out = [];
  const seen = new Set();
  const push = (it, score) => {
    if (seen.has(it.label)) return;
    seen.add(it.label);
    out.push({ ...it, score });
  };
  for (const s of symbols || []) {
    const l = s.label.toLowerCase();
    if (!p || l.startsWith(p)) push(s, l === p ? 0 : 1);
  }
  for (const it of DB) {
    const l = it.label.toLowerCase();
    if (memberMode && it.kind !== 'mem' && it.kind !== 'kw') continue;
    if (p && !l.startsWith(p) && !l.includes(p)) continue;
    push(it, l === p ? 2 : l.startsWith(p) ? 4 : 5);
  }
  out.sort((a, b) => a.score - b.score || a.label.length - b.label.length || a.label.localeCompare(b.label));
  return out.slice(0, 60);
}

export function snippetFor(label) {
  return SNIPPETS[label] || null;
}

// 从源码中提取本地符号：函数、类/结构体、#define、变量
export function extractSymbols(code) {
  const out = [];
  const seen = new Set();
  const add = (label, kind, detail) => {
    if (!label || seen.has(label) || label.length < 2) return;
    seen.add(label);
    out.push({ label, kind, sig: detail || '', doc: '当前文件' });
  };
  let m;
  const reDef = /^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)/gm;
  while ((m = reDef.exec(code))) add(m[1], 'sym', '#define');
  const reType = /\b(?:struct|class|enum|union)\s+([A-Za-z_]\w*)/g;
  while ((m = reType.exec(code))) add(m[1], 'ty', '类型');
  const reFn = /^[ \t]*(?:template\s*<[^>]*>\s*)?(?:[A-Za-z_][\w:<>,*&\s\[\]]*?\s+)?([A-Za-z_]\w*)\s*\(([^;{)]*)\)\s*(?:const\s*)?\{/gm;
  while ((m = reFn.exec(code))) {
    if (['if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'do'].includes(m[1])) continue;
    add(m[1], 'fn', '(' + m[2].replace(/\s+/g, ' ').trim() + ')');
  }
  const reVar = /\b(?:int|char|float|double|long|short|bool|size_t|unsigned|std::string|std::vector<[^>]*>|auto)\s+([A-Za-z_]\w*)\s*[=;,\[)]/g;
  while ((m = reVar.exec(code))) add(m[1], 'sym', '变量');
  return out;
}
