# plugins/ —— 插件文件夹

每个**子文件夹**就是一个插件，文件夹里放一份 `plugin.json` 清单。
应用启动时自动扫描：清单合法的自定义子弹会注册进解析器（界面图例、统计条、按钮全跟上）；
清单坏掉/非法的插件不加载，也不影响其它插件。

本文件夹里已有一个官方示例：`example-progress/`（「进行中」子弹，`◐ 日记` 或 `- [p] 目标`）。

## 亲手做一个

```text
plugins/
  my-plugin/          ← 文件夹名随意（英文+连字符最稳）
    plugin.json       ← 清单（见下面字段说明）
```

`plugin.json` 最小样例：

```json
{
  "id": "my-plugin",
  "name": "我的插件",
  "bullets": [
    {
      "kind": "reading",
      "marks": ["r"],
      "glyph": "📖",
      "label": "阅读",
      "color": "#7ac74f"
    }
  ]
}
```

- **kind**：唯一 id（小写字母/数字/连字符，不能用 `total`/`progress`/内置八类）。
- **marks**：复选框写法，`- [r] 看第 3 章` → 阅读子弹；`!` 修饰符自动兼容（`- [r!]` 带优先）。
- **native**：可选，原生符号写法 `native: ["📖"]` → 不带短横线直接写 `📖 看第 3 章`。
- **glyph / label（必写）**：图例里显示的符号与名字。
- **cls / color / taskLike / symbol**：样式类（默认 `is-<kind>`）、颜色（写入 `--kind-<kind>` 变量）、
  能否「完成」（默认可以）、图例里的写法示例（默认按 marks/native 推）。

更多细节（限制、取消迁移的语义、样例清单、常见问题）见 **[docs/插件教程.md](../docs/插件教程.md)**。
