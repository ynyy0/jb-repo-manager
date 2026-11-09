# 越狱源管理台

管理 [ynyy0/ynyy0.github.io](https://github.com/ynyy0/ynyy0.github.io) 的在线控制台（纯静态，无后端）。

在线地址：<https://ynyy0.github.io/jb-repo-manager/>

## 功能

- **上传**：拖拽或选择 `.deb` / 图片，可指定现有目录或新建目录；支持批量
- **删除**：按文件删除；删除 `debs/` 下 deb 时自动把 `icons/{包名}.png` 一起加入待删除（可单独撤销）
- **重命名目录**：把该目录下全部文件一次性移动到新目录名
- **移动插件**：把任意文件移到另一个目录；可联动同目录同名图标
- **原子提交**：所有改动先进入「待提交变更」，逐项可撤销；点提交后通过 GitHub Git Data API 合并为一次 commit

提交后，源仓库的 `release.yml` 会刷新 `Packages*`，`deploy-pages.yml` 会自动重新部署站点。

## 首次使用

1. 打开 <https://ynyy0.github.io/jb-repo-manager/>
2. 生成一个 [fine-grained PAT](https://github.com/settings/personal-access-tokens)：
   - Resource owner: `ynyy0`
   - Repository access: 只选 `ynyy0.github.io`
   - Permissions: **Contents = Read and Write**（其余不用给）
3. 把 Token 粘进输入框，点「连接」。勾选「记住这台设备」会存到浏览器 localStorage，否则只存本次会话；随时可点「断开」清除。

Token 只在浏览器内存/本地存储中使用，随请求直接发往 `api.github.com`，不经过任何第三方服务，也不会写进本仓库。

## 限制与注意

- 单个文件建议 ≤ 50 MB（GitHub blob API 上限 100 MB）；大 deb 会跳过并提示
- 移出 `debs/` 的 deb 不会被 `dpkg-scanpackages -m debs` 收录，也就不会出现在 APT 索引里
- 重命名 `debs/` 会让整个源的插件索引失效，请谨慎
- 图标按 `icons/{包名}.png` 命名才会被索引自动引用
- 如果 GitHub 返回 409，说明期间有别的提交（例如 workflow 的自动索引提交），点「刷新仓库」后重新操作即可

## 技术说明

- 读取：`GET /git/ref/heads/main` → `GET /git/trees/{sha}?recursive=1`
- 写入：`POST /git/blobs`（base64）→ `POST /git/trees`（`base_tree` + 变更项，删除用 `sha: null`）→ `POST /git/commits` → `PATCH /git/refs/heads/main`
- 删除与移动用 `sha: null` 条目实现，不需要重新上传文件内容
- 网站本身通过 GitHub Pages 发布，加 `.nojekyll` 跳过 Jekyll
