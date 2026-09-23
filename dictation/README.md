# 实时听写（Speech Dictation）

基于浏览器原生 `SpeechRecognition` API 的实时语音听写工具，纯静态页面，无构建依赖。

## 运行

需要通过 HTTP(S) 或 localhost 访问（麦克风权限要求安全上下文）：

```bash
cd dictation
python3 -m http.server 8000
# 打开 http://localhost:8000
```

推荐 Chrome / Edge 最新版。首次使用需允许麦克风权限。

## 功能

- **开始 / 停止 / 清空 / 复制**：复制使用 Clipboard API，失败时自动降级到 `execCommand`
- **连续识别 + 临时结果**：`continuous: true`、`interimResults: true`，临时结果灰色显示，确认后转为正式文本
- **中英文切换**：zh-CN / en-US，听写中切换会无缝重启识别会话应用新语言
- **长时听写**：单次上限 30 分钟自动停止并保存；浏览器单次识别会话约 1 分钟会自动结束，`onend` 中以指数退避（0.5s→10s 封顶）自动重启，状态栏显示重连次数
- **自动标点（简单规则）**：中文句末缺标点补「。」；英文首字母大写、句末补「.」
- **自动分段**：相邻最终结果间隔超过 2.5 秒视为新段落
- **历史记录**：IndexedDB 存储（`dictation-db/sessions`），听写中每 5 秒自动保存防丢失，支持恢复、复制、删除

## 异常处理

| 场景 | 行为 |
|---|---|
| 浏览器不支持 | 禁用开始按钮并提示使用 Chrome/Edge |
| 权限被拒 (`not-allowed`) | 红色横幅提示开启麦克风权限，停止会话 |
| 网络中断 (`network`) | 提示并保持听写状态，自动重连 |
| 无麦克风 (`audio-capture`) | 提示检查设备，停止会话 |
| 识别中断 (`onend`) | 指数退避自动重启，直到 30 分钟上限 |

## 文件

- `index.html` — 页面结构
- `style.css` — 样式
- `app.js` — 识别控制、状态机、IndexedDB、UI 逻辑
