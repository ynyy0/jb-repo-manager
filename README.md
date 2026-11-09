# 与你有源 · 管理台

管理 [ynyy0/ynyy0.github.io](https://github.com/ynyy0/ynyy0.github.io) 的手机端控制台（纯静态，无后端），界面参照 Sileo 的「分类 / 软件包」列表。

在线地址：<https://ynyy0.github.io/jb-repo-manager/>

## 两套「目录」

| | 目录页（tab「目录」） | 全部插件页（tab「全部插件」） |
|---|---|---|
| 是什么 | 仓库里**真实存在**的文件夹 | 插件的**分类分组**（来自 APT 索引 Section） |
| 层级 | 可逐级进入子目录，顶部 `‹` 返回上级 | 分类列表 → 点分类看该分类插件 |
| 改动 | 重命名 / 删除会移动 / 删除真实文件 | 只改归类记录，不动 deb 文件位置 |

- 目录页显示仓库所有目录（含 `.github/`、`icons/`、`debs/` 等）及其直属插件，`⋯` 可重命名目录、删除目录、**上传文件到此处**（不限文件类型）
- 目录页把**全部非 deb 文件**都列出来：`Packages`、`Packages.bz2/xz/zst`、`Release`、`index.html`、`README.md`、`repo-meta.json`、`.nojekyll` 等，显示类型与大小；点文件打开原文，`⋯` 可删除（带确认）。图片另以缩略图网格展示，点图看大图
- 目录页及其子页右上角 `+`：弹出选择 **上传文件（不限类型）** 或 **添加目录**；文件传到当前目录，目录写 `.gitkeep` 占位
- 全部插件页是分类目录列表，右上角 `+`：**添加目录**（新增分类分组）
- 分类行 `⋯`：**重命名目录**（该分类下插件一起改归类）、**删除目录**（插件归入「未分类」，不删 deb 文件）

## 插件操作

| 操作 | 行为 |
|---|---|
| 改名 / 描述 | 覆盖 APT 索引里的 Name / Description |
| 改图标 | 上传图片自动命名为 `icons/包标识符.png`（取 deb control 的真实 Package），重名直接替换 |
| 使用源图标 / 恢复插件图标 | 单个插件改用源图标 `CydiaIcon.png`，或恢复它自己的图标 |
| 移动到… | 目标 = 分类目录（只改归类，Section 同步更新）＋ 真实仓库目录（真的移动 deb 文件） |
| 删除 | 删除 deb，联动 `icons/{包名}.png`（可单独撤销） |

已移除「复制到…」「剪切到…」和「粘贴到此目录」，剪贴板机制一并去掉。

**「使用源图标」只对单个插件生效**（插件 `⋯` 里）：把这一个插件的图标换成源图标 `CydiaIcon.png`，再点会变成「恢复插件图标」。没有专属图标的插件本来就默认显示源图标。单插件的 `icon` 字段持久保存在 `repo-meta.json`，索引脚本按「单插件设置 > 本地图标 > 默认源图标」应用；**没有全局开关**，连接页里也不再有这项设置。

在**某个分类目录内**点右上角 `+` 上传插件，上传的 deb 默认归到该分类（文件仍写到 `debs/`，不影响 APT 索引）。

所有改动先进入「待提交」，逐项可撤销；确认后合并为一次原子提交（Git Data API：blob → tree → commit → ref），源仓库 `release.yml` 刷索引、`deploy-pages.yml` 自动部署。

## 数据为什么能持久

源仓库的 `repo-meta.json`：

```json
{
  "categories": ["微信插件", "系统美化"],
  "plugins": {
    "com.example.tweak": {
      "name": "自定义名称",
      "description": "自定义描述",
      "section": "微信插件",
      "cats": ["微信插件", "系统美化"]
    }
  }
}
```

`.github/scripts/build_index.py` 生成索引时用它覆盖 `Name` / `Description` / `Section`，优先级最高，所以改名和分类不会被每次重新扫描 deb 冲掉。`categories` 只用于管理台分组；不设置时自动按所有插件的 Section 去重生成。

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

「连接」页和提交失败卡片里都有 **权限自检** 按钮，会逐项测试身份 / 仓库可见 / 读分支 / 写 blob。写 blob 用的是空内容 blob，不会改动仓库。

其他错误码：401 = Token 无效或过期；409 = 期间有自动索引提交，点「刷新仓库」后重试。

## 数据与限制

- 插件信息来源：仓库文件树（所有 `.deb`）＋ `Packages` 索引（名称、版本、描述、分类）＋ `repo-meta.json`（覆盖），图标走 `raw.githubusercontent.com` 实时显示
- 单文件建议 ≤ 50 MB（GitHub blob API 上限 100 MB）
- 只有 `debs/` 下的插件会被 `dpkg-scanpackages -m debs` 收录；移出 `debs/` 的插件在管理台仍可见，但不会出现在 APT 索引里
- 重命名 / 删除 `debs/` 会让整个源索引失效
- 分类操作只改归类：删除分类不会删除 deb 文件

## 缓存与「没生效却显示」的处理

- **改动必须提交**：改名、归类、添加目录、改图标、上传都只进「待提交」。页面顶部有黄色状态条，插件卡片带「待提交」标记；只有提交成功写入仓库后才算生效，提交失败会明确提示「未生效，改动保留」。
- **不会用旧快照覆盖仓库**：浏览器只保存「未提交的改动（edits）」，仓库基线每次连接 / 刷新都重新读取。提交时会通过 API 读取 main 当前 `repo-meta.json`，再把本地改动合并进去，避免把别人的改动冲掉。
- **清除本地缓存**：「连接」页和「待提交」页都有按钮，会丢弃全部未提交改动并从仓库重新读取（Token 不受影响）。
- **静态资源版本化**：部署时把 commit sha 注入 `app.js?v=` / `style.css?v=`，每次更新浏览器自动拉新代码，不用手动强刷。
- **图标缓存**：索引里的 `Icon` 带图标内容哈希 `?v=`，换图后链接变化，Sileo / 浏览器不会拿旧图。
- **旧版会话状态**：v1 格式（整份 meta 快照）会被自动丢弃，防止历史缓存再次覆盖仓库数据。

## 删除操作的提示

删除插件、删除目录、删除分类目录、清空待提交、清除本地缓存都会先弹确认面板，说明影响范围与不可逆性；删除目录还需输入目录名二次确认。
