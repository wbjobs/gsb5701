# 实时听写（Speech Dictation）

纯前端实时语音听写应用：DOM + SpeechRecognition API + Clipboard API + IndexedDB，无构建依赖。

## 运行

需要通过 HTTP(S) 或 localhost 访问（麦克风权限要求安全上下文）：

```bash
cd 本目录
python3 -m http.server 8000
# 打开 http://localhost:8000 （推荐 Chrome / Edge）
```

## 功能与验收标准对应

| 验收标准 | 实现 |
| --- | --- |
| 实时听写 | `continuous: true` + `interimResults: true`，结果实时渲染 |
| 临时/最终结果合并不重复 | 最终结果追加为独立分段，临时结果仅渲染在独立 `<span>`，互相不并入 |
| 开始 / 停止 / 清空 / 复制 | 工具栏按钮；复制用 Clipboard API，`execCommand` 兜底 |
| 权限被拒提示 | `not-allowed` / `service-not-allowed` 错误显示引导横幅 |
| 识别中断自动重启 | `onend` 中按用户意图自动重启，退避 0→5s；`network` 错误提示并自动恢复 |
| 30 分钟长时听写 | 连续识别 + 中断自动重启覆盖浏览器静音超时/内部停止，会话计时显示 |
| 中英文切换 | zh-CN / en-US 切换；听写中切换会以新语言自动重启识别 |
| 标点自动补全 | 简单规则：句末补句号（中文 `。` / 英文 `.`），逗号结尾升级为句号，英文首字母大写 |
| 结果分段 | 每个最终结果渲染为独立段落 |
| 历史可恢复 | IndexedDB 保存会话（停止/页面隐藏时落盘），点击历史项恢复到听写区，可单删/清空 |
| 浏览器不支持 | 特性检测，显示不支持横幅并禁用按钮 |

## 文件

- `index.html` — 页面结构
- `styles.css` — 样式
- `app.js` — 识别控制、状态机、IndexedDB、剪贴板逻辑
