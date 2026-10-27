import { lintCpp } from '../web/js/lint.js';

let pass = 0, fail = 0;
const show = (it) => it.map((d) => d.line + ':' + d.severity[0] + ':' + d.message.replace(/[，,].*$/, '')).join(' | ') || '(空)';
const eq = (name, src, expect) => {
  const got = lintCpp(src);
  const lines = got.map((d) => d.line).join(',');
  const okk = lines === expect;
  if (okk) pass++; else fail++;
  console.log((okk ? 'ok  ' : 'FAIL') + ' ' + name + '  → ' + show(got) + (okk ? '' : '   期望行 ' + (expect || '(空)')));
};

// 干净的代码不该有提示
eq('正常代码', `#include <cstdio>

int main() {
    for (int i = 0; i < 3; i++) {
        printf("%d\\n", i);
    }
    return 0;
}
`, '');
eq('类 / 结构体', `struct Node {
    int id;
    double w;
};
class A : public Node {
public:
    A() : Node() {}
    void run() const;
};
`, '');
eq('多行条件与调用', `int main() {
    if (a &&
        b) {
        f(1,
          2);
    }
    std::cout << a
              << b;
}
`, '');
eq('预处理与宏', `#define MAX(a, b) ((a) > (b) ? (a) : (b))
#include <vector>
int main() {}
`, '');
eq('注释里的括号', `// 这里有 ( 没闭合
/* } 也不算 */
int main() { return 0; }
`, '');

// 应该报的
eq('缺分号', `int main() {
    int a = 1
    int b = 2;
    return 0;
}
`, '2');
eq('调用缺分号', `int main() {
    printf("hi")
    return 0;
}
`, '2');
eq('括号没闭合', `int main() {
    if (1) {
        f();
    return 0;
}
`, '1');
eq('多余右括号', `int main() {
    f());
}
`, '2,3');
eq('字符串没闭', `int main() {
    puts("hello);
}
`, '2');
eq('if 里赋值', `int main() {
    if (a = 1) return 0;
    return 0;
}
`, '2');
eq('漏分号 + 括号', `int main() {
    int a[] = {1, 2, 3}
    return 0
}
`, '2,3');

// 真实竞赛代码：不该有任何提示
eq('真实代码零误报', `#include <bits/stdc++.h>
using namespace std;

struct Edge {
    int to, w;
    bool operator<(const Edge &o) const {
        return w < o.w;
    }
};

const int N = 1e5 + 5;
vector<Edge> g[N];
long long dis[N];
bool vis[N];

int main() {
    int n, m, s;
    scanf("%d%d%d", &n, &m, &s);
    for (int i = 0; i < m; i++) {
        int u, v, w;
        scanf("%d%d%d", &u, &v, &w);
        g[u].push_back({v, w});
    }
    priority_queue<pair<long long, int>,
                   vector<pair<long long, int>>,
                   greater<pair<long long, int>>> pq;
    pq.push({0, s});
    dis[s] = 0;
    while (!pq.empty()) {
        auto [d, u] = pq.top();
        pq.pop();
        if (vis[u]) continue;
        vis[u] = true;
        for (auto &e : g[u]) {
            if (dis[e.to] > d + e.w) {
                dis[e.to] = d + e.w;
                pq.push({dis[e.to], e.to});
            }
        }
    }
    for (int i = 1; i <= n; i++) {
        printf("%lld\\n", dis[i] == 0 && i != s ? -1LL : dis[i]);
    }
    return 0;
}
`, '');

// 常见进阶写法也不该误报
eq('lambda / switch / 三目', `int main() {
    auto cmp = [](int a, int b) {
        return a > b;
    };
    int x = a > b ? 1 : 2;
    switch (x) {
        case 1:
            break;
        default:
            break;
    }
    int arr[] = {1, 2, 3};
    return arr[0] + x;
}
`, '');
eq('类内初始化与继承', `class Solution {
private:
    vector<int> v;
public:
    Solution() = default;
    explicit Solution(int n) : v(n, 0) {}
    int get() const { return v.size(); }
};
`, '');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
