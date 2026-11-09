# 与你有源 · 管理台

管理 [ynyy0/ynyy0.github.io](https://github.com/ynyy0/ynyy0.github.io) 的手机端控制台（纯静态，无后端），界面参照 Sileo 的「分类 / 软件包」列表。

在线地址：<https://ynyy0.github.io/jb-repo-manager/>

## 界面

- **目录页**：每行显示目录名、插件数、文件数与箭头；点行进入，点 `⋯` 管理目录
- **插件页**：每个插件一行，左侧 52px 圆角图标，右侧显示名称、版本 / 分类 / 体积、两行描述，最右 `⋯` 打开操作面板
- 顶部搜索框、返回、右上角 `+`；底部固定四个标签：目录 / 全部插件 / 待提交 / 连接
- 按手机宽度设计，桌面预览时居中为 480px 宽的模拟屏

## 功能

| 位置 | 操作 |
|---|---|
| 目录页 `+` 或目录 `⋯` | 新建目录（写入 `.gitkeep` 占位） |
| 目录 `⋯` | 重命名目录（批量移动其下全部文件）、在此上传插件、粘贴插件、删除目录（需输入目录名确认） |
| 插件页 `+` | 上传 `.deb`（可多选）到当前目录，默认 `debs/` |
| 插件 `⋯` | **改名**、**改图标**、**复制**、**剪切**、**移动到…**、**粘贴到此目录**、**删除** |
| 待提交 | 所有改动逐项可撤销，一键清空或合并为一次原子提交 |

- 删除 `debs/` 下的插件会把 `icons/{包名}.png` 一起加入待删除，可单独撤销
- 复制/剪切使用页面内剪贴板；**复制**用已有 blob sha 生成副本，不重新上传文件
- 所有改动先进入待提交列表，提交后源仓库的 `release.yml` 刷新索引、`deploy-pages.yml` 自动部署

## 显示名与图标为什么能持久

源仓库新增了 `repo-meta.json`（结构 `{"plugins":{"包名":{"name":"...","description":"..."}}}`），`.github/scripts/build_index.py` 生成索引时用它覆盖 `Name` / `Description`，优先级最高。管理台改名字就是改这个文件，所以不会被每次重新扫描 deb 覆盖。

改图标直接替换 `icons/{包名}.png`，索引脚本按包名自动引用，无需改元数据。

## 首次使用

1. 打开 <https://ynyy0.github.io/jb-repo-manager/>
2. 生成 [fine-grained PAT](https://github.com/settings/personal-access-tokens)：Resource owner `ynyy0`，只选仓库 `ynyy0.github.io`，权限 **Contents: Read and Write**
3. 粘贴 Token 点「连接」。勾选「记住这台设备」存 localStorage，否则仅本次会话；随时可在「连接」页断开

Token 只在本机浏览器使用，直发 `api.github.com`，不写进仓库、不经过第三方。

## 提交失败：`403 Resource not accessible by personal access token`

含义是 **Token 能读、不能写**（插件列表能加载，一点提交就 403）。修复：

- **fine-grained PAT**：Resource owner 必须是 `ynyy0`；Repository access 选 **Only select repositories** 并勾选 **`ynyy0.github.io`**（不是 `jb-repo-manager`）；Repository permissions 里 **Contents = Read and Write**
- **classic PAT**：直接勾 `repo` scope 最省事
- 生成后回「连接」页点 **断开**，再粘贴新 Token 重新连接（旧 Token 存在浏览器里，不换不会生效）；待提交改动不会丢，回来重新点提交即可

「连接」页和提交失败卡片里都有 **权限自检** 按钮，会逐项测试身份 / 仓库可见 / 读分支 / 写 blob，直接指出缺哪一项。写 blob 用的是一个空内容 blob，不会改动仓库。

其他错误码：401 = Token 无效或过期；409 = 期间有自动索引提交，点「刷新仓库」后重试。

## 数据与限制

- 插件信息来源：仓库文件树（所有 `.deb`）＋ `Packages` 索引（名称、版本、描述、分类）＋ `repo-meta.json`（覆盖），图标走 `raw.githubusercontent.com` 实时显示
- 单文件建议 ≤ 50 MB（GitHub blob API 上限 100 MB）
- 只有 `debs/` 下的插件会被 `dpkg-scanpackages -m debs` 收录；移到别的目录的插件在管理台仍可见，但不会出现在 APT 索引里
- 重命名 `debs/` 会让整个源索引失效
- 若提交返回 409，说明期间有 workflow 的自动提交，回「连接」页点「刷新仓库」后重试
